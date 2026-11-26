// Calibrates the diagonal part of a LinearPatch-style correction for one skipped layer:
// d_k = mean_token L1(activation_k after the layer) / mean_token L1(activation_k before it),
// computed from a real (non-skipped) forward pass. Written to a raw float32 file, loaded
// back via llama_set_skip_scale(). No Hadamard rotation (skipped - needs a non-power-of-2
// factorization for this model's embedding size, out of scope for this pass).
#include "WeightStream/SystemMemoryGuard.h"
#include "WeightStream/VTMM.h"

#include "llama.h"
#include "llama-ext.h"
#include "llama-mmap.h"

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

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: ws_fit_patch <model.gguf> --layer N --out patch.bin [--ram-gib N] [--ngl N]\n";
        return 1;
    }
    std::string model_path = argv[1];
    int target_layer = -1;
    std::string out_path;
    std::size_t ram_gib = 12;
    int ngl = 99;
    for (int i = 2; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--layer" && i + 1 < argc) {
            target_layer = std::stoi(argv[++i]);
        } else if (arg == "--out" && i + 1 < argc) {
            out_path = argv[++i];
        } else if (arg == "--ram-gib" && i + 1 < argc) {
            ram_gib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (arg == "--ngl" && i + 1 < argc) {
            ngl = std::stoi(argv[++i]);
        }
    }
    if (target_layer < 0 || out_path.empty()) {
        std::cerr << "--layer N and --out FILE are required\n";
        return 1;
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
    if (target_layer >= n_layer - 1) {
        std::cerr << "--layer must be < n_layer-1 (" << (n_layer - 1) << "); the output side needs layer+1's input\n";
        return 1;
    }
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
    llama_set_embeddings_layer_inp(ctx, static_cast<uint32_t>(target_layer), true);
    llama_set_embeddings_layer_inp(ctx, static_cast<uint32_t>(target_layer + 1), true);

    std::vector<double> sum_in(n_embd, 0.0);
    std::vector<double> sum_out(n_embd, 0.0);
    long long n_tokens_total = 0;

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

        const float* in_buf = llama_get_embeddings_layer_inp(ctx, static_cast<uint32_t>(target_layer));
        const float* out_buf = llama_get_embeddings_layer_inp(ctx, static_cast<uint32_t>(target_layer + 1));
        if (!in_buf || !out_buf) {
            std::cerr << "missing layer_inp buffer for prompt: " << prompt << '\n';
            continue;
        }
        for (int t = 0; t < n_tok; ++t) {
            for (int k = 0; k < n_embd; ++k) {
                sum_in[k] += std::fabs(in_buf[t * n_embd + k]);
                sum_out[k] += std::fabs(out_buf[t * n_embd + k]);
            }
        }
        n_tokens_total += n_tok;
    }

    std::vector<float> scale(n_embd, 1.0f);
    for (int k = 0; k < n_embd; ++k) {
        scale[k] = sum_in[k] > 1e-8 ? static_cast<float>(sum_out[k] / sum_in[k]) : 1.0f;
    }

    FILE* f = std::fopen(out_path.c_str(), "wb");
    if (!f) {
        std::perror("fopen out");
        return 1;
    }
    std::fwrite(scale.data(), sizeof(float), scale.size(), f);
    std::fclose(f);

    std::cerr << "[ws_fit_patch] layer " << target_layer << " -> " << (target_layer + 1)
              << ", " << n_tokens_total << " calibration tokens, n_embd=" << n_embd
              << ", written to " << out_path << '\n';

    llama_free(ctx);
    llama_model_free(model_ptr);
    return 0;
}
