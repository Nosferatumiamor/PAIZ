// Multi-turn conversational probe: replays a scripted back-and-forth against a model,
// once at baseline and once with a given skip-set active throughout, so the model's own
// (possibly bypassed) replies feed forward into later turns - a harsher coherence test
// than single-shot prompts, since drift compounds across turns.
#include "WeightStream/SystemMemoryGuard.h"
#include "WeightStream/VTMM.h"

#include "llama.h"
#include "llama-ext.h"
#include "llama-mmap.h"

#include <cstdio>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

namespace {

const char* kUserTurns[] = {
    "Salut ! Tu peux te presenter en une phrase ?",
    "D'accord, et tu peux m'aider a ecrire un petit poeme sur l'automne ?",
    "Merci, tu peux le raccourcir en 2 lignes ?",
    "Au fait, de quoi on parlait avant le poeme ?",
};

bool ws_read(void* u, std::uint64_t o, void* b, std::size_t l) {
    auto* vtmm = static_cast<ws::VTMM*>(u);
    if (o < vtmm->model_data_offset()) {
        return false;
    }
    return vtmm->read_at(o, b, l);
}

std::string generate_reply(llama_context* ctx,
                           llama_model* model_ptr,
                           const llama_vocab* vocab,
                           llama_sampler* smpl,
                           const std::string& prompt,
                           int n_predict) {
    llama_memory_clear(llama_get_memory(ctx), true);

    const int n_prompt = -llama_tokenize(vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), nullptr, 0, true, true);
    std::vector<llama_token> toks(static_cast<std::size_t>(n_prompt));
    llama_tokenize(vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), toks.data(),
                   static_cast<int32_t>(toks.size()), true, true);

    std::string text;
    llama_batch batch = llama_batch_get_one(toks.data(), static_cast<int32_t>(toks.size()));
    for (int n_pos = 0; n_pos + batch.n_tokens < n_prompt + n_predict;) {
        if (llama_decode(ctx, batch)) {
            text += "[decode failed]";
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
            text.append(piece, static_cast<std::size_t>(n));
        }
        llama_token next = id;
        batch = llama_batch_get_one(&next, 1);
    }
    return text;
}

void run_conversation(llama_context* ctx,
                      llama_model* model_ptr,
                      const llama_vocab* vocab,
                      llama_sampler* smpl,
                      const char* label,
                      int n_predict) {
    std::cerr << "\n=== " << label << " ===\n";

    std::vector<std::string> roles;
    std::vector<std::string> contents;

    const char* tmpl = llama_model_chat_template(model_ptr, nullptr);

    for (const char* user_turn : kUserTurns) {
        roles.push_back("user");
        contents.push_back(user_turn);

        std::vector<llama_chat_message> msgs;
        for (std::size_t i = 0; i < roles.size(); ++i) {
            msgs.push_back({roles[i].c_str(), contents[i].c_str()});
        }

        std::string prompt;
        if (tmpl) {
            std::vector<char> buf(16384);
            const int32_t need = llama_chat_apply_template(tmpl, msgs.data(), msgs.size(), true, buf.data(),
                                                            static_cast<int32_t>(buf.size()));
            if (need > 0 && need <= static_cast<int32_t>(buf.size())) {
                prompt.assign(buf.data(), static_cast<std::size_t>(need));
            }
        }
        if (prompt.empty()) {
            for (std::size_t i = 0; i < roles.size(); ++i) {
                prompt += roles[i] + ": " + contents[i] + "\n";
            }
        }

        const std::string reply = generate_reply(ctx, model_ptr, vocab, smpl, prompt, n_predict);

        std::cerr << "[user] " << user_turn << "\n[assistant] " << reply << "\n\n";

        roles.push_back("assistant");
        contents.push_back(reply);
    }
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: ws_chat_probe <model.gguf> [--skip-set L,L,...] [--n-predict N] [--ram-gib N] [--ngl N]\n";
        return 1;
    }
    std::string model_path = argv[1];
    std::string skip_set_arg;
    int n_predict = 120;
    std::size_t ram_gib = 12;
    int ngl = 99;
    for (int i = 2; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--skip-set" && i + 1 < argc) {
            skip_set_arg = argv[++i];
        } else if (arg == "--n-predict" && i + 1 < argc) {
            n_predict = std::stoi(argv[++i]);
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

    std::vector<int> skip_set;
    {
        std::size_t pos = 0;
        while (pos < skip_set_arg.size()) {
            const auto comma = skip_set_arg.find(',', pos);
            const std::string tok = skip_set_arg.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos);
            if (!tok.empty()) {
                skip_set.push_back(std::stoi(tok));
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

    const llama_vocab* vocab = llama_model_get_vocab(model_ptr);

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = 2048;
    cp.n_batch = 2048;
    llama_context* ctx = llama_init_from_model(model_ptr, cp);
    if (ctx == nullptr) {
        std::cerr << "llama_init_from_model failed\n";
        return 1;
    }

    llama_sampler* smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(smpl, llama_sampler_init_penalties(64, 1.3f, 0.0f, 0.0f));
    llama_sampler_chain_add(smpl, llama_sampler_init_greedy());

    run_conversation(ctx, model_ptr, vocab, smpl, "baseline (no skip)", n_predict);

    if (!skip_set.empty()) {
        for (int il : skip_set) {
            llama_set_skip_layer(ctx, static_cast<uint32_t>(il), true);
        }
        std::string label = "skip-set {";
        for (std::size_t i = 0; i < skip_set.size(); ++i) {
            if (i) label += ",";
            label += std::to_string(skip_set[i]);
        }
        label += "}";
        run_conversation(ctx, model_ptr, vocab, smpl, label.c_str(), n_predict);
        for (int il : skip_set) {
            llama_set_skip_layer(ctx, static_cast<uint32_t>(il), false);
        }
    }

    llama_sampler_free(smpl);
    llama_free(ctx);
    llama_model_free(model_ptr);
    return 0;
}
