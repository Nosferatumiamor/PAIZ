#include "WeightStream/RuntimeProfiler.h"
#include "WeightStream/SystemMemoryGuard.h"
#include "WeightStream/VTMM.h"

#include "llama.h"
#include "llama-ext.h"
#include "llama-mmap.h"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

namespace {

struct PromptCase {
    const char* category;
    const char* prompt;
};

// Covers the six prompt classes from Docs/ABLATION_PROTOCOL.md.
const PromptCase kPrompts[] = {
    {"greeting", "Salut, comment ca va ?"},
    {"factual", "Quelle est la capitale de l'Australie ?"},
    {"translation", "Traduis en anglais: Le chat dort sur le canape."},
    {"code", "Ecris une fonction Python qui verifie si un nombre est premier."},
    {"reasoning", "Un train part a 14h a 60 km/h, un autre part a 15h a 90 km/h dans la meme direction. A quelle heure le second rattrape-t-il le premier ?"},
    {"creative", "Ecris deux phrases sur un phare abandonne au bord de la mer."},
};

bool ws_read(void* u, std::uint64_t o, void* b, std::size_t l) {
    auto* vtmm = static_cast<ws::VTMM*>(u);
    if (o < vtmm->model_data_offset()) {
        return false;
    }
    return vtmm->read_at(o, b, l);
}

std::string csv_escape(const std::string& field) {
    std::string out = "\"";
    for (char c : field) {
        if (c == '"') {
            out += "\"\"";
        } else if (c == '\n' || c == '\r') {
            out += "\\n";
        } else {
            out += c;
        }
    }
    out += "\"";
    return out;
}

struct GenResult {
    std::string text;
    double seconds = 0.0;
    int n_decode = 0;
    bool failed = false;
};

GenResult generate(llama_context* ctx,
                   llama_model* model_ptr,
                   const llama_vocab* vocab,
                   llama_sampler* smpl,
                   const std::string& user_prompt,
                   int n_predict) {
    llama_memory_clear(llama_get_memory(ctx), true);

    const char* tmpl = llama_model_chat_template(model_ptr, nullptr);
    std::string prompt = user_prompt;
    if (tmpl) {
        llama_chat_message msg{"user", user_prompt.c_str()};
        std::vector<char> buf(8192);
        const int32_t need = llama_chat_apply_template(tmpl, &msg, 1, true, buf.data(),
                                                        static_cast<int32_t>(buf.size()));
        if (need > 0 && need <= static_cast<int32_t>(buf.size())) {
            prompt.assign(buf.data(), static_cast<std::size_t>(need));
        }
    }

    const int n_prompt =
        -llama_tokenize(vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), nullptr, 0, true, true);
    std::vector<llama_token> toks(static_cast<std::size_t>(n_prompt));
    llama_tokenize(vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), toks.data(),
                  static_cast<int32_t>(toks.size()), true, true);

    GenResult result;
    llama_batch batch = llama_batch_get_one(toks.data(), static_cast<int32_t>(toks.size()));
    const auto t0 = ggml_time_us();
    for (int n_pos = 0; n_pos + batch.n_tokens < n_prompt + n_predict;) {
        if (llama_decode(ctx, batch)) {
            result.failed = true;
            break;
        }
        n_pos += batch.n_tokens;
        const llama_token id = llama_sampler_sample(smpl, ctx, -1);
        if (llama_vocab_is_eog(vocab, id)) {
            break;
        }
        char piece[256];
        const int n = llama_token_to_piece(vocab, id, piece, sizeof(piece), 0, true);
        if (n > 0) {
            result.text.append(piece, static_cast<std::size_t>(n));
        }
        llama_token next = id;
        batch = llama_batch_get_one(&next, 1);
        ++result.n_decode;
    }
    result.seconds = (ggml_time_us() - t0) / 1e6;
    return result;
}

void print_usage() {
    std::cerr << "Usage: ws_ablate <model.gguf> [options]\n";
    std::cerr << "Sweeps single-layer identity bypass across a fixed prompt set.\n\n";
    std::cerr << "Options:\n";
    std::cerr << "  --layers A:B     Layer range to sweep [A,B) (default: all layers)\n";
    std::cerr << "  --stride N       Sweep every Nth layer (default: 1)\n";
    std::cerr << "  --n-predict N    Tokens to generate per run (default: 160)\n";
    std::cerr << "  --ram-gib N      VTMM host cache budget (default: 12)\n";
    std::cerr << "  --ngl N          GPU layers (default: 99 = all)\n";
    std::cerr << "  --csv FILE       Write CSV to FILE instead of stdout\n";
    std::cerr << "  --patch-file F   Channel-wise scale from ws_fit_patch (forces sweep to --patch-layer only)\n";
    std::cerr << "  --patch-layer N  Layer the patch file was fit for\n";
    std::cerr << "  --skip-set L,L.. Bypass all these layers at once (single combined run, overrides --layers)\n";
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        print_usage();
        return 1;
    }

    std::string model_path = argv[1];
    int layer_start = -1;
    int layer_end = -1;
    int stride = 1;
    int n_predict = 160;
    std::size_t ram_gib = 12;
    int ngl = 99;
    std::string csv_path;
    std::string patch_path;
    int patch_layer = -1;
    std::vector<int> skip_set;

    for (int i = 2; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--skip-set" && i + 1 < argc) {
            std::string list = argv[++i];
            std::size_t pos = 0;
            while (pos < list.size()) {
                const auto comma = list.find(',', pos);
                const std::string tok = list.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos);
                if (!tok.empty()) {
                    skip_set.push_back(std::stoi(tok));
                }
                if (comma == std::string::npos) {
                    break;
                }
                pos = comma + 1;
            }
        } else if (arg == "--patch-file" && i + 1 < argc) {
            patch_path = argv[++i];
        } else if (arg == "--patch-layer" && i + 1 < argc) {
            patch_layer = std::stoi(argv[++i]);
        } else if (arg == "--layers" && i + 1 < argc) {
            const std::string range = argv[++i];
            const auto sep = range.find(':');
            if (sep == std::string::npos) {
                std::cerr << "--layers expects A:B\n";
                return 1;
            }
            layer_start = std::stoi(range.substr(0, sep));
            layer_end = std::stoi(range.substr(sep + 1));
        } else if (arg == "--stride" && i + 1 < argc) {
            stride = std::stoi(argv[++i]);
        } else if (arg == "--n-predict" && i + 1 < argc) {
            n_predict = std::stoi(argv[++i]);
        } else if (arg == "--ram-gib" && i + 1 < argc) {
            ram_gib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (arg == "--ngl" && i + 1 < argc) {
            ngl = std::stoi(argv[++i]);
        } else if (arg == "--csv" && i + 1 < argc) {
            csv_path = argv[++i];
        } else if (arg == "--help") {
            print_usage();
            return 0;
        } else {
            std::cerr << "Unknown option: " << arg << '\n';
            print_usage();
            return 1;
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

    std::cerr << "[ws_ablate] warming priority pages...\n";
    if (!vtmm.warm_priority_pages()) {
        std::cerr << "warm_priority_pages failed: " << vtmm.last_error() << '\n';
        return 1;
    }

    llama_file_set_byte_reader(ws_read, &vtmm);

    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = ngl;
    mp.use_mmap = false;

    std::cerr << "[ws_ablate] loading model...\n";
    llama_model* model_ptr = llama_model_load_from_file(model_path.c_str(), mp);
    llama_file_clear_byte_reader();
    if (model_ptr == nullptr) {
        std::cerr << "llama_model_load_from_file failed\n";
        return 1;
    }

    ws::SystemMemoryGuard::enter_steady_phase(vtmm.mutable_config());

    const int n_layer = llama_model_n_layer(model_ptr);
    const int n_embd = llama_model_n_embd(model_ptr);

    std::vector<float> patch_scale;
    if (!patch_path.empty()) {
        if (patch_layer < 0) {
            std::cerr << "--patch-file requires --patch-layer N\n";
            return 1;
        }
        FILE* pf = std::fopen(patch_path.c_str(), "rb");
        if (!pf) {
            std::perror("fopen patch-file");
            return 1;
        }
        patch_scale.resize(static_cast<std::size_t>(n_embd));
        const std::size_t got = std::fread(patch_scale.data(), sizeof(float), patch_scale.size(), pf);
        std::fclose(pf);
        if (got != patch_scale.size()) {
            std::cerr << "patch-file size mismatch: expected " << n_embd << " floats, got " << got << '\n';
            return 1;
        }
        // a single-layer patch comparison: restrict the sweep to that layer only
        layer_start = patch_layer;
        layer_end = patch_layer + 1;
        stride = 1;
    }

    if (layer_start < 0) {
        layer_start = 0;
    }
    if (layer_end < 0 || layer_end > n_layer) {
        layer_end = n_layer;
    }

    const llama_vocab* vocab = llama_model_get_vocab(model_ptr);

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = 512;
    cp.n_batch = 512;
    cp.no_perf = false;
    llama_context* ctx = llama_init_from_model(model_ptr, cp);
    if (ctx == nullptr) {
        std::cerr << "llama_init_from_model failed\n";
        return 1;
    }

    llama_sampler* smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(smpl, llama_sampler_init_penalties(64, 1.3f, 0.0f, 0.0f));
    llama_sampler_chain_add(smpl, llama_sampler_init_greedy());

    FILE* csv = stdout;
    FILE* csv_file = nullptr;
    if (!csv_path.empty()) {
        csv_file = std::fopen(csv_path.c_str(), "w");
        if (!csv_file) {
            std::perror("fopen csv");
            return 1;
        }
        csv = csv_file;
    }
    std::fprintf(csv, "category,prompt,layer_bypassed,variant,tokens_per_sec,seconds,n_tokens,failed,text\n");

    auto emit_row = [&](const PromptCase& pc, int layer, const char* variant, const GenResult& r) {
        const double tok_s = r.seconds > 0.0 ? (r.n_decode / r.seconds) : 0.0;
        std::fprintf(csv, "%s,%s,%d,%s,%.3f,%.3f,%d,%s,%s\n",
                     pc.category,
                     csv_escape(pc.prompt).c_str(),
                     layer,
                     variant,
                     tok_s,
                     r.seconds,
                     r.n_decode,
                     r.failed ? "yes" : "no",
                     csv_escape(r.text).c_str());
        std::fflush(csv);
    };

    std::cerr << "[ws_ablate] sweeping layers [" << layer_start << ", " << layer_end << ") stride " << stride
              << " over " << (sizeof(kPrompts) / sizeof(kPrompts[0])) << " prompts\n";
    if (!patch_scale.empty()) {
        std::cerr << "[ws_ablate] patch loaded for layer " << patch_layer << " from " << patch_path << '\n';
    }

    if (!skip_set.empty()) {
        std::cerr << "[ws_ablate] combined skip-set (" << skip_set.size() << " layers): ";
        for (int il : skip_set) {
            std::cerr << il << ' ';
        }
        std::cerr << '\n';
    }

    for (const auto& pc : kPrompts) {
        std::cerr << "[ws_ablate] " << pc.category << " -- baseline\n";
        const auto baseline = generate(ctx, model_ptr, vocab, smpl, pc.prompt, n_predict);
        emit_row(pc, -1, "baseline", baseline);

        if (!skip_set.empty()) {
            for (int il : skip_set) {
                llama_set_skip_layer(ctx, static_cast<uint32_t>(il), true);
            }
            std::cerr << "[ws_ablate] " << pc.category << " -- combined skip-set\n";
            const auto result = generate(ctx, model_ptr, vocab, smpl, pc.prompt, n_predict);
            emit_row(pc, static_cast<int>(skip_set.size()), "combined_skip_set", result);
            for (int il : skip_set) {
                llama_set_skip_layer(ctx, static_cast<uint32_t>(il), false);
            }
            continue;
        }

        for (int il = layer_start; il < layer_end; il += stride) {
            std::cerr << "[ws_ablate] " << pc.category << " -- layer " << il << " (raw skip)\n";
            llama_set_skip_layer(ctx, static_cast<uint32_t>(il), true);
            const auto result = generate(ctx, model_ptr, vocab, smpl, pc.prompt, n_predict);
            emit_row(pc, il, "raw_skip", result);

            if (!patch_scale.empty() && il == patch_layer) {
                std::cerr << "[ws_ablate] " << pc.category << " -- layer " << il << " (patched)\n";
                llama_set_skip_scale(ctx, static_cast<uint32_t>(il), patch_scale.data(),
                                     static_cast<uint32_t>(patch_scale.size()));
                const auto patched = generate(ctx, model_ptr, vocab, smpl, pc.prompt, n_predict);
                emit_row(pc, il, "patched", patched);
                llama_set_skip_scale(ctx, static_cast<uint32_t>(il), nullptr, 0);
            }

            llama_set_skip_layer(ctx, static_cast<uint32_t>(il), false);
        }
    }

    if (csv_file) {
        std::fclose(csv_file);
        std::cerr << "CSV written to " << csv_path << '\n';
    }

    llama_sampler_free(smpl);
    llama_free(ctx);
    llama_model_free(model_ptr);
    return 0;
}
