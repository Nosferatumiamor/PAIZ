// Measures MoE decode speed with routed experts kept on the host (--cpu-moe equivalent)
// and an optional GPU expert cache, with full llama.cpp logs (cache allocation and
// hit-rate stats are printed when the context is freed).
#include "WeightStream/ExpertBudget.h"
#include "WeightStream/ExpertStore.h"
#include "WeightStream/RouterLookahead.h"

#include "ggml-cpu.h"
#include "ggml.h"
#include "chat.h"
#include "llama-ext.h"
#include "llama.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <psapi.h>
#pragma comment(lib, "psapi.lib")
#endif

namespace {

void log_to_stderr(ggml_log_level level, const char* text, void*) {
    if (level >= GGML_LOG_LEVEL_INFO || level == GGML_LOG_LEVEL_CONT) {
#ifdef _WIN32
        // WS_MEMTRACE=1: prefix each log line with the process memory at that moment, to see which step grows it
        static const bool trace = GetEnvironmentVariableA("WS_MEMTRACE", nullptr, 0) > 0;
        if (trace && level != GGML_LOG_LEVEL_CONT) {
            PROCESS_MEMORY_COUNTERS_EX m{};
            GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&m), sizeof(m));
            std::fprintf(stderr, "[ws %5.0f | priv %5.0f] ", m.WorkingSetSize / 1048576.0, m.PrivateUsage / 1048576.0);
        }
#endif
        std::fputs(text, stderr);
    }
}

void print_usage() {
    std::cerr << "Usage: ws_moe_probe -m model.gguf [-f prompt.txt | -p prompt] [-n N] [--cache-mib N] [-c N]\n"
                 "                    [--ws-ram-mib N] [--ubatch N]\n"
                 "  --cache-mib N   llama.cpp GPU expert cache (VRAM)\n"
                 "  --ws-ram-mib N  serve cache misses from WeightStream's RAM expert cache + unbuffered disk reads\n"
                 "  --ubatch N      micro-batch size; <= 32 sends prompt processing through the expert cache too\n";
}

struct ExpertSource {
    ws::ExpertStore store;
    std::vector<ws::ExpertStore::Request> requests;
    bool failed = false;

    // --lookahead: when the CPU backend starts a layer's experts, predict and prefetch the next layer's
    ws::RouterLookahead router;
    bool lookahead = false;
    std::size_t lookahead_extra = 2;  // experts read beyond the router's per-token count, for a single token
    // measured on LFM2-8B-A1B (CPU, 1.2 GB cache): +19% prompt speed but -8% generation, where one layer computes
    // too fast for the read to land in time and the wasted reads crowd the disk; so prompt blocks only by default
    bool lookahead_decode = false;
    int last_layer = -1;
    std::uint64_t lookahead_calls = 0;
    std::uint64_t lookahead_experts = 0;
};

// Script format: "=== name" starts a character (following lines = its system prompt); "--- round" starts a round
// ("name: line" = what the player says to that character); "--- sleep name" saves that thread to disk and frees its
// slot; "--- leave name" drops the thread for good.
struct NpcEvent {
    enum Kind { Round, Sleep, Leave } kind = Round;
    int who = -1;
    std::vector<std::pair<int, std::string>> lines;
};

struct NpcScript {
    std::vector<std::string> names, systems;
    std::vector<NpcEvent> events;
};

bool load_npc_script(const std::string& path, NpcScript& out) {
    std::ifstream in(path);
    if (!in) {
        return false;
    }
    auto find_name = [&](const std::string& n) {
        for (std::size_t i = 0; i < out.names.size(); ++i) {
            if (out.names[i] == n) {
                return static_cast<int>(i);
            }
        }
        return -1;
    };
    std::string line;
    bool in_round = false;
    while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }
        if (line.rfind("=== ", 0) == 0) {
            out.names.push_back(line.substr(4));
            out.systems.emplace_back();
            in_round = false;
        } else if (line.rfind("--- round", 0) == 0) {
            out.events.emplace_back();
            in_round = true;
        } else if (line.rfind("--- sleep ", 0) == 0 || line.rfind("--- leave ", 0) == 0) {
            NpcEvent ev;
            ev.kind = line[4] == 's' ? NpcEvent::Sleep : NpcEvent::Leave;
            ev.who = find_name(line.substr(10));
            if (ev.who >= 0) {
                out.events.push_back(ev);
            }
            in_round = false;
        } else if (in_round) {
            const auto colon = line.find(": ");
            if (colon == std::string::npos) {
                continue;
            }
            const int who = find_name(line.substr(0, colon));
            if (who >= 0) {
                out.events.back().lines.emplace_back(who, line.substr(colon + 2));
            }
        } else if (!out.names.empty()) {
            std::string& sys = out.systems.back();
            sys += sys.empty() ? line : "\n" + line;
        }
    }
    return !out.names.empty() && !out.events.empty();
}

int layer_of_name(const char* name) {
    return std::strncmp(name, "blk.", 4) == 0 ? std::atoi(name + 4) : -1;
}

bool serve_experts(void* user, llama_moe_expert_read* reads, size_t n_reads) {
    auto* src = static_cast<ExpertSource*>(user);
    src->requests.resize(n_reads);
    for (size_t i = 0; i < n_reads; ++i) {
        src->requests[i] = {reads[i].tensor->name, reads[i].expert, static_cast<std::size_t>(reads[i].tensor->nb[2]), nullptr};
    }
    if (!src->store.fetch(src->requests.data(), n_reads)) {
        if (!src->failed) {
            std::cerr << "[ws_moe_probe] WeightStream fetch failed, falling back to mmap: " << src->store.last_error() << '\n';
            src->failed = true;
        }
        return false;
    }
    for (size_t i = 0; i < n_reads; ++i) {
        reads[i].data = src->requests[i].data;
    }
    return true;
}

// CPU backend provider (--cpu-stream): the weights of the experts a MUL_MAT_ID op will read, one fetch per op
bool serve_cpu_experts(void* user, const ggml_tensor* op, const int32_t* experts, int n_experts, const void** out) {
    auto* src = static_cast<ExpertSource*>(user);
    const ggml_tensor* w = op->src[0];
    src->requests.resize(static_cast<std::size_t>(n_experts));
    for (int i = 0; i < n_experts; ++i) {
        src->requests[static_cast<std::size_t>(i)] = {w->name, experts[i], static_cast<std::size_t>(w->nb[2]), nullptr};
    }
    if (!src->store.fetch(src->requests.data(), static_cast<std::size_t>(n_experts))) {
        if (!src->failed) {
            std::cerr << "[ws_moe_probe] WeightStream fetch failed, falling back to mmap: " << src->store.last_error() << '\n';
            src->failed = true;
        }
        return false;
    }
    for (int i = 0; i < n_experts; ++i) {
        out[i] = src->requests[static_cast<std::size_t>(i)].data;
    }

    // the first expert op of a layer sees the layer's input: use it to guess the next layer's experts, read
    // in the background while this layer and the next attention compute (after the demand read, not before)
    const int layer = layer_of_name(w->name);
    const ggml_tensor* act = op->src[1];
    const ggml_tensor* ids = op->src[2];
    if (src->lookahead && layer != src->last_layer) {
        src->last_layer = layer;
        if (src->router.has_layer(layer + 1) && act->type == GGML_TYPE_F32 && act->nb[0] == sizeof(float) &&
            static_cast<std::size_t>(act->ne[0]) == src->router.n_embd()) {
            const auto n_tokens = static_cast<std::size_t>(act->ne[2]);
            if (n_tokens == 1 && !src->lookahead_decode) {
                return true;
            }
            const auto per_token = static_cast<std::size_t>(ids->ne[0]);
            const std::size_t max_total = n_tokens == 1 ? per_token + src->lookahead_extra : 4 * per_token;
            const std::vector<int32_t> next = src->router.predict(layer + 1, static_cast<const float*>(act->data), n_tokens,
                                                                  static_cast<std::size_t>(act->nb[2]) / sizeof(float), per_token, max_total);
            src->store.prefetch(layer + 1, next.data(), next.size());
            ++src->lookahead_calls;
            src->lookahead_experts += next.size();
        }
    }
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    std::string model_path;
    std::string prompt = "Hello";
    int n_predict = 64;
    int n_ctx = 4096;
    std::size_t cache_mib = 0;
    std::size_t ws_ram_mib = 0;
    int n_ubatch = 0;
    bool cpu_stream = false;
    bool no_repack = false;
    bool group_reads = false;
    bool elastic_test = false;
    int n_seqs = 1;
    std::string script_path;
    std::string state_dir = "ws_npc_state";
    int slots_opt = 0;
    NpcScript script;
    std::string prompt2;
    bool lookahead = false;
    bool lookahead_decode = false;
    std::size_t lookahead_extra = 2;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "-m" && i + 1 < argc) {
            model_path = argv[++i];
        } else if (arg == "-p" && i + 1 < argc) {
            prompt = argv[++i];
        } else if (arg == "-f" && i + 1 < argc) {
            std::ifstream in(argv[++i], std::ios::binary);
            std::stringstream ss;
            ss << in.rdbuf();
            prompt = ss.str();
        } else if (arg == "-f2" && i + 1 < argc) {
            std::ifstream in2(argv[++i], std::ios::binary);
            std::stringstream ss2;
            ss2 << in2.rdbuf();
            prompt2 = ss2.str();
        } else if (arg == "--slots" && i + 1 < argc) {
            slots_opt = std::stoi(argv[++i]);
        } else if (arg == "--state-dir" && i + 1 < argc) {
            state_dir = argv[++i];
        } else if (arg == "--npc-script" && i + 1 < argc) {
            script_path = argv[++i];
        } else if (arg == "--seqs" && i + 1 < argc) {
            n_seqs = std::stoi(argv[++i]);
        } else if (arg == "-n" && i + 1 < argc) {
            n_predict = std::stoi(argv[++i]);
        } else if (arg == "-c" && i + 1 < argc) {
            n_ctx = std::stoi(argv[++i]);
        } else if (arg == "--cache-mib" && i + 1 < argc) {
            cache_mib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (arg == "--ws-ram-mib" && i + 1 < argc) {
            ws_ram_mib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (arg == "--cpu-stream") {
            cpu_stream = true;
        } else if (arg == "--no-repack") {
            no_repack = true;
        } else if (arg == "--lookahead") {
            lookahead = true;
        } else if (arg == "--lookahead-extra" && i + 1 < argc) {
            lookahead_extra = static_cast<std::size_t>(std::stoul(argv[++i]));
        } else if (arg == "--lookahead-decode") {
            lookahead = true;
            lookahead_decode = true;
        } else if (arg == "--group") {
            group_reads = true;
        } else if (arg == "--elastic-test") {
            elastic_test = true;
        } else if (arg == "--ubatch" && i + 1 < argc) {
            n_ubatch = std::stoi(argv[++i]);
        } else {
            print_usage();
            return 1;
        }
    }
    if (model_path.empty()) {
        print_usage();
        return 1;
    }

    llama_log_set(log_to_stderr, nullptr);
    ggml_backend_load_all();

    ExpertSource source;
    if (ws_ram_mib > 0) {
        // --elastic-test shrinks the cache to half and grows it back mid-generation: reserve the full size once
        if (!source.store.open(model_path, ws_ram_mib * 1024 * 1024, ws_ram_mib * 1024 * 1024)) {
            std::cerr << "[ws_moe_probe] ExpertStore: " << source.store.last_error() << '\n';
            return 1;
        }
        std::fprintf(stderr, "[ws_moe_probe] WeightStream RAM expert cache: %zu slots x %zu KiB\n",
                     source.store.slot_count(), source.store.slot_bytes() / 1024);
        source.store.set_group_layer_reads(group_reads);
        if (lookahead) {
            if (!cpu_stream) {
                std::cerr << "[ws_moe_probe] --lookahead needs --cpu-stream (the GPU cache hook sees no activations)" << '\n';
                return 1;
            }
            if (!source.router.open(model_path)) {
                std::cerr << "[ws_moe_probe] lookahead: " << source.router.error() << '\n';
                return 1;
            }
            source.lookahead = true;
            source.lookahead_extra = lookahead_extra;
            source.lookahead_decode = lookahead_decode;
        }
        if (cpu_stream) {
            _putenv_s("WEIGHTSTREAM_NO_PREFETCH", "1");
            ggml_cpu_set_expert_fetch(serve_cpu_experts, &source);
        } else {
            llama_moe_set_expert_source(serve_experts, &source);
        }
    }

    llama_model_tensor_buft_override overrides[] = {
        {"\\.ffn_(up|down|gate|gate_up)_(ch|)exps", ggml_backend_cpu_buffer_type()},
        {nullptr, nullptr},
    };

    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = 999;
    mp.tensor_buft_overrides = overrides;
    // CPU expert overrides are repacked by default into a private CPU_REPACK copy of every expert (~model size), and
    // repacked tensors are computed by their own kernels, bypassing the streaming hook: the stream mode must avoid it
    if (cpu_stream || no_repack) {
        mp.use_extra_bufts = false;
    }

    const auto t_load0 = std::chrono::steady_clock::now();
    llama_model* model = llama_model_load_from_file(model_path.c_str(), mp);
    if (!model) {
        std::cerr << "model load failed\n";
        return 1;
    }
    const double load_s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t_load0).count();

#ifdef _WIN32
    {
        PROCESS_MEMORY_COUNTERS_EX m{};
        GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&m), sizeof(m));
        std::fprintf(stderr, "[ws_moe_probe] after model load: working set %.0f MiB, private %.0f MiB\n", m.WorkingSetSize / (1024.0 * 1024.0), m.PrivateUsage / (1024.0 * 1024.0));
    }
#endif
    llama_context_params cp = llama_context_default_params();
    if (!script_path.empty()) {
        if (!load_npc_script(script_path, script)) {
            std::cerr << "cannot read a valid --npc-script (need === name sections and --- round blocks)\n";
            return 1;
        }
        n_seqs = static_cast<int>(script.names.size());
        if (slots_opt > 0 && slots_opt < n_seqs) {
            n_seqs = slots_opt;
        }
    }
    cp.n_ctx = static_cast<uint32_t>(n_ctx * n_seqs);
    cp.n_seq_max = static_cast<uint32_t>(n_seqs);
    cp.n_batch = 512;
    if (n_ubatch > 0) {
        cp.n_ubatch = static_cast<uint32_t>(n_ubatch);
    }
    cp.moe_cache_size = cache_mib * 1024 * 1024;
    llama_context* ctx = llama_init_from_model(model, cp);
    if (!ctx) {
        std::cerr << "context init failed\n";
        return 1;
    }

    const llama_vocab* vocab = llama_model_get_vocab(model);
    std::string formatted = prompt;
    if (const char* tmpl = llama_model_chat_template(model, nullptr)) {
        llama_chat_message msg{"user", prompt.c_str()};
        std::vector<char> buf(prompt.size() * 2 + 4096);
        const int32_t need = llama_chat_apply_template(tmpl, &msg, 1, true, buf.data(), static_cast<int32_t>(buf.size()));
        if (need > 0 && need <= static_cast<int32_t>(buf.size())) {
            formatted.assign(buf.data(), static_cast<std::size_t>(need));
        }
    }

    const int n_prompt = -llama_tokenize(vocab, formatted.c_str(), static_cast<int32_t>(formatted.size()), nullptr, 0, true, true);
    std::vector<llama_token> toks(static_cast<std::size_t>(n_prompt));
    llama_tokenize(vocab, formatted.c_str(), static_cast<int32_t>(formatted.size()), toks.data(), n_prompt, true, true);

    llama_sampler* smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(smpl, llama_sampler_init_greedy());

    if (!script_path.empty()) {
        // Independent character threads on ONE loaded model. A thread = a chat history + its KV cache. Only
        // `n_slots` KV caches live in memory (the context's sequences); a thread without a slot is "asleep": its KV
        // cache sits in a file and is restored when the player talks to it again, the least recently used thread
        // making room. In a round every awake thread replies in the same batched decode.
        struct Conv {
            llama_pos pos = 0;
            int slot = -1;
            bool has_state = false;
            int last_used = 0;
            std::vector<std::string> role, content;  // chat history without the character sheet
            std::string last_reply;                  // what the KV holds as the last assistant message
        };
        // Any model's chat template (Jinja, rendered by llama.cpp's common library, thinking off). The whole history is
        // rendered, but only what follows the previous reply is prefilled: the KV already holds that reply.
        const common_chat_templates_ptr tmpls = common_chat_templates_init(model, "");
        if (!tmpls) {
            std::cerr << "no usable chat template in this model\n";
            return 1;
        }
        auto render_history = [&](const std::string& sheet, const std::vector<std::string>& role, const std::vector<std::string>& content) {
            auto build = [&](bool merge_sheet) {
                common_chat_templates_inputs in;
                in.use_jinja = true;
                in.add_generation_prompt = true;
                in.enable_thinking = false;
                if (!merge_sheet) {
                    common_chat_msg m;
                    m.role = "system";
                    m.content = sheet;
                    in.messages.push_back(m);
                }
                for (std::size_t i = 0; i < role.size(); ++i) {
                    common_chat_msg m;
                    m.role = role[i];
                    m.content = merge_sheet && i == 0 ? sheet + "\n\n" + content[i] : content[i];
                    in.messages.push_back(m);
                }
                return common_chat_templates_apply(tmpls.get(), in).prompt.str();
            };
            try {
                return build(false);
            } catch (const std::exception&) {  // template without a system role: the sheet leads the first player line
                return build(true);
            }
        };
        const char* bos_text = llama_vocab_bos(vocab) >= 0 ? llama_vocab_get_text(vocab, llama_vocab_bos(vocab)) : nullptr;
        std::size_t realigns = 0;
        const std::size_t nc = script.names.size();
        const int n_slots = n_seqs;
        std::vector<Conv> conv(nc);
        std::vector<int> owner(static_cast<std::size_t>(n_slots), -1);
        std::filesystem::create_directories(state_dir);
        auto state_file = [&](std::size_t c) { return (std::filesystem::path(state_dir) / (script.names[c] + ".kv")).string(); };
        double sleep_s = 0.0, wake_s = 0.0;
        std::size_t n_sleeps = 0, n_wakes = 0;
        std::uintmax_t bytes_saved = 0;

        auto tokenize_raw = [&](const std::string& text, bool add_special) {
            const int n = -llama_tokenize(vocab, text.c_str(), static_cast<int32_t>(text.size()), nullptr, 0, add_special, true);
            std::vector<llama_token> t(static_cast<std::size_t>(n));
            llama_tokenize(vocab, text.c_str(), static_cast<int32_t>(text.size()), t.data(), n, add_special, true);
            return t;
        };
        auto trim = [](const std::string& s) {
            const auto b = s.find_first_not_of(" \t\r\n");
            if (b == std::string::npos) {
                return std::string();
            }
            return s.substr(b, s.find_last_not_of(" \t\r\n") - b + 1);
        };
        auto put_to_sleep = [&](std::size_t c) {
            Conv& cv = conv[c];
            if (cv.slot < 0) {
                return;
            }
            const auto t0 = std::chrono::steady_clock::now();
            llama_token none = 0;
            const std::string f = state_file(c);
            llama_state_seq_save_file(ctx, f.c_str(), static_cast<llama_seq_id>(cv.slot), &none, 0);
            llama_memory_seq_rm(llama_get_memory(ctx), static_cast<llama_seq_id>(cv.slot), -1, -1);
            owner[static_cast<std::size_t>(cv.slot)] = -1;
            cv.slot = -1;
            cv.has_state = true;
            const double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
            sleep_s += dt;
            ++n_sleeps;
            std::error_code ec;
            const auto sz = std::filesystem::file_size(f, ec);
            bytes_saved += ec ? 0 : sz;
            std::fprintf(stderr, "[ws_moe_probe] %s goes to sleep: %.1f MiB written in %.2f s\n", script.names[c].c_str(), (ec ? 0 : sz) / (1024.0 * 1024.0), dt);
        };
        // gives thread c a slot (restoring its KV cache from disk if it was asleep); `keep` = threads that must not be evicted
        auto wake = [&](std::size_t c, const std::vector<bool>& keep, int tick) {
            Conv& cv = conv[c];
            cv.last_used = tick;
            if (cv.slot >= 0) {
                return true;
            }
            int free_slot = -1;
            for (int k = 0; k < n_slots && free_slot < 0; ++k) {
                if (owner[static_cast<std::size_t>(k)] < 0) {
                    free_slot = k;
                }
            }
            if (free_slot < 0) {
                int victim = -1;
                for (int k = 0; k < n_slots; ++k) {
                    const auto o = static_cast<std::size_t>(owner[static_cast<std::size_t>(k)]);
                    if (!keep[o] && (victim < 0 || conv[o].last_used < conv[static_cast<std::size_t>(owner[static_cast<std::size_t>(victim)])].last_used)) {
                        victim = k;
                    }
                }
                if (victim < 0) {
                    return false;
                }
                free_slot = victim;
                put_to_sleep(static_cast<std::size_t>(owner[static_cast<std::size_t>(victim)]));
            }
            cv.slot = free_slot;
            owner[static_cast<std::size_t>(free_slot)] = static_cast<int>(c);
            llama_memory_seq_rm(llama_get_memory(ctx), static_cast<llama_seq_id>(free_slot), -1, -1);
            if (cv.has_state) {
                const auto t0 = std::chrono::steady_clock::now();
                std::vector<llama_token> none(8);
                std::size_t n_back = 0;
                const std::string f = state_file(c);
                if (llama_state_seq_load_file(ctx, f.c_str(), static_cast<llama_seq_id>(free_slot), none.data(), none.size(), &n_back) == 0) {
                    std::cerr << "restoring the KV cache of " << script.names[c] << " failed\n";
                    return false;
                }
                const double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
                wake_s += dt;
                ++n_wakes;
                std::fprintf(stderr, "[ws_moe_probe] %s wakes up in slot %d: restored in %.2f s\n", script.names[c].c_str(), free_slot, dt);
            }
            return true;
        };

        int round_no = 0, tick = 0;
        for (const auto& ev : script.events) {
            ++tick;
            if (ev.kind != NpcEvent::Round) {
                const std::size_t c = static_cast<std::size_t>(ev.who);
                if (ev.kind == NpcEvent::Sleep) {
                    put_to_sleep(c);
                } else {
                    if (conv[c].slot >= 0) {
                        llama_memory_seq_rm(llama_get_memory(ctx), static_cast<llama_seq_id>(conv[c].slot), -1, -1);
                        owner[static_cast<std::size_t>(conv[c].slot)] = -1;
                    }
                    std::error_code ec;
                    std::filesystem::remove(state_file(c), ec);
                    conv[c] = Conv();
                    std::fprintf(stderr, "[ws_moe_probe] %s leaves: thread dropped\n", script.names[c].c_str());
                }
                std::printf("\n===== %s %s =====\n", script.names[c].c_str(), ev.kind == NpcEvent::Sleep ? "s'endort" : "quitte la partie");
                continue;
            }
            ++round_no;
            std::printf("\n===== round %d =====\n", round_no);
            // more talkers than slots: answer them in successive groups
            for (std::size_t g0 = 0; g0 < ev.lines.size(); g0 += static_cast<std::size_t>(n_slots)) {
                const std::size_t g1 = std::min(ev.lines.size(), g0 + static_cast<std::size_t>(n_slots));
                std::vector<bool> keep(nc, false);
                for (std::size_t i = g0; i < g1; ++i) {
                    keep[static_cast<std::size_t>(ev.lines[i].first)] = true;
                }
                std::vector<llama_token> pending(nc, 0);
                std::vector<bool> active(nc, false);
                std::vector<std::string> reply(nc);
                double prefill_s = 0.0;
                for (std::size_t i = g0; i < g1; ++i) {
                    const std::size_t ci = static_cast<std::size_t>(ev.lines[i].first);
                    const std::string& line = ev.lines[i].second;
                    if (!wake(ci, keep, tick)) {
                        return 1;
                    }
                    Conv& cv = conv[ci];
                    // the end-of-turn token of the previous reply is not decoded: the suffix (rendered after the stored reply)
                    // starts with it, then the new player line and the opening of the next reply
                    cv.role.push_back("user");
                    cv.content.push_back(line);
                    const std::string full = render_history(script.systems[ci], cv.role, cv.content);
                    std::string suffix = full;
                    if (cv.pos > 0) {
                        const auto at = cv.last_reply.empty() ? std::string::npos : full.rfind(cv.last_reply);
                        if (at != std::string::npos) {
                            suffix = full.substr(at + cv.last_reply.size());
                        } else {  // cannot align with what the KV holds: rebuild this thread from its history
                            llama_memory_seq_rm(llama_get_memory(ctx), static_cast<llama_seq_id>(cv.slot), -1, -1);
                            cv.pos = 0;
                            ++realigns;
                        }
                    }
                    const bool add_bos = cv.pos == 0 && llama_vocab_get_add_bos(vocab) && !(bos_text && suffix.rfind(bos_text, 0) == 0);
                    const std::vector<llama_token> tk = tokenize_raw(suffix, add_bos);
                    const auto t_pf = std::chrono::steady_clock::now();
                    llama_batch b = llama_batch_init(256, 0, 1);
                    for (std::size_t off = 0; off < tk.size(); off += 256) {
                        const std::size_t m = std::min<std::size_t>(256, tk.size() - off);
                        for (std::size_t j = 0; j < m; ++j) {
                            b.token[j] = tk[off + j];
                            b.pos[j] = cv.pos++;
                            b.n_seq_id[j] = 1;
                            b.seq_id[j][0] = static_cast<llama_seq_id>(cv.slot);
                            b.logits[j] = off + j + 1 == tk.size();
                        }
                        b.n_tokens = static_cast<int32_t>(m);
                        if (llama_decode(ctx, b)) {
                            std::cerr << "prefill failed (" << script.names[ci] << ")\n";
                            return 1;
                        }
                    }
                    pending[ci] = llama_sampler_sample(smpl, ctx, b.n_tokens - 1);
                    llama_batch_free(b);
                    active[ci] = true;
                    prefill_s += std::chrono::duration<double>(std::chrono::steady_clock::now() - t_pf).count();
                }
                const auto t_gen = std::chrono::steady_clock::now();
                std::size_t gen_tokens = 0;
                for (int step = 0; step < n_predict; ++step) {
                    llama_batch b = llama_batch_init(static_cast<int32_t>(nc), 0, 1);
                    std::vector<int32_t> idx(nc, -1);
                    int32_t k = 0;
                    for (std::size_t c = 0; c < nc; ++c) {
                        if (!active[c]) {
                            continue;
                        }
                        if (llama_vocab_is_eog(vocab, pending[c])) {
                            active[c] = false;
                            continue;
                        }
                        char piece[256];
                        const int n = llama_token_to_piece(vocab, pending[c], piece, sizeof(piece), 0, true);
                        if (n > 0) {
                            reply[c].append(piece, static_cast<std::size_t>(n));
                        }
                        ++gen_tokens;
                        b.token[k] = pending[c];
                        b.pos[k] = conv[c].pos++;
                        b.n_seq_id[k] = 1;
                        b.seq_id[k][0] = static_cast<llama_seq_id>(conv[c].slot);
                        b.logits[k] = true;
                        idx[c] = k++;
                    }
                    b.n_tokens = k;
                    if (k == 0) {
                        llama_batch_free(b);
                        break;
                    }
                    if (llama_decode(ctx, b)) {
                        std::cerr << "decode failed\n";
                        llama_batch_free(b);
                        return 1;
                    }
                    for (std::size_t c = 0; c < nc; ++c) {
                        if (idx[c] >= 0) {
                            pending[c] = llama_sampler_sample(smpl, ctx, idx[c]);
                        }
                    }
                    llama_batch_free(b);
                }
                const double gen_s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t_gen).count();
                for (std::size_t i = g0; i < g1; ++i) {
                    const std::size_t ci = static_cast<std::size_t>(ev.lines[i].first);
                    std::string clean = reply[ci];
                    for (const std::string mark : {"<channel|>", "</think>"}) {  // a thinking block some models emit anyway
                        if (const auto at = clean.rfind(mark); at != std::string::npos) {
                            clean = clean.substr(at + mark.size());
                        }
                    }
                    clean = trim(clean);
                    conv[ci].last_reply = clean;
                    conv[ci].role.push_back("assistant");
                    conv[ci].content.push_back(clean);
                    std::printf("[%s] joueur : %s\n[%s] %s\n\n", script.names[ci].c_str(), ev.lines[i].second.c_str(), script.names[ci].c_str(), clean.c_str());
                }
                std::fprintf(stderr, "[ws_moe_probe] round %d: %zu threads, prefill %.1f s, %zu tokens in %.1f s (%.2f tok/s total)\n",
                             round_no, g1 - g0, prefill_s, gen_tokens, gen_s, static_cast<double>(gen_tokens) / gen_s);
                std::fflush(stdout);
            }
        }
        std::fprintf(stderr, "[ws_moe_probe] threads: %zu, memory slots: %d | %zu sleeps (%.1f s, %.1f MiB written), %zu wakes (%.1f s) | %zu thread rebuilds\n",
                     nc, n_slots, n_sleeps, sleep_s, bytes_saved / (1024.0 * 1024.0), n_wakes, wake_s, realigns);
        if (ws_ram_mib > 0) {
            const auto& st = source.store.stats();
            std::fprintf(stderr, "[ws_moe_probe] WeightStream: %llu requests, %llu disk reads, %.1f MiB\n",
                         static_cast<unsigned long long>(st.requests), static_cast<unsigned long long>(st.disk_reads), st.disk_bytes / (1024.0 * 1024.0));
        }
#ifdef _WIN32
        {
            PROCESS_MEMORY_COUNTERS_EX pmc{};
            GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&pmc), sizeof(pmc));
            std::fprintf(stderr, "[ws_moe_probe] peak working set %.0f MiB | peak commit %.0f MiB | text hash script\n",
                         pmc.PeakWorkingSetSize / (1024.0 * 1024.0), pmc.PeakPagefileUsage / (1024.0 * 1024.0));
        }
#endif
        llama_sampler_free(smpl);
        llama_free(ctx);
        llama_model_free(model);
        llama_moe_set_expert_source(nullptr, nullptr);
        ggml_cpu_set_expert_fetch(nullptr, nullptr);
        return 0;
    }

    if (n_seqs > 1) {
        // N conversations on ONE loaded model (shared weights and expert caches, one KV per sequence): sequence 0
        // runs `prompt`, the others run `prompt2` (or `prompt` again). Decode steps carry one token per sequence.
        auto tokenize_chat = [&](const std::string& text) {
            std::string f = text;
            if (const char* tmpl = llama_model_chat_template(model, nullptr)) {
                llama_chat_message msg{"user", text.c_str()};
                std::vector<char> buf(text.size() * 2 + 4096);
                const int32_t need = llama_chat_apply_template(tmpl, &msg, 1, true, buf.data(), static_cast<int32_t>(buf.size()));
                if (need > 0 && need <= static_cast<int32_t>(buf.size())) {
                    f.assign(buf.data(), static_cast<std::size_t>(need));
                }
            }
            const int n = -llama_tokenize(vocab, f.c_str(), static_cast<int32_t>(f.size()), nullptr, 0, true, true);
            std::vector<llama_token> t(static_cast<std::size_t>(n));
            llama_tokenize(vocab, f.c_str(), static_cast<int32_t>(f.size()), t.data(), n, true, true);
            return t;
        };
        const std::size_t ns = static_cast<std::size_t>(n_seqs);
        std::vector<std::vector<llama_token>> ptoks(ns);
        std::vector<std::string> outs(ns);
        std::vector<llama_token> pending(ns);
        std::vector<llama_pos> pos(ns, 0);
        std::vector<bool> active(ns, true);
        for (std::size_t s = 0; s < ns; ++s) {
            ptoks[s] = tokenize_chat(s == 0 || prompt2.empty() ? prompt : prompt2);
        }
        auto emit = [&](std::size_t s, llama_token id) {
            char piece[256];
            const int n = llama_token_to_piece(vocab, id, piece, sizeof(piece), 0, true);
            if (n > 0) {
                outs[s].append(piece, static_cast<std::size_t>(n));
            }
        };
        const auto t0 = std::chrono::steady_clock::now();
        for (std::size_t s = 0; s < ns; ++s) {
            llama_batch b = llama_batch_init(static_cast<int32_t>(ptoks[s].size()), 0, 1);
            for (std::size_t i = 0; i < ptoks[s].size(); ++i) {
                b.token[i] = ptoks[s][i];
                b.pos[i] = static_cast<llama_pos>(i);
                b.n_seq_id[i] = 1;
                b.seq_id[i][0] = static_cast<llama_seq_id>(s);
                b.logits[i] = i + 1 == ptoks[s].size();
            }
            b.n_tokens = static_cast<int32_t>(ptoks[s].size());
            if (llama_decode(ctx, b)) {
                std::cerr << "prompt decode failed (seq " << s << ")\n";
                return 1;
            }
            pos[s] = static_cast<llama_pos>(ptoks[s].size());
            pending[s] = llama_sampler_sample(smpl, ctx, b.n_tokens - 1);
            llama_batch_free(b);
        }
        const double pp_all = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        const auto tg0 = std::chrono::steady_clock::now();
        std::size_t total_gen = 0;
        for (int step = 0; step < n_predict; ++step) {
            llama_batch b = llama_batch_init(static_cast<int32_t>(ns), 0, 1);
            std::vector<int32_t> idx(ns, -1);
            int32_t k = 0;
            for (std::size_t s = 0; s < ns; ++s) {
                if (!active[s]) {
                    continue;
                }
                if (llama_vocab_is_eog(vocab, pending[s])) {
                    active[s] = false;
                    continue;
                }
                emit(s, pending[s]);
                ++total_gen;
                if (step + 1 == n_predict) {
                    continue;  // last token of the budget: emitted, no need to decode it
                }
                b.token[k] = pending[s];
                b.pos[k] = pos[s]++;
                b.n_seq_id[k] = 1;
                b.seq_id[k][0] = static_cast<llama_seq_id>(s);
                b.logits[k] = true;
                idx[s] = k++;
            }
            b.n_tokens = k;
            if (k == 0) {
                llama_batch_free(b);
                break;
            }
            if (llama_decode(ctx, b)) {
                std::cerr << "decode failed\n";
                llama_batch_free(b);
                break;
            }
            for (std::size_t s = 0; s < ns; ++s) {
                if (idx[s] >= 0) {
                    pending[s] = llama_sampler_sample(smpl, ctx, idx[s]);
                }
            }
            llama_batch_free(b);
        }
        const double tg_all = std::chrono::duration<double>(std::chrono::steady_clock::now() - tg0).count();
        std::fprintf(stderr, "\n[ws_moe_probe] seqs %zu | prompts in %.1f s | gen %zu tok total in %.1f s (%.2f tok/s aggregate, %.2f tok/s per sequence) | cache %zu MiB\n",
                     ns, pp_all, total_gen, tg_all, total_gen / tg_all, total_gen / tg_all / static_cast<double>(ns), cache_mib);
        if (ws_ram_mib > 0) {
            const auto& st = source.store.stats();
            std::fprintf(stderr, "[ws_moe_probe] WeightStream: %llu requests, %llu disk reads, %.1f MiB\n",
                         static_cast<unsigned long long>(st.requests), static_cast<unsigned long long>(st.disk_reads), st.disk_bytes / (1024.0 * 1024.0));
        }
        for (std::size_t s = 0; s < ns; ++s) {
            unsigned long long h = 1469598103934665603ull;
            for (const unsigned char c : outs[s]) {
                h = (h ^ c) * 1099511628211ull;
            }
            std::fprintf(stderr, "[ws_moe_probe] seq %zu text hash %016llx\n", s, h);
            std::cout << "=== seq " << s << " ===\n" << outs[s] << "\n";
        }
#ifdef _WIN32
        {
            PROCESS_MEMORY_COUNTERS_EX pmc{};
            GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&pmc), sizeof(pmc));
            std::fprintf(stderr, "[ws_moe_probe] peak working set %.0f MiB | peak commit %.0f MiB | text hash multi\n",
                         pmc.PeakWorkingSetSize / (1024.0 * 1024.0), pmc.PeakPagefileUsage / (1024.0 * 1024.0));
        }
#endif
        llama_sampler_free(smpl);
        llama_free(ctx);
        llama_model_free(model);
        llama_moe_set_expert_source(nullptr, nullptr);
        ggml_cpu_set_expert_fetch(nullptr, nullptr);
        return 0;
    }

    const auto t_pp0 = std::chrono::steady_clock::now();
    llama_batch batch = llama_batch_get_one(toks.data(), n_prompt);
    if (llama_decode(ctx, batch)) {
        std::cerr << "prompt decode failed\n";
        return 1;
    }
    const double pp_s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t_pp0).count();

    std::string out;
    int n_gen = 0;
    const auto t_tg0 = std::chrono::steady_clock::now();
    ws::ExpertBudget budget(ws_ram_mib * 1024 * 1024);
    if (elastic_test && ws_ram_mib > 0) {
        budget.add(&source.store, "model", ws_ram_mib * 1024 * 1024);
    }
    for (; n_gen < n_predict; ++n_gen) {
        // between two tokens no fetch is running: the window may move (the text must not change)
        if (elastic_test && ws_ram_mib > 0 && (n_gen == n_predict / 3 || n_gen == 2 * n_predict / 3)) {
            const std::size_t total = n_gen == n_predict / 3 ? ws_ram_mib * 1024 * 1024 / 2 : ws_ram_mib * 1024 * 1024;
            if (!budget.set_total(total)) {
                std::cerr << "[ws_moe_probe] elastic: " << budget.error() << '\n';
            }
            std::fprintf(stderr, "[ws_moe_probe] elastic: token %d, expert cache now %zu MiB" "\n", n_gen,
                         source.store.capacity_bytes() / (1024 * 1024));
        }
        const llama_token id = llama_sampler_sample(smpl, ctx, -1);
        if (llama_vocab_is_eog(vocab, id)) {
            break;
        }
        char piece[256];
        const int n = llama_token_to_piece(vocab, id, piece, sizeof(piece), 0, true);
        if (n > 0) {
            out.append(piece, static_cast<std::size_t>(n));
        }
        llama_token next = id;
        batch = llama_batch_get_one(&next, 1);
        if (llama_decode(ctx, batch)) {
            std::cerr << "decode failed\n";
            break;
        }
    }
    const double tg_s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t_tg0).count();

    std::cout << out << "\n";
    std::fprintf(stderr, "\n[ws_moe_probe] load %.1f s | prompt %d tok in %.1f s (%.2f tok/s) | gen %d tok in %.1f s (%.2f tok/s) | cache %zu MiB\n",
                 load_s, n_prompt, pp_s, n_prompt / pp_s, n_gen, tg_s, n_gen > 0 ? n_gen / tg_s : 0.0, cache_mib);

    if (ws_ram_mib > 0) {
        const auto& st = source.store.stats();
        const double hit = st.requests > 0 ? 100.0 * static_cast<double>(st.ram_hits) / static_cast<double>(st.requests) : 0.0;
        std::fprintf(stderr, "[ws_moe_probe] prefetch: %llu experts read ahead, %llu used (%.1f%% of requests) | grouped reads %llu | lookahead calls %llu (%.1f experts each) | resizes %llu" "\n",
                     static_cast<unsigned long long>(st.prefetch_reads), static_cast<unsigned long long>(st.prefetch_hits),
                     st.requests > 0 ? 100.0 * static_cast<double>(st.prefetch_hits) / static_cast<double>(st.requests) : 0.0,
                     static_cast<unsigned long long>(st.group_reads), static_cast<unsigned long long>(source.lookahead_calls),
                     source.lookahead_calls > 0 ? static_cast<double>(source.lookahead_experts) / static_cast<double>(source.lookahead_calls) : 0.0,
                     static_cast<unsigned long long>(st.resizes));
        std::fprintf(stderr, "[ws_moe_probe] WeightStream: %llu requests, RAM hit %.1f%%, %llu disk reads, %.1f MiB in %.2f s (%.2f GiB/s)\n",
                     static_cast<unsigned long long>(st.requests), hit, static_cast<unsigned long long>(st.disk_reads),
                     st.disk_bytes / (1024.0 * 1024.0), st.disk_seconds,
                     st.disk_seconds > 0 ? st.disk_bytes / (1024.0 * 1024.0 * 1024.0) / st.disk_seconds : 0.0);
    }

#ifdef _WIN32
    {
        PROCESS_MEMORY_COUNTERS_EX pmc{};
        GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&pmc), sizeof(pmc));
        unsigned long long h = 1469598103934665603ull;  // FNV-1a of the generated text, to compare runs at a glance
        for (const unsigned char c : out) {
            h = (h ^ c) * 1099511628211ull;
        }
        std::fprintf(stderr, "[ws_moe_probe] peak working set %.0f MiB | peak commit %.0f MiB | text hash %016llx\n",
                     pmc.PeakWorkingSetSize / (1024.0 * 1024.0), pmc.PeakPagefileUsage / (1024.0 * 1024.0), h);
    }
#endif

    llama_sampler_free(smpl);
    llama_free(ctx);
    llama_model_free(model);
    llama_moe_set_expert_source(nullptr, nullptr);
    ggml_cpu_set_expert_fetch(nullptr, nullptr);
    return 0;
}
