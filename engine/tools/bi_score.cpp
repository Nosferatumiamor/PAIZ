// Block Influence score (ShortGPT/SLEB style): redundancy = cosine similarity
// between a layer's input and output, from a single prefill pass per prompt.
// No generation, no retraining - cheap pre-filter before touching skip_layers.
#include "WeightStream/SystemMemoryGuard.h"
#include "WeightStream/VTMM.h"

#include "llama.h"
#include "llama-ext.h"
#include "llama-mmap.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

namespace {

const char* kPrompts[] = {
    "Salut, comment ca va ?",
    "Quelle est la capitale de l'Australie ?",
    "Traduis en anglais: Le chat dort sur le canape.",
    "Ecris une fonction Python qui verifie si un nombre est premier.",
    "Un train part a 14h a 60 km/h, un autre part a 15h a 90 km/h dans la meme direction. A quelle heure le second rattrape-t-il le premier ?",
    "Ecris deux phrases sur un phare abandonne au bord de la mer.",
};

bool ws_read(void* u, std::uint64_t o, void* b, std::size_t l) {
    auto* vtmm = static_cast<ws::VTMM*>(u);
    if (o < vtmm->model_data_offset()) {
        return false;
    }
    return vtmm->read_at(o, b, l);
}

double cosine_sim(const float* a, const float* b, int n) {
    double dot = 0.0, na = 0.0, nb = 0.0;
    for (int i = 0; i < n; ++i) {
        dot += static_cast<double>(a[i]) * b[i];
        na += static_cast<double>(a[i]) * a[i];
        nb += static_cast<double>(b[i]) * b[i];
    }
    if (na <= 0.0 || nb <= 0.0) {
        return 0.0;
    }
    return dot / (std::sqrt(na) * std::sqrt(nb));
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: ws_bi_score <model.gguf> [--ram-gib N] [--ngl N]\n";
        return 1;
    }
    std::string model_path = argv[1];
    std::size_t ram_gib = 12;
    int ngl = 99;
    for (int i = 2; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--ram-gib" && i + 1 < argc) {
            ram_gib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (arg == "--ngl" && i + 1 < argc) {
            ngl = std::stoi(argv[++i]);
        }
    }

    if (!std::filesystem::exists(model_path)) {
        std::cerr << "Model not found: " << model_path << '\n';
        return 1;
    }

    ws::Config cfg;
    cfg.verbose = false;
    cfg.cuda_vram = false;
    cfg.debug_ssd_invariant = false;
    cfg.background_scheduler = false;
    cfg.coalesce_max_bytes = 0;
    cfg.ram_capacity = ram_gib * 1024ULL * 1024 * 1024;
    cfg.read_at_page_cache = true;
    cfg.system_memory_guard = true;
    cfg.system_memory_guard_mode = ws::SystemMemoryGuardMode::Auto;
    cfg.load_priority_ngl = ngl;
    ws::SystemMemoryGuard::enter_burst_phase(cfg);

    ggml_backend_load_all();

    ws::VTMM vtmm(cfg);
    if (!vtmm.load_model(model_path)) {
        std::cerr << "VTMM load_model failed: " << vtmm.last_error() << '\n';
        return 1;
    }
    if (!vtmm.warm_priority_pages()) {
        std::cerr << "warm_priority_pages failed: " << vtmm.last_error() << '\n';
        return 1;
    }

    llama_file_set_byte_reader(ws_read, &vtmm);
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = ngl;
    mp.use_mmap = false;
    llama_model* model_ptr = llama_model_load_from_file(model_path.c_str(), mp);
    llama_file_clear_byte_reader();
    if (model_ptr == nullptr) {
        std::cerr << "llama_model_load_from_file failed\n";
        return 1;
    }
    ws::SystemMemoryGuard::enter_steady_phase(vtmm.mutable_config());

    const int n_layer = llama_model_n_layer(model_ptr);
    const int n_embd = llama_model_n_embd(model_ptr);
    const llama_vocab* vocab = llama_model_get_vocab(model_ptr);

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = 512;
    cp.n_batch = 512;
    cp.embeddings = true;
    llama_context* ctx = llama_init_from_model(model_ptr, cp);
    if (ctx == nullptr) {
        std::cerr << "llama_init_from_model failed\n";
        return 1;
    }
    for (int il = 0; il < n_layer; ++il) {
        llama_set_embeddings_layer_inp(ctx, static_cast<uint32_t>(il), true);
    }

    // sum of per-token cosine(input[il], input[il+1]) across all prompts/tokens
    std::vector<double> sim_sum(n_layer - 1, 0.0);
    std::vector<int> sim_count(n_layer - 1, 0);

    for (const char* prompt : kPrompts) {
        const int n_tok = -llama_tokenize(vocab, prompt, static_cast<int32_t>(std::strlen(prompt)), nullptr, 0, true, true);
        std::vector<llama_token> toks(static_cast<std::size_t>(n_tok));
        llama_tokenize(vocab, prompt, static_cast<int32_t>(std::strlen(prompt)), toks.data(),
                       static_cast<int32_t>(toks.size()), true, true);

        llama_memory_clear(llama_get_memory(ctx), true);
        llama_batch batch = llama_batch_get_one(toks.data(), static_cast<int32_t>(toks.size()));
        if (llama_decode(ctx, batch)) {
            std::cerr << "decode failed for prompt: " << prompt << '\n';
            continue;
        }

        std::vector<float*> layer_inp(n_layer, nullptr);
        for (int il = 0; il < n_layer; ++il) {
            layer_inp[il] = llama_get_embeddings_layer_inp(ctx, static_cast<uint32_t>(il));
        }
        for (int il = 0; il < n_layer - 1; ++il) {
            if (!layer_inp[il] || !layer_inp[il + 1]) {
                continue;
            }
            for (int t = 0; t < n_tok; ++t) {
                const double sim = cosine_sim(layer_inp[il] + t * n_embd, layer_inp[il + 1] + t * n_embd, n_embd);
                sim_sum[il] += sim;
                sim_count[il] += 1;
            }
        }
    }

    struct Row {
        int layer;
        double bi;
    };
    std::vector<Row> rows;
    for (int il = 0; il < n_layer - 1; ++il) {
        const double avg_sim = sim_count[il] > 0 ? sim_sum[il] / sim_count[il] : 0.0;
        rows.push_back({il, 1.0 - avg_sim});
    }
    std::sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) { return a.bi < b.bi; });

    std::printf("layer,block_influence,note\n");
    for (const auto& r : rows) {
        std::printf("%d,%.4f,%s\n", r.layer, r.bi, r.bi < 0.05 ? "highly redundant candidate" : "");
    }
    std::cerr << "\n(layer " << (n_layer - 1) << " = last layer, not scored - literature flags it as always critical)\n";

    llama_free(ctx);
    llama_model_free(model_ptr);
    return 0;
}
