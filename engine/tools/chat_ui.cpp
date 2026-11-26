#include "WeightStream/HardwareProfile.h"
#include "WeightStream/SystemMemoryGuard.h"
#include "WeightStream/VTMM.h"

#include "llama.h"
#include "llama-mmap.h"

#include "../third_party/llama.cpp/vendor/cpp-httplib/httplib.h"

#include <atomic>
#include <chrono>
#include <clocale>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <shellapi.h>
#endif

namespace {

enum class LoadPhase {
    Idle,
    Loading,
    Ready,
    Failed,
};

struct ChatState {
    std::mutex mu;
    std::mutex log_mu;
    ws::Config ws_config;
    std::unique_ptr<ws::VTMM> vtmm;
    llama_model* model = nullptr;
    llama_context* ctx = nullptr;
    llama_sampler* sampler = nullptr;
    std::string model_path;
    std::vector<std::string> logs;
    bool ready = false;
    LoadPhase load_phase = LoadPhase::Loading;
    std::string load_message = "Démarrage…";
    float load_progress = 0.f;
    std::string load_error;
    std::atomic<bool> generating{false};
};

ChatState g_state;

void set_load_progress(const std::string& message, float progress = -1.f) {
    std::lock_guard lock(g_state.mu);
    g_state.load_message = message;
    if (progress >= 0.f) {
        g_state.load_progress = std::clamp(progress, 0.f, 1.f);
    }
}

bool llama_load_progress(float progress, void*) {
    set_load_progress("Chargement des poids llama…", 0.15f + 0.75f * progress);
    return true;
}

void log_msg(const std::string& msg) {
    {
        std::lock_guard lock(g_state.log_mu);
        g_state.logs.push_back(msg);
        if (g_state.logs.size() > 200) {
            g_state.logs.erase(g_state.logs.begin());
        }
    }
    std::cerr << "[ws_chat_ui] " << msg << std::endl;
}

bool ws_read(void* u, std::uint64_t o, void* b, std::size_t l) {
    auto* vtmm = static_cast<ws::VTMM*>(u);
    if (o < vtmm->model_data_offset()) {
        return false;
    }
    return vtmm->read_at(o, b, l);
}

std::string read_ui_file() {
    const std::vector<std::filesystem::path> candidates = {
        "tools/ui/index.html",
        "../tools/ui/index.html",
        "../../tools/ui/index.html",
    };
    for (const auto& path : candidates) {
        if (!std::filesystem::exists(path)) {
            continue;
        }
        std::ifstream in(path, std::ios::binary);
        if (!in) {
            continue;
        }
        std::ostringstream ss;
        ss << in.rdbuf();
        return ss.str();
    }
    return "<html><body>index.html introuvable — lance depuis la racine du repo.</body></html>";
}

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 16);
    for (char c : s) {
        switch (c) {
            case '"':
            case '\\':
                out.push_back('\\');
                out.push_back(c);
                break;
            case '\n':
                out += "\\n";
                break;
            case '\r':
                out += "\\r";
                break;
            case '\t':
                out += "\\t";
                break;
            default:
                out.push_back(c);
        }
    }
    return out;
}

std::string extract_json_string(const std::string& body, const char* key) {
    const std::string needle = std::string("\"") + key + "\":\"";
    const auto pos = body.find(needle);
    if (pos == std::string::npos) {
        return {};
    }
    std::string out;
    for (std::size_t i = pos + needle.size(); i < body.size(); ++i) {
        if (body[i] == '\\' && i + 1 < body.size()) {
            out.push_back(body[++i]);
            continue;
        }
        if (body[i] == '"') {
            break;
        }
        out.push_back(body[i]);
    }
    return out;
}

int extract_json_int(const std::string& body, const char* key, int fallback) {
    const std::string needle = std::string("\"") + key + "\":";
    const auto pos = body.find(needle);
    if (pos == std::string::npos) {
        return fallback;
    }
    return std::atoi(body.c_str() + pos + needle.size());
}

double extract_json_double(const std::string& body, const char* key, double fallback) {
    const std::string needle = std::string("\"") + key + "\":";
    const auto pos = body.find(needle);
    if (pos == std::string::npos) {
        return fallback;
    }
    return std::atof(body.c_str() + pos + needle.size());
}

bool token_piece_ends_sentence(const char* piece, int len) {
    if (piece == nullptr || len <= 0) {
        return false;
    }
    const unsigned char c = static_cast<unsigned char>(piece[len - 1]);
    return c == '.' || c == '!' || c == '?' || c == '\n';
}

void trim_to_last_complete_sentence(std::string& text) {
    if (text.size() < 8) {
        return;
    }

    std::size_t best = std::string::npos;
    for (std::size_t i = 0; i < text.size(); ++i) {
        const char c = text[i];
        if (c == '.' || c == '!' || c == '?' || c == '\n') {
            best = i + 1;
        }
    }

    if (best != std::string::npos && best >= text.size() / 4) {
        text.resize(best);
        while (!text.empty() && (text.back() == ' ' || text.back() == '\n' || text.back() == '\r')) {
            text.pop_back();
        }
    }
}

std::string token_budget_system_hint(int n_predict) {
    (void)n_predict;
    return "Reply in the same language as the user. Be concise and always finish with a complete "
           "sentence; do not stop mid-sentence.";
}

std::size_t model_file_gib(const std::string& model) {
    const auto bytes = std::filesystem::file_size(model);
    return static_cast<std::size_t>(bytes / (1024ULL * 1024 * 1024));
}

std::size_t tier_ram_cache_gib(std::size_t model_gib) {
    const std::size_t cap = static_cast<std::size_t>(static_cast<double>(model_gib) * 0.72);
    return std::max(std::size_t{10}, std::min(cap, std::size_t{26}));
}

bool load_model_worker(const std::string& model, int ngl, std::size_t ram_gib, bool tier_mode) {
    set_load_progress("Initialisation des backends llama…", 0.02f);
    log_msg("Initialisation des backends llama…");
    ggml_backend_load_all();

    ws::Config cfg;
    cfg.verbose = true;
    cfg.cuda_vram = false;
    cfg.debug_ssd_invariant = false;
    cfg.background_scheduler = false;
    cfg.coalesce_max_bytes = 0;
    cfg.ram_capacity = ram_gib * 1024ULL * 1024 * 1024;
    cfg.read_at_page_cache = true;
    cfg.system_memory_guard = true;
    cfg.system_memory_guard_mode = ws::SystemMemoryGuardMode::Auto;
    cfg.system_memory_allowance = 0.85;
    cfg.load_priority_ngl = ngl;
    if (tier_mode) {
        cfg.background_scheduler = true;
        cfg.prefetch_window = 6;
        const auto model_gib = model_file_gib(model);
        log_msg("Mode tier: modele ~" + std::to_string(model_gib) +
                " Go, cache VTMM " + std::to_string(ram_gib) +
                " Go, -ngl " + std::to_string(ngl) +
                " (hot pages d'abord, brassage RAM/VRAM, infere llama.cpp)");
    }
    ws::SystemMemoryGuard::enter_burst_phase(cfg);

    set_load_progress("Index WeightStream (cache pages)…", 0.05f);
    log_msg("Initialisation WeightStream (cache pages)…");
    auto vtmm = std::make_unique<ws::VTMM>(cfg);
    if (!vtmm->load_model(model)) {
        log_msg("VTMM: " + vtmm->last_error());
        return false;
    }

    {
        std::lock_guard lock(g_state.mu);
        g_state.ws_config = cfg;
        g_state.vtmm = std::move(vtmm);
    }

    set_load_progress("Pré-chauffage des pages prioritaires…", 0.12f);
    log_msg("Pre-chauffage des pages prioritaires (embed, GPU, output)…");
    {
        std::lock_guard lock(g_state.mu);
        if (!g_state.vtmm->warm_priority_pages()) {
            log_msg("Pre-chauffage: " + g_state.vtmm->last_error());
            return false;
        }
        if (g_state.vtmm->build_inference_profile()) {
            log_msg("Profil inference active (prefetch guide).");
        }
    }

    ws::VTMM* vtmm_ptr = nullptr;
    {
        std::lock_guard lock(g_state.mu);
        vtmm_ptr = g_state.vtmm.get();
    }
    llama_file_set_byte_reader(ws_read, vtmm_ptr);

    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = ngl;
    mp.use_mmap = false;
    mp.progress_callback = llama_load_progress;
    mp.progress_callback_user_data = nullptr;

    set_load_progress("Chargement llama (plusieurs minutes)…", 0.15f);
    log_msg("Chargement llama (plusieurs minutes sur un gros modele)…");
    llama_model* model_ptr = llama_model_load_from_file(model.c_str(), mp);
    llama_file_clear_byte_reader();
    if (model_ptr == nullptr) {
        log_msg("llama_model_load_from_file a echoue");
        return false;
    }

    set_load_progress("Création du contexte llama…", 0.92f);
    log_msg("Creation du contexte llama…");
    const auto hw = ws::detect_hardware();
    const int n_threads = hw.cpu_logical_cores > 0 ? static_cast<int>(hw.cpu_logical_cores) : 4;
    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = 4096;
    cp.n_batch = 512;
    cp.n_ubatch = 512;
    cp.n_threads = n_threads;
    cp.n_threads_batch = n_threads;
    cp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_ENABLED;
    cp.no_perf = false;
    llama_context* ctx = llama_init_from_model(model_ptr, cp);
    if (ctx == nullptr) {
        log_msg("llama_init_from_model a echoue");
        llama_model_free(model_ptr);
        return false;
    }

    llama_sampler* sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(sampler, llama_sampler_init_greedy());

    {
        std::lock_guard lock(g_state.mu);
        ws::SystemMemoryGuard::enter_steady_phase(g_state.ws_config);
        g_state.model = model_ptr;
        g_state.ctx = ctx;
        g_state.sampler = sampler;
        g_state.model_path = model;
        g_state.ready = true;
        g_state.load_phase = LoadPhase::Ready;
        g_state.load_progress = 1.f;
        g_state.load_message = "Prêt";
    }

    log_msg("Modele pret — vous pouvez chatter.");
    return true;
}

void load_model_async(const std::string& model, int ngl, std::size_t ram_gib, bool tier_mode) {
    {
        std::lock_guard lock(g_state.mu);
        g_state.load_phase = LoadPhase::Loading;
        g_state.load_message = tier_mode ? "Mode tier — pre-chauffage hot…" : "Démarrage…";
        g_state.load_progress = 0.f;
        g_state.load_error.clear();
        g_state.ready = false;
    }

    const bool ok = load_model_worker(model, ngl, ram_gib, tier_mode);
    if (!ok) {
        std::lock_guard lock(g_state.mu);
        g_state.load_phase = LoadPhase::Failed;
        g_state.load_error = g_state.load_message;
        if (g_state.load_error.empty()) {
            g_state.load_error = "Échec du chargement";
        }
        log_msg("Chargement echoue.");
    }
}

std::string model_status_json() {
    std::lock_guard lock(g_state.mu);
    const char* phase = "loading";
    if (g_state.load_phase == LoadPhase::Loading || g_state.load_phase == LoadPhase::Idle) {
        phase = "loading";
    } else if (g_state.load_phase == LoadPhase::Ready) {
        phase = g_state.ws_config.system_memory_guard_phase == ws::SystemMemoryGuardPhase::Infer ? "infer"
                                                                                                  : "ready";
    } else if (g_state.load_phase == LoadPhase::Failed) {
        phase = "failed";
    }

    std::ostringstream out;
    out << "{\"ready\":" << (g_state.ready ? "true" : "false") << ",\"phase\":\"" << phase
        << "\",\"progress\":" << g_state.load_progress << ",\"message\":\""
        << json_escape(g_state.load_message) << "\"";
    if (!g_state.load_error.empty()) {
        out << ",\"error\":\"" << json_escape(g_state.load_error) << "\"";
    }
    if (!g_state.model_path.empty()) {
        out << ",\"model\":\"" << json_escape(g_state.model_path) << "\"";
    }
    out << '}';
    return out.str();
}

std::string run_chat(const std::string& user_prompt, int n_predict, int& tokens_out, double& seconds_out) {
    llama_model* model = nullptr;
    llama_context* ctx = nullptr;
    llama_sampler* sampler = nullptr;

    {
        std::lock_guard lock(g_state.mu);
        if (!g_state.ready || g_state.ctx == nullptr || g_state.model == nullptr) {
            tokens_out = 0;
            seconds_out = 0.0;
            return {};
        }
        model = g_state.model;
        ctx = g_state.ctx;
        sampler = g_state.sampler;
        ws::SystemMemoryGuard::enter_infer_burst_phase(g_state.ws_config);
        if (g_state.vtmm) {
            g_state.vtmm->mutable_config() = g_state.ws_config;
        }
    }

    struct SteadyGuard {
        ~SteadyGuard() {
            std::lock_guard lock(g_state.mu);
            ws::SystemMemoryGuard::enter_steady_phase(g_state.ws_config);
            if (g_state.vtmm) {
                g_state.vtmm->mutable_config() = g_state.ws_config;
            }
        }
    } steady_guard;

    llama_memory_clear(llama_get_memory(ctx), true);
    llama_sampler_reset(sampler);

    std::string prompt = user_prompt;
    const char* tmpl = llama_model_chat_template(model, nullptr);
    const std::string budget_hint = token_budget_system_hint(n_predict);
    if (tmpl) {
        llama_chat_message messages[] = {
            {"system", budget_hint.c_str()},
            {"user", user_prompt.c_str()},
        };
        std::vector<char> buf(16384);
        int32_t need = llama_chat_apply_template(tmpl, messages, 2, true, buf.data(),
                                                 static_cast<int32_t>(buf.size()));
        if (need < 0) {
            llama_chat_message user_only{"user", user_prompt.c_str()};
            need = llama_chat_apply_template(tmpl, &user_only, 1, true, buf.data(),
                                             static_cast<int32_t>(buf.size()));
        }
        if (need > static_cast<int32_t>(buf.size())) {
            buf.resize(static_cast<std::size_t>(need));
            need = llama_chat_apply_template(tmpl, messages, 2, true, buf.data(),
                                             static_cast<int32_t>(buf.size()));
        }
        if (need > 0) {
            prompt.assign(buf.data(), static_cast<std::size_t>(need));
        }
    } else {
        prompt = budget_hint + "\n\n" + user_prompt;
    }

    const llama_vocab* vocab = llama_model_get_vocab(model);
    const int n_prompt =
        -llama_tokenize(vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), nullptr, 0, true, true);
    std::vector<llama_token> toks(static_cast<std::size_t>(n_prompt));
    llama_tokenize(vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), toks.data(),
                   static_cast<int32_t>(toks.size()), true, true);

    llama_batch batch = llama_batch_get_one(toks.data(), static_cast<int32_t>(toks.size()));
    const auto t0 = ggml_time_us();
    std::string out;
    int n_decode = 0;
    bool hit_token_limit = false;
    bool ended_naturally = false;
    const int finish_zone = std::max(8, n_predict - std::min(32, n_predict / 4));

    for (int n_pos = 0; n_pos + batch.n_tokens < n_prompt + n_predict;) {
        if (llama_decode(ctx, batch)) {
            log_msg("llama_decode failed");
            break;
        }
        n_pos += batch.n_tokens;
        const llama_token id = llama_sampler_sample(sampler, ctx, -1);
        if (llama_vocab_is_eog(vocab, id)) {
            ended_naturally = true;
            break;
        }
        char piece[256];
        const int n = llama_token_to_piece(vocab, id, piece, sizeof(piece), 0, true);
        if (n > 0) {
            out.append(piece, static_cast<std::size_t>(n));
        }
        llama_token next = id;
        batch = llama_batch_get_one(&next, 1);
        ++n_decode;

        if (n_decode >= n_predict) {
            hit_token_limit = true;
            break;
        }
        if (n_decode >= finish_zone && n > 0 && token_piece_ends_sentence(piece, n)) {
            ended_naturally = true;
            break;
        }
    }

    if (hit_token_limit && !ended_naturally) {
        trim_to_last_complete_sentence(out);
        if (!out.empty() && !token_piece_ends_sentence(out.c_str(), static_cast<int>(out.size()))) {
            out += "…";
        }
    }

    const double seconds = (ggml_time_us() - t0) / 1e6;
    tokens_out = n_decode;
    seconds_out = seconds;
    log_msg("Généré " + std::to_string(n_decode) + " tokens en " + std::to_string(seconds) + " s");
    return out;
}

void apply_guard(const std::string& body) {
    std::lock_guard lock(g_state.mu);
    const double allowance = extract_json_double(body, "allowance", g_state.ws_config.system_memory_allowance);
    const std::string mode = extract_json_string(body, "mode");

    g_state.ws_config.system_memory_allowance = std::clamp(allowance, 0.05, 1.0);
    if (mode == "off") {
        g_state.ws_config.system_memory_guard = false;
        g_state.ws_config.system_memory_guard_mode = ws::SystemMemoryGuardMode::Off;
    } else if (mode == "manual") {
        g_state.ws_config.system_memory_guard = true;
        g_state.ws_config.system_memory_guard_mode = ws::SystemMemoryGuardMode::Manual;
    } else {
        g_state.ws_config.system_memory_guard = true;
        g_state.ws_config.system_memory_guard_mode = ws::SystemMemoryGuardMode::Auto;
    }

    if (g_state.vtmm) {
        g_state.vtmm->mutable_config() = g_state.ws_config;
    }
}

void open_browser(const std::string& url) {
#if defined(_WIN32)
    ShellExecuteA(nullptr, "open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
#else
    const std::string cmd = "xdg-open '" + url + "'";
    std::system(cmd.c_str());
#endif
}

}  // namespace

int main(int argc, char** argv) {
    std::setlocale(LC_NUMERIC, "C");

    std::string model;
    int ngl = 35;
    int port = 8765;
    std::size_t ram_gib = 32;
    bool no_browser = false;
    bool tier_mode = false;

    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "-m" && i + 1 < argc) {
            model = argv[++i];
        } else if (a == "-ngl" && i + 1 < argc) {
            ngl = std::stoi(argv[++i]);
        } else if (a == "--port" && i + 1 < argc) {
            port = std::stoi(argv[++i]);
        } else if (a == "--ram-gib" && i + 1 < argc) {
            ram_gib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (a == "--tier") {
            tier_mode = true;
        } else if (a == "--no-browser") {
            no_browser = true;
        }
    }

    const auto hw = ws::detect_hardware();
    std::cerr << ws::format_hardware_report(hw);

    if (model.empty()) {
        std::cerr << "Usage: ws_chat_ui -m model.gguf [--tier] [--port 8765] [--ram-gib 32] [-ngl 35] [--no-browser]\n";
        return 1;
    }

    if (!std::filesystem::exists(model)) {
        std::cerr << "Modele introuvable: " << model << '\n';
        return 1;
    }

    if (tier_mode) {
        const std::size_t model_gib = model_file_gib(model);
        if (model_gib < 8) {
            std::cerr << "[tier] Modele petit (~" << model_gib
                      << " Go) — tier peu utile, utilise WeightStream Chat.bat\n";
        }
        ram_gib = tier_ram_cache_gib(model_gib);
        std::cerr << "[tier] GGUF ~" << model_gib << " Go | cache VTMM " << ram_gib
                  << " Go | -ngl " << ngl
                  << " | hot-first + prefetch (infere = llama.cpp)\n";
    }

    {
        std::lock_guard lock(g_state.mu);
        g_state.model_path = model;
        g_state.load_phase = LoadPhase::Loading;
        g_state.load_message = "Démarrage…";
        g_state.load_progress = 0.f;
        g_state.ready = false;
    }

    const std::string ui_html = read_ui_file();
    httplib::Server svr;

    svr.Get("/", [&](const httplib::Request&, httplib::Response& res) {
        res.set_content(ui_html, "text/html; charset=utf-8");
    });

    svr.Get("/api/specs", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(ws::hardware_profile_json(ws::detect_hardware()), "application/json");
    });

    svr.Get("/api/model", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(model_status_json(), "application/json");
    });

    svr.Get("/api/status", [](const httplib::Request&, httplib::Response& res) {
        std::lock_guard lock(g_state.mu);
        std::size_t used = 0;
        std::size_t cap = 0;
        if (g_state.vtmm) {
            used = g_state.vtmm->ram_cache_used();
            cap = g_state.vtmm->ram_cache_capacity();
        }
        const auto status = ws::SystemMemoryGuard::status(g_state.ws_config, used, cap);
        res.set_content(ws::SystemMemoryGuard::status_json(status), "application/json");
    });

    svr.Post("/api/guard", [](const httplib::Request& req, httplib::Response& res) {
        apply_guard(req.body);
        res.set_content(R"({"ok":true})", "application/json");
    });

    svr.Post("/api/chat", [](const httplib::Request& req, httplib::Response& res) {
        const std::string prompt = extract_json_string(req.body, "prompt");
        const int n = extract_json_int(req.body, "n", 256);
        if (prompt.empty()) {
            res.set_content(R"({"error":"prompt vide"})", "application/json");
            return;
        }
        {
            std::lock_guard lock(g_state.mu);
            if (!g_state.ready || g_state.load_phase != LoadPhase::Ready) {
                std::ostringstream json;
                json << R"({"error":")" << json_escape(g_state.load_message)
                     << R"(","loading":true,"progress":)" << g_state.load_progress << "}";
                res.status = 503;
                res.set_content(json.str(), "application/json");
                return;
            }
            if (g_state.generating.exchange(true)) {
                res.set_content(R"({"error":"génération déjà en cours","busy":true})",
                                "application/json");
                return;
            }
        }

        struct GeneratingReset {
            ~GeneratingReset() { g_state.generating = false; }
        } gen_reset;

        int tokens = 0;
        double seconds = 0.0;
        const std::string text = run_chat(prompt, n, tokens, seconds);

        if (text.empty()) {
            res.set_content(R"({"error":"génération échouée"})", "application/json");
            return;
        }
        std::ostringstream json;
        json << "{\"text\":\"" << json_escape(text) << "\",\"tokens\":" << tokens << ",\"seconds\":"
             << seconds << "}";
        res.set_content(json.str(), "application/json");
    });

    svr.Get("/api/logs", [](const httplib::Request&, httplib::Response& res) {
        std::lock_guard lock(g_state.log_mu);
        std::ostringstream out;
        out << "{\"lines\":[";
        for (std::size_t i = 0; i < g_state.logs.size(); ++i) {
            if (i) {
                out << ',';
            }
            out << "\"" << json_escape(g_state.logs[i]) << "\"";
        }
        out << "]}";
        res.set_content(out.str(), "application/json");
    });

    const std::string url = "http://127.0.0.1:" + std::to_string(port) + "/";
    if (!svr.bind_to_port("127.0.0.1", port)) {
        std::cerr << "Impossible d'ecouter sur le port " << port << '\n';
        return 1;
    }

    std::thread loader([&] { load_model_async(model, ngl, ram_gib, tier_mode); });
    loader.detach();

    std::cerr << "UI: " << url << " (chargement en arriere-plan)\n";
    log_msg("Interface ouverte — chargement du modele en cours.");
    if (!no_browser) {
        open_browser(url);
    }

    svr.listen_after_bind();
    return 0;
}
