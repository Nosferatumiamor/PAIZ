// SLEB-style greedy layer selection: at each step, try adding each remaining candidate
// layer to the skip-set, measure average next-token NLL (teacher-forced, single forward
// pass per calibration prompt - no generation), and keep whichever addition hurts the
// least. Re-evaluates on the already-reduced network each step, so compounding errors
// between chosen layers are accounted for (unlike a static one-shot BI ranking).
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
#include <set>
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

double token_nll(const float* logits, int n_vocab, llama_token target) {
    float max_logit = logits[0];
    for (int i = 1; i < n_vocab; ++i) {
        max_logit = std::max(max_logit, logits[i]);
    }
    double sum_exp = 0.0;
    for (int i = 0; i < n_vocab; ++i) {
        sum_exp += std::exp(static_cast<double>(logits[i]) - max_logit);
    }
    const double log_sum_exp = std::log(sum_exp) + max_logit;
    return log_sum_exp - logits[target];
}

// Average next-token NLL over the fixed calibration prompts, teacher-forced (no sampling).
// Lower is closer to the intact network's behavior.
double calibration_nll(llama_context* ctx, const llama_vocab* vocab, int n_vocab) {
    double sum_nll = 0.0;
    long long count = 0;

    for (const char* prompt : kPrompts) {
        const int n_tok = -llama_tokenize(vocab, prompt, static_cast<int32_t>(std::strlen(prompt)), nullptr, 0, true, true);
        if (n_tok < 2) {
            continue;
        }
        std::vector<llama_token> toks(static_cast<std::size_t>(n_tok));
        llama_tokenize(vocab, prompt, static_cast<int32_t>(std::strlen(prompt)), toks.data(),
                       static_cast<int32_t>(toks.size()), true, true);

        llama_memory_clear(llama_get_memory(ctx), true);

        llama_batch batch = llama_batch_init(n_tok, 0, 1);
        for (int i = 0; i < n_tok; ++i) {
            batch.token[i] = toks[static_cast<std::size_t>(i)];
            batch.pos[i] = i;
            batch.n_seq_id[i] = 1;
            batch.seq_id[i][0] = 0;
            batch.logits[i] = 1;
        }
        batch.n_tokens = n_tok;

        if (llama_decode(ctx, batch) == 0) {
            for (int i = 0; i < n_tok - 1; ++i) {
                const float* logits = llama_get_logits_ith(ctx, i);
                if (!logits) {
                    continue;
                }
                sum_nll += token_nll(logits, n_vocab, toks[static_cast<std::size_t>(i + 1)]);
                ++count;
            }
        }
        llama_batch_free(batch);
    }

    return count > 0 ? sum_nll / static_cast<double>(count) : 1e9;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: ws_greedy_prune <model.gguf> [--target N] [--protect L,L,...] [--ram-gib N] [--ngl N]\n";
        return 1;
    }
    std::string model_path = argv[1];
    int target = 10;
    std::string protect_arg = "0,1,2,3,4,5,6,7,8,9,10,11,12,46,47";
    std::size_t ram_gib = 12;
    int ngl = 99;
    for (int i = 2; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--target" && i + 1 < argc) {
            target = std::stoi(argv[++i]);
        } else if (arg == "--protect" && i + 1 < argc) {
            protect_arg = argv[++i];
        } else if (arg == "--ram-gib" && i + 1 < argc) {
            ram_gib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (arg == "--ngl" && i + 1 < argc) {
            ngl = std::stoi(argv[++i]);
        }
    }
    if (!std::filesystem::exists(model_path)) {
        std::cerr << "Model not found: " << model_path << '\n';
        return 1;
    }

    std::set<int> protect;
    {
        std::size_t pos = 0;
        while (pos < protect_arg.size()) {
            const auto comma = protect_arg.find(',', pos);
            const std::string tok = protect_arg.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos);
            if (!tok.empty()) {
                protect.insert(std::stoi(tok));
            }
            if (comma == std::string::npos) {
                break;
            }
            pos = comma + 1;
        }
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
    const llama_vocab* vocab = llama_model_get_vocab(model_ptr);
    const int n_vocab = llama_vocab_n_tokens(vocab);

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = 512;
    cp.n_batch = 512;
    llama_context* ctx = llama_init_from_model(model_ptr, cp);
    if (ctx == nullptr) {
        std::cerr << "llama_init_from_model failed\n";
        return 1;
    }

    const double baseline_nll = calibration_nll(ctx, vocab, n_vocab);
    std::cerr << "[ws_greedy_prune] baseline avg NLL = " << baseline_nll << '\n';

    std::vector<int> candidates;
    for (int il = 0; il < n_layer; ++il) {
        if (!protect.count(il)) {
            candidates.push_back(il);
        }
    }
    target = std::min(target, static_cast<int>(candidates.size()));
    std::cerr << "[ws_greedy_prune] " << candidates.size() << " candidate layers, target=" << target << '\n';

    std::vector<int> removed;
    for (int step = 0; step < target; ++step) {
        int best_layer = -1;
        double best_nll = 1e18;

        for (int c : candidates) {
            if (std::find(removed.begin(), removed.end(), c) != removed.end()) {
                continue;
            }
            for (int l : removed) {
                llama_set_skip_layer(ctx, static_cast<uint32_t>(l), true);
            }
            llama_set_skip_layer(ctx, static_cast<uint32_t>(c), true);

            const double nll = calibration_nll(ctx, vocab, n_vocab);

            llama_set_skip_layer(ctx, static_cast<uint32_t>(c), false);
            for (int l : removed) {
                llama_set_skip_layer(ctx, static_cast<uint32_t>(l), false);
            }

            if (nll < best_nll) {
                best_nll = nll;
                best_layer = c;
            }
        }

        removed.push_back(best_layer);
        std::cerr << "[ws_greedy_prune] step " << (step + 1) << "/" << target << ": +layer " << best_layer
                  << "  avg NLL = " << best_nll << " (baseline " << baseline_nll << ")\n";
    }

    std::sort(removed.begin(), removed.end());
    std::string list;
    for (std::size_t i = 0; i < removed.size(); ++i) {
        if (i) {
            list += ",";
        }
        list += std::to_string(removed[i]);
    }
    std::cout << list << '\n';
    std::cerr << "[ws_greedy_prune] final skip-set: " << list << "\n"
              << "[ws_greedy_prune] feed this into: ws_ablate <model> --skip-set \"" << list << "\"\n";

    llama_free(ctx);
    llama_model_free(model_ptr);
    return 0;
}
