// Replays a sequence of chat turns against a MoE model served by WeightStream and measures speed
// under three preloading strategies:
//   none   - RAM expert cache filled by misses only
//   global - the most used experts of every domain preloaded at startup
//   domain - global at startup, then each turn's domain is detected from its prompt and its
//            profile preloaded in the background (the sheets learn from each turn if --learn)
#include "WeightStream/DomainRouter.h"
#include "WeightStream/ExpertSheets.h"
#include "WeightStream/ExpertStore.h"
#include "WeightStream/GGUFReader.h"

#include "ggml-cpu.h"
#include "ggml.h"
#include "llama-ext.h"
#include "llama.h"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

namespace {

struct Turn {
    std::string domain;
    std::string text;
};

struct Session {
    ws::ExpertStore store;
    std::vector<ws::ExpertStore::Request> requests;
    ws::DomainRouter* router = nullptr;
    bool in_prefill = false;
};

bool serve_experts(void* user, llama_moe_expert_read* reads, size_t n_reads) {
    auto* s = static_cast<Session*>(user);
    s->requests.resize(n_reads);
    for (size_t i = 0; i < n_reads; ++i) {
        s->requests[i] = {reads[i].tensor->name, reads[i].expert, static_cast<std::size_t>(reads[i].tensor->nb[2]), nullptr};
    }
    if (!s->store.fetch(s->requests.data(), n_reads)) {
        return false;
    }
    for (size_t i = 0; i < n_reads; ++i) {
        reads[i].data = s->requests[i].data;
    }
    return true;
}

void observe(void* user, int32_t il, const int32_t* ids, size_t n_ids) {
    auto* s = static_cast<Session*>(user);
    if (s->router != nullptr) {
        s->router->observe(il, ids, n_ids, s->in_prefill);
    }
}

void log_quiet(ggml_log_level level, const char* text, void*) {
    if (level >= GGML_LOG_LEVEL_WARN || std::strstr(text, "llama_moe_cache:") != nullptr) {
        std::fputs(text, stderr);
    }
}

void print_usage() {
    std::cerr << "Usage: ws_moe_session -m model.gguf --prompts turns.tsv --sheets sheets.wssheets [--mode none|global|domain]\n"
                 "                      [-n N] [--cache-mib N] [--ws-ram-mib N] [--ubatch N] [--learn] [--save-sheets path]\n";
}

}  // namespace

int main(int argc, char** argv) {
    std::string model_path, prompts_path, sheets_path, save_path, mode = "domain";
    int n_predict = 64;
    int n_ubatch = 32;
    std::size_t cache_mib = 7500;
    std::size_t ws_ram_mib = 12288;
    bool learn = false;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : std::string(); };
        if (arg == "-m") model_path = next();
        else if (arg == "--prompts") prompts_path = next();
        else if (arg == "--sheets") sheets_path = next();
        else if (arg == "--save-sheets") save_path = next();
        else if (arg == "--mode") mode = next();
        else if (arg == "-n") n_predict = std::stoi(next());
        else if (arg == "--ubatch") n_ubatch = std::stoi(next());
        else if (arg == "--cache-mib") cache_mib = std::stoull(next());
        else if (arg == "--ws-ram-mib") ws_ram_mib = std::stoull(next());
        else if (arg == "--learn") learn = true;
        else { print_usage(); return 1; }
    }
    if (model_path.empty() || prompts_path.empty() || (mode != "none" && mode != "global" && mode != "domain") ||
        (mode != "none" && sheets_path.empty())) {
        print_usage();
        return 1;
    }

    std::vector<Turn> turns;
    {
        std::ifstream in(prompts_path, std::ios::binary);
        std::string line;
        while (std::getline(in, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            const auto tab = line.find('\t');
            if (tab == std::string::npos || line[0] == '#') continue;
            turns.push_back({line.substr(0, tab), line.substr(tab + 1)});
        }
    }

    llama_log_set(log_quiet, nullptr);
    ggml_backend_load_all();

    Session session;
    if (!session.store.open(model_path, ws_ram_mib * 1024 * 1024)) {
        std::cerr << "ExpertStore: " << session.store.last_error() << '\n';
        return 1;
    }
    llama_moe_set_expert_source(serve_experts, &session);

    ws::ExpertSheets sheets;
    if (mode != "none" && !sheets.load(sheets_path)) {
        std::cerr << "cannot load sheets " << sheets_path << '\n';
        return 1;
    }

    llama_model_tensor_buft_override overrides[] = {
        {"\\.ffn_(up|down|gate|gate_up)_(ch|)exps", ggml_backend_cpu_buffer_type()},
        {nullptr, nullptr},
    };
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = 999;
    mp.tensor_buft_overrides = overrides;
    llama_model* model = llama_model_load_from_file(model_path.c_str(), mp);
    if (!model) {
        std::cerr << "model load failed\n";
        return 1;
    }

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = 4096;
    cp.n_batch = 512;
    cp.n_ubatch = static_cast<uint32_t>(n_ubatch);
    cp.moe_cache_size = cache_mib * 1024 * 1024;
    llama_context* ctx = llama_init_from_model(model, cp);
    if (!ctx) {
        std::cerr << "context init failed\n";
        return 1;
    }

    // each expert is one key per gate/up/down tensor, and the pinned profile may take 75% of the slots
    const std::size_t preload_experts = session.store.slot_count() * 3 / 4 / 3;

    // the GPU expert cache keeps roughly the top of the ranking; RAM is the tier below it
    std::size_t skip_top = 0;
    {
        ws::GGUFReader reader(model_path);
        std::uint64_t exps_bytes = 0, n_slices = 0;
        for (const auto& t : reader.tensors()) {
            if (t.name.find("_exps") != std::string::npos && t.dimensions.size() == 3) {
                exps_bytes += t.size;
                n_slices += t.dimensions[2];
            }
        }
        const double expert_bytes = n_slices ? 3.0 * static_cast<double>(exps_bytes) / static_cast<double>(n_slices) : 0.0;
        if (expert_bytes > 0) {
            skip_top = static_cast<std::size_t>(static_cast<double>(cache_mib) * 1024.0 * 1024.0 / expert_bytes);
        }
    }
    ws::DomainRouter router(sheets, session.store, preload_experts, skip_top);
    std::fprintf(stderr, "[startup] RAM profile = ranks %zu..%zu (the GPU cache is expected to hold the first %zu)\n", skip_top,
                 skip_top + preload_experts, skip_top);
    if (mode != "none") {
        session.router = &router;
        llama_moe_set_expert_observer(observe, &session);
        const auto t0 = std::chrono::steady_clock::now();
        router.preload(-1);
        for (auto p = session.store.profile_progress(); p.loading; p = session.store.profile_progress()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        const auto p = session.store.profile_progress();
        std::fprintf(stderr, "[startup] global profile: %zu experts (%zu slices) preloaded in %.1f s\n", preload_experts, p.resident,
                     std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());
    }

    const llama_vocab* vocab = llama_model_get_vocab(model);
    const char* tmpl = llama_model_chat_template(model, nullptr);
    llama_sampler* smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(smpl, llama_sampler_init_greedy());

    double total_pp_s = 0, total_tg_s = 0;
    long long total_pp = 0, total_tg = 0;
    for (std::size_t ti = 0; ti < turns.size(); ++ti) {
        const Turn& turn = turns[ti];
        std::string formatted = turn.text;
        if (tmpl) {
            llama_chat_message msg{"user", turn.text.c_str()};
            std::vector<char> buf(turn.text.size() * 2 + 4096);
            const int32_t need = llama_chat_apply_template(tmpl, &msg, 1, true, buf.data(), static_cast<int32_t>(buf.size()));
            if (need > 0 && need <= static_cast<int32_t>(buf.size())) formatted.assign(buf.data(), static_cast<std::size_t>(need));
        }
        const int n_prompt = -llama_tokenize(vocab, formatted.c_str(), static_cast<int32_t>(formatted.size()), nullptr, 0, true, true);
        std::vector<llama_token> toks(static_cast<std::size_t>(n_prompt));
        llama_tokenize(vocab, formatted.c_str(), static_cast<int32_t>(formatted.size()), toks.data(), n_prompt, true, true);

        llama_memory_clear(llama_get_memory(ctx), true);
        router.begin_turn();
        session.in_prefill = true;
        const auto t0 = std::chrono::steady_clock::now();
        if (llama_decode(ctx, llama_batch_get_one(toks.data(), n_prompt))) {
            std::cerr << "prompt decode failed\n";
            return 1;
        }
        const double pp_s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        session.in_prefill = false;

        std::string detected = "-";
        if (mode == "domain") {
            const auto det = router.end_prefill();
            if (det.domain >= 0) {
                detected = sheets.domains()[static_cast<std::size_t>(det.domain)] + (det.switched ? "*" : "") +
                           " (" + std::to_string(det.similarity).substr(0, 4) + ")";
            }
        }

        int n_gen = 0;
        const auto t1 = std::chrono::steady_clock::now();
        for (; n_gen < n_predict; ++n_gen) {
            llama_token id = llama_sampler_sample(smpl, ctx, -1);
            if (llama_vocab_is_eog(vocab, id)) break;
            if (llama_decode(ctx, llama_batch_get_one(&id, 1))) break;
        }
        const double tg_s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t1).count();
        router.end_turn(learn && mode == "domain");

        const auto prog = session.store.profile_progress();
        std::fprintf(stderr, "[%2zu] %-10s -> %-22s prompt %3d tok %5.2f tok/s | gen %3d tok %5.2f tok/s | profile %3.0f%%\n", ti + 1,
                     turn.domain.c_str(), detected.c_str(), n_prompt, n_prompt / pp_s, n_gen, n_gen > 0 ? n_gen / tg_s : 0.0,
                     prog.target ? 100.0 * static_cast<double>(prog.resident) / static_cast<double>(prog.target) : 0.0);
        total_pp_s += pp_s; total_tg_s += tg_s; total_pp += n_prompt; total_tg += n_gen;
    }

    const auto st = session.store.stats();
    std::printf("\nmode %-6s | prompt %.2f tok/s | gen %.2f tok/s | RAM hit %.1f%% | disk %.1f GiB in %.1f s waited | preload %.1f GiB\n",
                mode.c_str(), total_pp / total_pp_s, total_tg / total_tg_s,
                st.requests ? 100.0 * static_cast<double>(st.ram_hits) / static_cast<double>(st.requests) : 0.0,
                st.disk_bytes / (1024.0 * 1024.0 * 1024.0), st.disk_seconds, st.preload_bytes / (1024.0 * 1024.0 * 1024.0));

    if (!save_path.empty() && mode == "domain" && !sheets.save(save_path)) {
        std::cerr << "cannot save " << save_path << '\n';
    }
    llama_moe_set_expert_observer(nullptr, nullptr);
    llama_sampler_free(smpl);
    llama_free(ctx);
    llama_model_free(model);
    llama_moe_set_expert_source(nullptr, nullptr);
    return 0;
}
