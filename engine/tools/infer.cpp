#include "WeightStream/RuntimeProfiler.h"
#include "WeightStream/SystemMemoryGuard.h"
#include "WeightStream/VTMM.h"

#include "llama.h"
#include "llama-mmap.h"

#include <clocale>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

namespace {

bool ws_read(void* u, std::uint64_t o, void* b, std::size_t l) {
    auto* vtmm = static_cast<ws::VTMM*>(u);
    if (o < vtmm->model_data_offset()) {
        return false;
    }
    return vtmm->read_at(o, b, l);
}

}  // namespace

int main(int argc, char** argv) {
    std::setlocale(LC_NUMERIC, "C");

    std::string model = "models/Qwen2.5-32B-Instruct-Q4_K_L.gguf";
    std::string user_prompt = "Bonjour";
    int n_predict = 8;
    int ngl = 35;
    bool profile = false;
    bool invariants = false;
    bool paranoid = false;
    bool no_system_guard = false;
    std::size_t ram_gib = 32;
    std::size_t system_reserve_gib = 2;
    bool tier_mode = false;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "-m" && i + 1 < argc) {
            model = argv[++i];
        } else if (a == "--ram-gib" && i + 1 < argc) {
            ram_gib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (a == "-n" && i + 1 < argc) {
            n_predict = std::stoi(argv[++i]);
        } else if (a == "-ngl" && i + 1 < argc) {
            ngl = std::stoi(argv[++i]);
        } else if (a == "-p" && i + 1 < argc) {
            user_prompt = argv[++i];
        } else if (a == "--profile") {
            profile = true;
        } else if (a == "--invariants") {
            invariants = true;
        } else if (a == "--paranoid") {
            paranoid = true;
        } else if (a == "--no-system-guard") {
            no_system_guard = true;
        } else if (a == "--system-reserve-gib" && i + 1 < argc) {
            system_reserve_gib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (a == "--tier") {
            tier_mode = true;
        }
    }

    if (!std::filesystem::exists(model)) {
        std::cerr << "Model not found: " << model << '\n';
        return 1;
    }

    if (tier_mode) {
        const auto model_gib = static_cast<std::size_t>(std::filesystem::file_size(model) / (1024ULL * 1024 * 1024));
        const std::size_t cap = static_cast<std::size_t>(static_cast<double>(model_gib) * 0.72);
        ram_gib = std::max(std::size_t{10}, std::min(cap, std::size_t{26}));
        std::cerr << "[ws_infer] tier: model ~" << model_gib << " GiB, VTMM cache " << ram_gib
                  << " GiB, -ngl " << ngl << '\n';
    }

    ws::Config cfg;
    cfg.verbose = true;
    cfg.cuda_vram = false;
    cfg.debug_ssd_invariant = false;
    cfg.debug_cache_invariants = invariants || paranoid;
    cfg.debug_paranoid = paranoid;
    cfg.background_scheduler = false;
    cfg.coalesce_max_bytes = 0;
    cfg.ram_capacity = ram_gib * 1024ULL * 1024 * 1024;
    cfg.read_at_page_cache = true;
    cfg.system_memory_guard = !no_system_guard;
    if (no_system_guard) {
        cfg.system_memory_guard_mode = ws::SystemMemoryGuardMode::Off;
    } else {
        cfg.system_memory_guard_mode = ws::SystemMemoryGuardMode::Auto;
    }
    cfg.system_memory_allowance = 0.85;
    cfg.system_reserve_bytes = system_reserve_gib * 1024ULL * 1024 * 1024;
    cfg.load_priority_ngl = ngl;
    if (tier_mode) {
        cfg.background_scheduler = true;
        cfg.prefetch_window = 6;
    }
    ws::SystemMemoryGuard::enter_burst_phase(cfg);

    // CUDA/CPU backends must init before llama opens the model (byte-reader path).
    ggml_backend_load_all();

    ws::VTMM vtmm(cfg);
    if (!vtmm.load_model(model)) {
        std::cerr << "VTMM load_model failed: " << vtmm.last_error() << '\n';
        return 1;
    }

    std::cerr << "[ws_infer] warming priority pages…\n";
    if (!vtmm.warm_priority_pages()) {
        std::cerr << "warm_priority_pages failed: " << vtmm.last_error() << '\n';
        return 1;
    }

    llama_file_set_byte_reader(ws_read, &vtmm);

    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = ngl;
    mp.use_mmap = false;

    std::cerr << "[ws_infer] RAM cache " << ram_gib << " GiB, -ngl " << ngl << '\n';
    std::cerr << "[ws_infer] loading model...\n";

    const auto t_load0 = ggml_time_us();
    llama_model* model_ptr = llama_model_load_from_file(model.c_str(), mp);
    const auto t_load1 = ggml_time_us();
    llama_file_clear_byte_reader();
    if (model_ptr == nullptr) {
        std::cerr << "llama_model_load_from_file failed\n";
        return 1;
    }

    const auto& m = vtmm.metrics();
    std::cerr << "[ws_report] Load: " << (t_load1 - t_load0) / 1e6 << " s | read_at ops: " << m.byte_read_ops()
              << " | SSD loader ops: " << m.ssd_read_ops() << " | page hits/misses: " << m.read_at_page_hits()
              << "/" << m.read_at_page_misses() << " | SSD " << (m.ssd_bytes_read() / (1024 * 1024)) << " MiB\n";

    const char* tmpl = llama_model_chat_template(model_ptr, nullptr);
    std::string prompt = user_prompt;
    if (tmpl) {
        llama_chat_message msg{"user", user_prompt.c_str()};
        std::vector<char> buf(8192);
        const int32_t need = llama_chat_apply_template(tmpl, &msg, 1, true, buf.data(),
                                                       static_cast<int32_t>(buf.size()));
        if (need > 0) {
            prompt.assign(buf.data(), static_cast<std::size_t>(need));
        }
    }

    const llama_vocab* vocab = llama_model_get_vocab(model_ptr);
    const int n_prompt = -llama_tokenize(vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), nullptr, 0, true, true);
    std::vector<llama_token> toks(static_cast<std::size_t>(n_prompt));
    llama_tokenize(vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), toks.data(),
                   static_cast<int32_t>(toks.size()), true, true);

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = n_prompt + n_predict;
    cp.n_batch = n_prompt;
    cp.no_perf = false;
    llama_context* ctx = llama_init_from_model(model_ptr, cp);
    if (ctx == nullptr) {
        std::cerr << "llama_init_from_model failed\n";
        return 1;
    }

    ws::SystemMemoryGuard::enter_steady_phase(vtmm.mutable_config());

    llama_sampler* smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(smpl, llama_sampler_init_greedy());

    ws::RuntimeProfiler profiler;
    if (profile) {
        profiler.start([&] {
            std::cerr << "[ws_profile] gen phase\n";
        });
    }

    llama_batch batch = llama_batch_get_one(toks.data(), static_cast<int32_t>(toks.size()));
    const auto t0 = ggml_time_us();
    int n_decode = 0;
    for (int n_pos = 0; n_pos + batch.n_tokens < n_prompt + n_predict;) {
        if (llama_decode(ctx, batch)) {
            std::cerr << "llama_decode failed\n";
            return 1;
        }
        n_pos += batch.n_tokens;
        const llama_token id = llama_sampler_sample(smpl, ctx, -1);
        if (llama_vocab_is_eog(vocab, id)) {
            break;
        }
        char piece[256];
        const int n = llama_token_to_piece(vocab, id, piece, sizeof(piece), 0, true);
        if (n > 0) {
            std::cout.write(piece, n);
        }
        llama_token next = id;
        batch = llama_batch_get_one(&next, 1);
        ++n_decode;
    }
    profiler.stop();

    std::cout << '\n';
    std::cerr << "Generated " << n_decode << " tokens in " << (ggml_time_us() - t0) / 1e6 << " s\n";
    std::cerr << "--- llama.cpp perf ---\n";
    llama_perf_context_print(ctx);

    llama_sampler_free(smpl);
    llama_free(ctx);
    llama_model_free(model_ptr);
    return 0;
}
