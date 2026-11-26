// ws_npc_server: a small local service around one loaded model.
//   - OpenAI-compatible /v1/chat/completions (+ /health, /props, /v1/models) so a client written for llama-server
//     (like a game) can point at it; the client sends whole conversations, the service keeps one KV cache per
//     conversation ("thread") and only prefills what changed since the last request (prefix reuse).
//   - /api/characters: character sheets (system prompt + persistent history), chat with them by name.
//   - Resources can be changed while running: number of in-memory threads (slots), context size, VRAM expert cache,
//     RAM expert cache, and the whole model can be suspended (VRAM and RAM given back, threads saved to disk) and
//     resumed, which is what an image generator sharing the GPU needs.
// Threads that do not fit in memory sleep on disk (their KV cache is saved) and wake up when asked again.
// With --ws-ram-mib the MoE experts are streamed from the SSD by WeightStream; without it this is a plain
// llama.cpp server (any model, dense ones included).
#include "WeightStream/ExpertSheets.h"
#include "WeightStream/GGUFReader.h"
#include "WeightStream/ExpertStore.h"
#include "chat.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "ggml.h"
#include "llama-ext.h"
#include "llama.h"

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <atomic>
#include <optional>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <thread>
#include <cctype>
#include <cmath>
#include <csignal>
#include <cstring>
#include <ctime>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <mutex>
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
#include <io.h>
#pragma comment(lib, "psapi.lib")
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace {

// Live text of the /v1 requests that carry tools: for those the OpenAI stream is held back until the answer is whole (a tool call only
// makes sense complete), so a client that wants to SHOW the answer while it is written reads it from GET /api/jobs/<ws_job>/live.
struct LiveText {
    std::mutex m;
    std::string text;
};
std::mutex g_live_mx;
std::map<std::string, std::shared_ptr<LiveText>> g_live;

void log_quiet(ggml_log_level level, const char* text, void*) {
    static const bool all = std::getenv("WS_VERBOSE") != nullptr;
    if (all || level >= GGML_LOG_LEVEL_WARN) {
        std::fputs(text, stderr);
    }
}

struct Config {
    std::string model;
    std::string chat_template_file;
    std::string data_dir = "ws_npc_data";
    std::string kv_type_k = "f16", kv_type_v = "f16";  // KV cache precision: f16 (default), q8_0 (half the size), q4_0 (a quarter)
    std::string models_dir;  // where the model selector looks for .gguf files (default: the folder of the starting model)
    std::string host = "127.0.0.1";
    int port = 8770;
    bool swa_full = true;  // --swa-full 0 : sliding-window layers keep only their window (much less KV VRAM per slot)
    int slots = 2;       // threads kept in memory (KV caches); the others sleep on disk
    int n_ctx = 4096;    // context size of one thread
    int ubatch = 32;     // <= 32 sends prompt processing through the expert cache too (frugal but slow prefill)
    bool light = false;  // "ultra" profile: tiny micro-batch, small context, quantized KV, working set trimmed after load and after each answer
    bool bulk_prefill = true;  // a big prefill batch streams whole expert tensors from the SSD (sequential reads, read ahead) instead of expert by expert
    int prefill_ubatch = 4096;  // big prompts are prefilled with this micro-batch (fast, needs RAM for a while), then back to `ubatch`; 0 = off
    std::size_t cache_mib = 0;       // llama.cpp VRAM expert cache
    std::size_t ws_ram_mib = 0;      // WeightStream RAM expert cache (0 = plain llama.cpp, no streaming)
    std::size_t ws_max_mib = 16384;  // ceiling for later resizes of the RAM cache
    std::size_t margin_mib = 0;       // memory governor: centre of the comfort band of available RAM (0 = governor off)
    std::size_t margin_user_mib = 0;  // margin asked by the user (--mem-margin-mib / UI); 0 = the profile decides
    int gear = 0;                     // memory gear: 0 = auto (follows what the rest of the machine is doing), 1 (calm) .. 6 (furious)
    bool gear_user = false;           // gear chosen by the user (otherwise the adaptive profile picks one)
    bool cpu_stream = false;         // experts computed on the CPU from the RAM cache (no VRAM cache)
    std::string profile_auto;        // name of the adaptive profile whose sizes were computed (empty: fixed sizes)
    std::string profile_req;         // --profile NAME, applied once the backends are loaded
    std::size_t pal_max_user_mib = 0;  // "paliers": --ws-max-mib asked by the user (0 = the biggest step, 16000)
    std::size_t crit_mib = 0;          // "paliers": free RAM under which a running generation is paused (--mem-critical-mib; 0 = max(1500, hard floor))
};

// A GGUF split in several files ("name-00001-of-00003.gguf") counts as one model: the first file stands for the whole.
// returns the shard number (1 for a plain file), 0 if `name` is not a shard name
int shard_number(const std::string& name, int* total = nullptr) {
    const std::size_t k = name.rfind("-of-");
    if (k == std::string::npos || k < 6 || name.size() != k + 4 + 5 + 5 || name.compare(name.size() - 5, 5, ".gguf") != 0 ||
        name[k - 6] != '-') {
        return 1;
    }
    try {
        if (total) {
            *total = std::stoi(name.substr(k + 4, 5));
        }
        return std::stoi(name.substr(k - 5, 5));
    } catch (const std::exception&) {
        return 1;
    }
}

// size of everything that is not a routed-expert tensor (attention, shared experts, embeddings...): what the process needs
// in memory besides the expert caches. Read from the GGUF headers.
std::uintmax_t non_expert_bytes(const fs::path& path) {
    int total = 1;
    const std::string name = path.filename().string();
    std::vector<fs::path> files;
    if (shard_number(name, &total) == 1 && total > 1) {
        for (int i = 1; i <= total; ++i) {
            char suffix[32];
            std::snprintf(suffix, sizeof(suffix), "-%05d-of-%05d.gguf", i, total);
            files.push_back(path.parent_path() / (name.substr(0, name.size() - 20) + suffix));
        }
    } else {
        files.push_back(path);
    }
    std::uintmax_t sum = 0;
    for (const auto& f : files) {
        ws::GGUFReader reader(f);
        if (!reader.valid()) {
            return 0;
        }
        for (const auto& t : reader.tensors()) {
            if (!(t.name.find("_exps") != std::string::npos && t.dimensions.size() == 3)) {
                sum += t.size;
            }
        }
    }
    return sum;
}

// total size of the model file(s) starting at `path`
std::uintmax_t model_bytes(const fs::path& path) {
    std::error_code ec;
    int total = 1;
    const std::string name = path.filename().string();
    if (shard_number(name, &total) != 1 || total <= 1) {
        return fs::file_size(path, ec);
    }
    std::uintmax_t sum = 0;
    for (int i = 1; i <= total; ++i) {
        char suffix[32];
        std::snprintf(suffix, sizeof(suffix), "-%05d-of-%05d.gguf", i, total);
        sum += fs::file_size(path.parent_path() / (name.substr(0, name.size() - 20) + suffix), ec);
    }
    return sum;
}

// resource profiles (same as the launcher): RAM expert cache / VRAM expert cache in MB
struct ProfileDef {
    const char* name;
    const char* label;
    std::size_t ram_mib, vram_mib;
    bool cpu;
    int autom = 0;  // 1 = "partage", 2 = "fond": sizes computed from the free RAM / VRAM when the profile is applied
    bool light = false;  // "ultra" / "leger": see Config::light
    bool hidden = false;  // kept for the decider model and old settings, not offered in the menus
    int ctx = 2048;       // context of one thread (light profiles)
    bool lean = false;    // "partage" / "fond": micro-batch of 4, no fast prefill, q8 KV (the context size and the threads stay as they are)
};
const ProfileDef kProfiles[] = {
    {"eco", "Eco (ancien, remplacé par Léger et Ultra) : caches d'experts 0,7 Go RAM / 0,5 Go VRAM, lots de 32 jetons", 700, 512, false, 0, false, true},
    {"leger", "Léger : caches d'experts 1,5 Go RAM / 1,5 Go VRAM, lots de 4 jetons, contexte 2048, 1 fil, KV q8 (~4 jetons/s, ~4 Go de VRAM, RAM de travail ~3,5 Go)", 1500, 1536, false, 0, true},
    {"ultra", "Ultra léger : caches d'experts 0,7 Go RAM / 0,5 Go VRAM, lots de 4 jetons, contexte 2048, 1 fil, KV q8 (très lent, surtout à la lecture du prompt, mais RAM et VRAM minimales)", 700, 512, false, 0, true},
    {"equilibre", "Équilibre : caches d'experts 2 Go RAM / 3 Go VRAM, lots de 4 jetons, contexte 4096, 1 fil, KV q8 (~8-10 jetons/s, ~5 Go de VRAM, RAM de travail ~4 Go)", 2000, 3072, false, 0, true, false, 4096},
    {"vif", "Vif : caches d'experts 3 Go RAM / 4 Go VRAM, lots de 4 jetons, contexte 4096, 1 fil, KV q8 (~12-15 jetons/s, ~6 Go de VRAM, RAM de travail ~5 Go)", 3000, 4096, false, 0, true, false, 4096},
    {"normal", "Normal : caches d'experts 3 Go RAM / 1 Go VRAM", 3000, 1024, false},
    {"confort", "Confort : caches d'experts 6 Go RAM / 2 Go VRAM (plus rapide)", 6000, 2048, false},
    {"cpu", "CPU seul : experts calculés sur le CPU, pas de VRAM", 3000, 0, true},
    {"partage", "Partagé : s'adapte aux ressources libres, laisse ~8 Go de RAM et ~1,5 Go de VRAM aux autres programmes", 0, 0, false, 1, false, false, 2048, true},
    {"fond", "À fond : prend presque tout (réserve ~4 Go de RAM pour Windows) ; fermer les programmes voisins aide", 0, 0, false, 2, false, false, 2048, true},
    {"paliers", "Paliers : la taille du cache RAM (4, 6, 8, 10, 12 ou 16 Go) est choisie une fois au début de chaque requête d'après la RAM libre (en gardant une marge, ~4 Go), puis ne bouge plus jusqu'à la fin de la génération ; RAM critique = pause avec point de reprise", 0, 0, false, 3},
    {"plain", "Classique : llama.cpp ordinaire, sans streaming (modèles denses ou qui tiennent en mémoire)", 0, 0, false},
};

// RAM the system could give to a program right now (free + reclaimable cache), in MiB
double available_mib() {
#ifdef _WIN32
    MEMORYSTATUSEX ms;
    ms.dwLength = sizeof(ms);
    if (GlobalMemoryStatusEx(&ms)) {
        return static_cast<double>(ms.ullAvailPhys) / 1048576.0;
    }
#endif
    return 8192.0;
}

// RAM this process holds right now (pages in its working set), in MiB
double our_ws_mib() {
#ifdef _WIN32
    PROCESS_MEMORY_COUNTERS pmc;
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc))) {
        return static_cast<double>(pmc.WorkingSetSize) / 1048576.0;
    }
#endif
    return 0.0;
}

double total_mib_now() {
#ifdef _WIN32
    MEMORYSTATUSEX ms;
    ms.dwLength = sizeof(ms);
    if (GlobalMemoryStatusEx(&ms)) {
        return static_cast<double>(ms.ullTotalPhys) / 1048576.0;
    }
#endif
    return 16384.0;
}

// Memory gears: how much of the machine the model may take. A gear is the RAM left to the other programs (a share of the machine's
// RAM) and the VRAM left free. Gear 1 leaves half the machine alone, gear 6 squeezes down to ~6 % of it; in between the margin is
// interpolated, so the auto mode can sit on any value from 1 to 6. Whatever the gear, the system is never starved: see hard_floor_mib.
constexpr double kGearFrac[6] = {0.50, 0.38, 0.27, 0.18, 0.11, 0.065};
constexpr double kGearVram[6] = {2500, 2000, 1500, 1000, 500, 300};

// available RAM under which everything gets pushed back (the cache shrinks fast and pauses are inserted) in every gear
double hard_floor_mib(double total_mib) { return std::max(1200.0, total_mib * 0.035); }

double gear_margin_mib(double total_mib, double gear) {
    const double g = std::min(6.0, std::max(1.0, gear)) - 1.0;
    const int i = std::min(4, static_cast<int>(g));
    const double f = g - i;
    const double frac = std::exp(std::log(kGearFrac[i]) * (1.0 - f) + std::log(kGearFrac[i + 1]) * f);
    return std::max(frac * total_mib, hard_floor_mib(total_mib) * 1.8);
}

// memory promised to the decider model (second engine), taken off what the adaptive profile of the main model sees as free
double g_reserved_ram_mib = 0, g_reserved_vram_mib = 0;

// Sizes the expert caches of an adaptive profile from what is free right now (best effort). "partage" leaves room for the other
// programs, "fond" keeps only a fixed RAM reserve so the system stays responsive. Both are capped by the model size.
void apply_adaptive(Config& cfg, int mode) {
    double avail_mib = 8192, total_mib = 16384;
#ifdef _WIN32
    MEMORYSTATUSEX ms;
    ms.dwLength = sizeof(ms);
    if (GlobalMemoryStatusEx(&ms)) {
        avail_mib = static_cast<double>(ms.ullAvailPhys) / 1048576.0;
        total_mib = static_cast<double>(ms.ullTotalPhys) / 1048576.0;
    }
#endif
    double vram_free_mib = 0;
    for (std::size_t i = 0; i < ggml_backend_dev_count(); ++i) {
        ggml_backend_dev_t d = ggml_backend_dev_get(i);
        if (ggml_backend_dev_type(d) == GGML_BACKEND_DEVICE_TYPE_GPU) {
            std::size_t f = 0, t = 0;
            ggml_backend_dev_memory(d, &f, &t);
            vram_free_mib = static_cast<double>(f) / 1048576.0;
            break;
        }
    }
    avail_mib = std::max(0.0, avail_mib - g_reserved_ram_mib);
    vram_free_mib = std::max(0.0, vram_free_mib - g_reserved_vram_mib);
    std::error_code ec;
    const double model_mib = cfg.model.empty() ? 1e9 : static_cast<double>(model_bytes(cfg.model)) / 1048576.0;
    // room left to the rest of the system: a share of the machine's RAM (so it scales), plus the process's own memory besides the
    // expert cache (non-expert weights, buffers, KV). No fixed ceiling on the cache: it takes what is left, up to the model size.
    // the process holds the non-expert weights (mapped pages) plus ~1 GB of buffers / KV besides the expert cache; 2.5 GB if unknown
    const double non_expert_mib = cfg.model.empty() ? 0.0 : static_cast<double>(non_expert_bytes(cfg.model)) / 1048576.0;
    const double own_ram_mib = non_expert_mib > 0 ? non_expert_mib + 1000 : 2500;
    if (!cfg.gear_user) {
        cfg.gear = mode == 2 ? 6 : 0;  // "partage" = auto, "fond" = full gear, unless the user picked one
    }
    const double start_gear = cfg.gear == 0 ? 3.0 : static_cast<double>(cfg.gear);  // auto starts in the middle
    const double margin_mib = cfg.margin_user_mib > 0 ? static_cast<double>(cfg.margin_user_mib) : gear_margin_mib(total_mib, start_gear);
    const double ram_reserve = margin_mib + own_ram_mib;
    const double vram_reserve = kGearVram[std::min(5, std::max(0, static_cast<int>(start_gear + 0.5) - 1))];  // besides the ~1.7 GB the non-expert weights and buffers take
    double ram = std::min(avail_mib - ram_reserve, model_mib * 0.9);
    // never below what one layer of a large MoE needs (~1.6 GB for 128 experts of 12 MB): a cache that is too small for one fetch makes
    // the engine fall back to reading the mapped file directly, which swallows the RAM
    ram = std::max(ram, std::min(2000.0, model_mib * 0.5));
    cfg.ws_ram_mib = static_cast<std::size_t>(ram);
    // the governor (Engine::governor_tick) keeps the available RAM around the margin by growing / shrinking the cache in this range
    cfg.margin_mib = static_cast<std::size_t>(margin_mib);
    cfg.ws_max_mib = static_cast<std::size_t>(std::max(ram, std::min(model_mib * 0.9, total_mib * 0.85)));  // address space only: committed as the governor grows
    if (vram_free_mib < 2500) {
        cfg.cpu_stream = true;  // no usable GPU memory: experts computed on the CPU
        cfg.cache_mib = 0;
    } else {
        // what the process holds besides the expert cache (measured on Gemma 4: 1.57 GB of weights + KV + ~0.5 GB of compute buffers and CUDA context);
        // the KV is ~0.215 MiB per token and thread in f16 for Gemma 4 (full-size sliding-window cache), half of that in q8
        const bool kv_q8 = cfg.kv_type_k == "q8_0";
        const double kv_mib = static_cast<double>(cfg.n_ctx) * cfg.slots * 0.215 * (kv_q8 ? 0.53 : 1.0);
        const double own_vram_mib = (non_expert_mib > 0 ? non_expert_mib : 1500.0) + kv_mib + 500.0;
        // never run the card to the last megabyte: the driver then pages to system memory and generation drops
        double v = std::min(vram_free_mib - own_vram_mib - std::max(vram_reserve, 500.0), model_mib * 0.5);
        cfg.cpu_stream = false;
        cfg.cache_mib = static_cast<std::size_t>(std::max(v, 512.0));
    }
}


// ---- "paliers": the RAM expert cache takes one of a few sizes, chosen once at the start of each request ----
constexpr double kPalSteps[] = {4000, 6000, 8000, 10000, 12000, 16000};  // MiB
constexpr double kPalHyst = 1000;                                          // MiB: a step up needs the next step plus this much of room
constexpr double kPalMargin = 4096;                                        // MiB of free RAM kept when the user gave no --mem-margin-mib

// free RAM (MiB) seen by the "paliers" logic. Test hook: WS_PAL_FREE_FILE=<file holding a number> replaces the real value
// (read at every decision, so a test can change it between two messages without starting anything heavy).
double pal_avail_mib() {
    if (const char* f = std::getenv("WS_PAL_FREE_FILE")) {
        if (std::ifstream in(f); in) {
            double v = -1;
            if (in >> v && v >= 0) {
                return v;
            }
        }
    }
    return available_mib();
}

// the steps usable for a model: the ones <= maxp (user ceiling, 90 % of the model), the useful ceiling itself when it is lower than the
// biggest step, and a floor step under 4000 (used only when even 4000 would break the margin)
std::vector<double> pal_levels(double user_max_mib, double model_mib) {
    const double usercap = user_max_mib > 0 ? user_max_mib : kPalSteps[5];
    const double useful = model_mib * 0.9;
    const double maxp = std::min(usercap, useful);
    std::vector<double> v;
    for (const double st : kPalSteps) {
        if (st <= maxp) {
            v.push_back(st);
        }
    }
    if (v.empty() || (useful < usercap && v.back() < maxp)) {
        v.push_back(maxp);
    }
    const double floor_mib = std::max(1000.0, std::min(2000.0, model_mib * 0.5));
    if (floor_mib < v.front()) {
        v.insert(v.begin(), floor_mib);
    }
    return v;
}

// highest step the budget allows; with hysteresis against `cur` (0 = none yet): never shrinks unless the budget fell under `cur`,
// grows only to a step whose size + kPalHyst fits in the budget. dir: -1 down, 0 same, +1 up
double pal_choose(const std::vector<double>& lv, double budget_mib, double cur, int* dir) {
    double cand = lv.front();
    for (const double l : lv) {
        if (l <= budget_mib) {
            cand = l;
        }
    }
    double r = cand;
    if (cur > 0) {
        r = cur;
        if (cand < cur) {
            r = cand;  // the margin is not respected any more: down
        } else {
            for (const double l : lv) {
                if (l > cur && l + kPalHyst <= budget_mib) {
                    r = l;
                }
            }
        }
    }
    if (dir) {
        *dir = r > cur && cur > 0 ? 1 : (r < cur ? -1 : 0);
    }
    return r;
}

// applies "paliers" to `cfg` (cfg.model set): VRAM cache as the adaptive profiles compute it unless the user gave one, RAM cache = the first step
void apply_paliers(Config& cfg) {
    const std::size_t user_cache = cfg.cache_mib;
    const bool user_cpu = cfg.cpu_stream;
    apply_adaptive(cfg, 1);
    if (user_cache > 0) {
        cfg.cache_mib = user_cache;
        cfg.cpu_stream = user_cpu;
    }
    const double model_mib = cfg.model.empty() ? 1e9 : static_cast<double>(model_bytes(cfg.model)) / 1048576.0;
    const double non_expert_mib = cfg.model.empty() ? 0.0 : static_cast<double>(non_expert_bytes(cfg.model)) / 1048576.0;
    const double own = non_expert_mib > 0 ? non_expert_mib + 1000 : 2500;
    const double margin = cfg.margin_user_mib > 0 ? static_cast<double>(cfg.margin_user_mib) : kPalMargin;
    const auto lv = pal_levels(static_cast<double>(cfg.pal_max_user_mib), model_mib);
    cfg.ws_ram_mib = static_cast<std::size_t>(pal_choose(lv, std::max(0.0, pal_avail_mib() - g_reserved_ram_mib - margin - own), 0, nullptr));
    cfg.ws_max_mib = static_cast<std::size_t>(lv.back());  // address space only
    cfg.margin_mib = 0;  // no governor: the size changes only between two requests (Engine::paliers_decide)
}

// applies profile `pd` to `cfg` (cfg.model must be set for the adaptive ones)
void apply_profile(Config& cfg, const ProfileDef& pd) {
    cfg.profile_auto.clear();
    // "ultra" changes more than the caches; any other profile gives the previous values back
    struct Saved { int ubatch, prefill_ubatch, n_ctx, slots; std::string kk, kv; };
    static std::map<const Config*, Saved> saved_by;  // one entry per engine (the decider has its own Config)
    std::optional<Saved> saved;
    if (const auto it = saved_by.find(&cfg); it != saved_by.end()) {
        saved = it->second;
    }
    if (pd.light || pd.lean) {
        if (!saved) {
            saved = Saved{cfg.ubatch, cfg.prefill_ubatch, cfg.n_ctx, cfg.slots, cfg.kv_type_k, cfg.kv_type_v};
        }
        cfg.ubatch = 4;
        cfg.prefill_ubatch = 0;
        cfg.kv_type_k = cfg.kv_type_v = "q8_0";
        if (pd.light) {
            cfg.n_ctx = pd.ctx;
            cfg.slots = 1;
        } else if (saved) {
            cfg.n_ctx = saved->n_ctx;  // lean keeps the context and the threads of before
            cfg.slots = saved->slots;
        }
    } else if (saved) {
        cfg.ubatch = saved->ubatch;
        cfg.prefill_ubatch = saved->prefill_ubatch;
        cfg.n_ctx = saved->n_ctx;
        cfg.slots = saved->slots;
        cfg.kv_type_k = saved->kk;
        cfg.kv_type_v = saved->kv;
        saved.reset();
        saved_by.erase(&cfg);
    }
    if (saved) {
        saved_by[&cfg] = *saved;
    }
    cfg.light = pd.light;
    if (pd.autom == 3) {
        apply_paliers(cfg);
        cfg.profile_auto = pd.name;
        return;
    }
    if (pd.autom) {
        apply_adaptive(cfg, pd.autom);
        cfg.profile_auto = pd.name;
        return;
    }
    cfg.ws_ram_mib = pd.ram_mib;
    cfg.cache_mib = pd.vram_mib;
    cfg.cpu_stream = pd.cpu;
    cfg.margin_mib = cfg.margin_user_mib;  // fixed profile: governor only if the user asked for a margin
}

struct ExpertSource {
    ws::ExpertStore store;
    std::vector<ws::ExpertStore::Request> requests;
    bool failed = false;
    // routing seen by the CPU-stream hook, for the expert sheets (the GPU-cache path uses llama.cpp's observer)
    std::function<void(int layer, const std::int32_t* ids, std::size_t n_ids)> route;
};

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
        src->failed = true;
        return false;
    }
    for (size_t i = 0; i < n_reads; ++i) {
        reads[i].data = src->requests[i].data;
    }
    return true;
}

void serve_prefetch(void* user, int32_t il, const int32_t* experts, size_t n) {
    static_cast<ExpertSource*>(user)->store.prefetch(il, experts, n);
}

bool serve_bulk(void* user, const char* name, size_t offset, size_t nbytes, void* dst, size_t cap, size_t* skew) {
    return static_cast<ExpertSource*>(user)->store.bulk_read(name, offset, nbytes, dst, cap, skew);
}

bool serve_cpu_experts(void* user, const ggml_tensor* op, const int32_t* experts, int n_experts, const void** out) {
    auto* src = static_cast<ExpertSource*>(user);
    const ggml_tensor* w = op->src[0];
    src->requests.resize(static_cast<std::size_t>(n_experts));
    for (int i = 0; i < n_experts; ++i) {
        src->requests[static_cast<std::size_t>(i)] = {w->name, experts[i], static_cast<std::size_t>(w->nb[2]), nullptr};
    }
    if (!src->store.fetch(src->requests.data(), static_cast<std::size_t>(n_experts))) {
        src->failed = true;
        return false;
    }
    for (int i = 0; i < n_experts; ++i) {
        out[i] = src->requests[static_cast<std::size_t>(i)].data;
    }
    // the three expert matrices of a layer see the same routing: count it once, on the "down" one
    if (src->route && std::strstr(w->name, "ffn_down_exps") != nullptr) {
        const ggml_tensor* ids = op->src[2];
        if (ids->type == GGML_TYPE_I32) {
            std::vector<std::int32_t> flat;
            for (std::int64_t t = 0; t < ids->ne[1]; ++t) {
                const auto* row = reinterpret_cast<const std::int32_t*>(static_cast<const char*>(ids->data) + static_cast<std::size_t>(t) * ids->nb[1]);
                flat.insert(flat.end(), row, row + ids->ne[0]);
            }
            src->route(layer_of_name(w->name), flat.data(), flat.size());
        }
    }
    return true;
}

struct Sampling {
    float temperature = 0.8f;
    int top_k = 40;
    float top_p = 0.95f;
    float min_p = 0.05f;
    float repeat_penalty = 1.0f, presence_penalty = 0.0f, frequency_penalty = 0.0f;
    int penalty_last_n = 64;
    float dry_multiplier = 0.0f, dry_base = 1.75f;
    int dry_allowed_length = 2, dry_penalty_last_n = -1;
    std::vector<std::string> dry_breakers = {"\n", ":", "\"", "*"};
    std::uint32_t seed = LLAMA_DEFAULT_SEED;
    int max_tokens = 1 << 30;  // unlimited: ends with the answer, or when the context is full
    std::vector<std::string> stop;
    bool enable_thinking = false;
    json tools;  // OpenAI "tools" array (agentic clients): the model may answer with tool_calls
    std::string tool_choice = "auto";
    bool parallel_tool_calls = false;
    bool has_tools() const { return tools.is_array() && !tools.empty() && tool_choice != "none"; }
    int reserve = 0;     // tokens kept free for the answer when checking that the prompt fits (chat route)
    std::string domain;  // label under which the experts used by this request are recorded in the expert sheets
    std::function<void(const float*, int)> peek;  // called with the logits of the first token to generate, just before it is sampled (/v1/decide)
};

Sampling parse_sampling(const json& b) {
    Sampling s;
    if (b.contains("domain") && b["domain"].is_string()) {
        s.domain = b["domain"].get<std::string>();
    }
    auto num = [&](const char* k, auto& dst) {
        if (b.contains(k) && b[k].is_number()) {
            dst = static_cast<std::decay_t<decltype(dst)>>(b[k].get<double>());
        }
    };
    num("temperature", s.temperature);
    num("top_k", s.top_k);
    num("top_p", s.top_p);
    num("min_p", s.min_p);
    num("repeat_penalty", s.repeat_penalty);
    num("presence_penalty", s.presence_penalty);
    num("frequency_penalty", s.frequency_penalty);
    num("repeat_last_n", s.penalty_last_n);
    num("dry_multiplier", s.dry_multiplier);
    num("dry_base", s.dry_base);
    num("dry_allowed_length", s.dry_allowed_length);
    num("dry_penalty_last_n", s.dry_penalty_last_n);
    num("seed", s.seed);
    num("max_tokens", s.max_tokens);
    if (b.contains("n_predict") && b["n_predict"].is_number()) {
        s.max_tokens = b["n_predict"].get<int>();
    }
    if (b.contains("dry_sequence_breakers") && b["dry_sequence_breakers"].is_array()) {
        s.dry_breakers.clear();
        for (const auto& x : b["dry_sequence_breakers"]) {
            if (x.is_string()) {
                s.dry_breakers.push_back(x.get<std::string>());
            }
        }
    }
    if (b.contains("stop")) {
        if (b["stop"].is_string()) {
            s.stop.push_back(b["stop"].get<std::string>());
        } else if (b["stop"].is_array()) {
            for (const auto& x : b["stop"]) {
                if (x.is_string()) {
                    s.stop.push_back(x.get<std::string>());
                }
            }
        }
    }
    if (b.contains("enable_thinking") && b["enable_thinking"].is_boolean()) {
        s.enable_thinking = b["enable_thinking"].get<bool>();
    }
    if (b.contains("tools") && b["tools"].is_array()) {
        s.tools = b["tools"];
    }
    if (b.contains("tool_choice") && b["tool_choice"].is_string()) {
        s.tool_choice = b["tool_choice"].get<std::string>();
    }
    if (b.contains("parallel_tool_calls") && b["parallel_tool_calls"].is_boolean()) {
        s.parallel_tool_calls = b["parallel_tool_calls"].get<bool>();
    }
    if (s.max_tokens <= 0) {
        s.max_tokens = 1 << 30;  // -1 = unlimited, as in llama-server
    }
    return s;
}

// number of leading bytes of `s` that do not end in the middle of a UTF-8 character
std::size_t utf8_complete_prefix(const std::string& s) {
    const std::size_t n = s.size();
    for (std::size_t back = 1; back <= 3 && back <= n; ++back) {
        const unsigned char c = static_cast<unsigned char>(s[n - back]);
        if ((c & 0xC0) == 0x80) {
            continue;  // continuation byte: keep looking for its lead byte
        }
        const std::size_t need = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1;
        return need > back ? n - back : n;
    }
    return n;
}

struct Thread {
    std::vector<llama_token> tokens;  // what the KV cache holds for this thread
    int slot = -1;
    bool has_state = false;  // a saved KV cache exists on disk
    std::uint64_t last_used = 0;
};

struct GenResult {
    std::string text;
    std::string finish = "stop";
    int prompt_tokens = 0, reused_tokens = 0, completion_tokens = 0;
    double prefill_s = 0.0, gen_s = 0.0;
    bool overflow = false;
    int shifts = 0;  // times the context was shifted (oldest exchanges dropped) while generating
    bool boosted = false;  // the prompt went through the fast (big micro-batch) prefill
    bool memory_pause = false;   // "paliers": stopped because the free RAM fell under the critical threshold (a job keeps a resume point)
    double pal_mib = 0, pal_free_mib = 0;  // "paliers": step chosen at the start of the request, free RAM measured then
};

struct DecideStats {
    int full_tokens = 0;  // tokens of all the prompts together
    int new_tokens = 0;   // tokens really sent through the model (the rest was already in the KV cache or shared)
    int passes = 0;       // decode calls (one per group of questions)
};

void trim_working_set() {
#ifdef _WIN32
    EmptyWorkingSet(GetCurrentProcess());  // mapped model pages go back to the standby list (still cached, no longer counted)
#endif
}

double now_s() {
    return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

void observe_routing(void* user, int32_t il, const int32_t* ids, size_t n_ids);

// llama.cpp's expert hooks are process-wide: with two engines (main model + decider) every decode takes this lock and points the
// hooks at its own ExpertStore first. Recursive: loading a model takes it, then binds.
std::recursive_mutex g_decode_mx;
// Decisions (/v1/decide) go first: while one is running or waiting, the other threads hold back before their next decode call, so a
// dialogue generation does not slow the decision down by interleaving with it token by token.
std::atomic<int> g_decide_pending{0};
thread_local bool t_decide_thread = false;
struct DecidePriority {
    DecidePriority() {
        t_decide_thread = true;
        ++g_decide_pending;
    }
    ~DecidePriority() {
        --g_decide_pending;
        t_decide_thread = false;
    }
};

// A long background generation ("job"): every generated token goes to a journal, the KV cache is checkpointed
// periodically, so an interrupted job restarts from its last checkpoint instead of from zero.
struct JobHook {
    std::vector<llama_token> prior;  // tokens generated before an interruption: appended to the prompt on resume
    std::string prior_text;          // their text (filled by generate)
    std::atomic<bool>* pause = nullptr;
    double checkpoint_s = 300.0;
    int max_prefill = 0;  // >0: at most that many prompt tokens are prefilled per call (finish "prefill_partial" = call again): lets the caller work in small slices
    bool prewarm = false;  // read the prompt with the big micro-batch, but stop between two batches as soon as a dialogue / decision / suspend waits (finish "prefill_partial")
    std::function<void(llama_token)> on_token;
    std::function<void()> sync;                             // journal made durable just before a checkpoint
    std::function<void(const std::string&)> on_checkpoint;  // text produced so far
};

class Engine {
public:
    explicit Engine(Config c) : cfg(std::move(c)) {}

    Config cfg;
    std::mutex mx;
    // Keeps the available RAM inside a comfort band around cfg.margin_mib: the expert cache shrinks (faster) when the system runs short
    // and grows back (slowly, ~10 % per step) when there is room; under real pressure short pauses between tokens let the system
    // breathe. Called between two decode calls, when no expert read is in flight (ExpertStore::resize must not overlap a fetch).
    struct Governor {
        double last_s = 0;
        double born_s = 0;  // when the governor was reset (model load): the first minute ramps the cache up fast
        int pause_ms = 0;
        std::size_t floor_cap = 0;  // never shrink below this (a prefill batch needs the experts of a whole layer)
        std::uint64_t grows = 0, shrinks = 0, pauses = 0;
        double avail_mib = 0;
        double gear_eff = 0;  // gear in force (1..6, fractional in auto mode); 0 = no gear (fixed profile or explicit margin)
        double busy = 0;      // auto mode: how busy the rest of the machine is, 0..1 (rises at once, falls slowly)
        // share of the CPU the other programs used since the last call (system busy time minus ours)
        bool cpu_valid = false;
        unsigned long long p_idle = 0, p_sys = 0, p_proc = 0;
        double other_cpu() {
#ifdef _WIN32
            FILETIME i, k, u, c, e, pk, pu;
            if (!GetSystemTimes(&i, &k, &u) || !GetProcessTimes(GetCurrentProcess(), &c, &e, &pk, &pu)) {
                return 0.0;
            }
            auto q = [](const FILETIME& f) { return (static_cast<unsigned long long>(f.dwHighDateTime) << 32) | f.dwLowDateTime; };
            const unsigned long long idle = q(i), sys = q(k) + q(u), proc = q(pk) + q(pu);
            double r = 0.0;
            if (cpu_valid && sys > p_sys) {
                const double dt = static_cast<double>(sys - p_sys);
                const double busy_t = dt - static_cast<double>(idle - p_idle);
                r = std::max(0.0, (busy_t - static_cast<double>(proc - p_proc)) / dt);
            }
            p_idle = idle;
            p_sys = sys;
            p_proc = proc;
            cpu_valid = true;
            return std::min(1.0, r);
#else
            return 0.0;
#endif
        }
    };
    Governor gov;

    // points the process-wide hooks at this engine's expert store (caller holds g_decode_mx)
    void bind_hooks() {
        if (cfg.ws_ram_mib > 0 && cfg.cpu_stream) {
            llama_moe_set_expert_source(nullptr, nullptr);
            llama_moe_set_expert_observer(nullptr, nullptr);
            ggml_cpu_set_expert_fetch(serve_cpu_experts, &source);
        } else if (cfg.ws_ram_mib > 0) {
            ggml_cpu_set_expert_fetch(nullptr, nullptr);
            llama_moe_set_expert_source(serve_experts, &source);
            // a large batch needing more experts of a layer than the store holds is uploaded in slices (half the slots: the siblings need room)
            llama_moe_set_expert_source_limit(std::max<std::size_t>(1, source.store.slot_count() / 2));
            llama_moe_set_expert_observer(observe_routing, this);
            llama_moe_set_bulk_reader(cfg.bulk_prefill ? serve_bulk : nullptr, &source);
            llama_moe_set_expert_prefetch(serve_prefetch, &source);
        } else {
            llama_moe_set_expert_source(nullptr, nullptr);
            llama_moe_set_expert_prefetch(nullptr, nullptr);
            llama_moe_set_expert_observer(nullptr, nullptr);
            ggml_cpu_set_expert_fetch(nullptr, nullptr);
        }
    }
    int decode_bound(llama_batch& b) {
        for (int w = 0; !t_decide_thread && g_decide_pending.load() > 0 && w < 30000; ++w) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));  // a decision is running: it goes first (bounded wait)
        }
        std::lock_guard<std::recursive_mutex> dl(g_decode_mx);
        bind_hooks();
        return llama_decode(ctx, b);
    }

    // Picks the margin from the gear. Manual gear: fixed. Auto: the busier the rest of the machine (CPU used by other programs), the
    // more room is left to it; when it goes quiet the model takes the room back, gradually.
    void update_gear() {
        if (cfg.margin_user_mib > 0 || (!cfg.gear_user && cfg.profile_auto.empty())) {
            gov.gear_eff = 0;  // explicit margin, or a fixed profile without a gear: the margin is not ours to move
            return;
        }
        double g = static_cast<double>(cfg.gear);
        if (cfg.gear == 0) {
            const double score = std::min(1.0, gov.other_cpu() / 0.35);
            gov.busy = score > gov.busy ? score : gov.busy + (score - gov.busy) * 0.15;
            g = 6.0 - 5.0 * gov.busy;
        }
        gov.gear_eff = g;
        cfg.margin_mib = static_cast<std::size_t>(gear_margin_mib(total_mib_now(), g));
    }


    // ---- "paliers" profile: the RAM cache size is decided once per request (paliers_decide) and kept until the generation ends ----
    double pal_cur = 0;              // step in force (MiB), 0 = not decided yet
    double pal_free_mib = 0;         // free RAM measured at the last decision
    double pal_budget_mib = 0;       // what the cache may take (free RAM + what it already holds - margin)
    int pal_dir = 0;                 // -1 / 0 / +1: last change
    std::uint64_t pal_ups = 0, pal_downs = 0, pal_decisions = 0, pal_emergencies = 0;
    std::atomic<bool> mem_emergency{false};  // free RAM under the critical threshold: the running generation pauses / ends
    double pal_crit_seen = 0;        // free RAM that raised the emergency
    double pal_last_watch = 0;
    int pal_low_reads = 0;
    double pal_own_mib = 0;          // what the process holds besides the expert cache (non-expert weights + ~1 GB), estimated from the GGUF
    std::string pal_own_model;
    // read without the engine lock (plain values written under it: a stale number is harmless), so /api/status shows it during a generation too
    json paliers_json() const {
        return {{"on", cfg.profile_auto == "paliers"}, {"palier_mib", static_cast<long long>(pal_cur)}, {"free_mib", static_cast<long long>(pal_free_mib)},
                        {"budget_mib", static_cast<long long>(pal_budget_mib)}, {"margin_mib", cfg.margin_user_mib > 0 ? cfg.margin_user_mib : static_cast<std::size_t>(kPalMargin)},
                        {"critical_mib", static_cast<long long>(pal_crit_threshold())}, {"max_mib", cfg.pal_max_user_mib > 0 ? cfg.pal_max_user_mib : static_cast<std::size_t>(kPalSteps[5])},
                        {"cache_mib", static_cast<long long>(source.store.capacity_bytes() / (1024 * 1024))}, {"free_now_mib", static_cast<long long>(pal_avail_mib())},
                        {"direction", pal_dir}, {"decisions", pal_decisions}, {"ups", pal_ups}, {"downs", pal_downs}, {"emergencies", pal_emergencies},
                        {"emergency", mem_emergency.load()}};
    }
    std::string mem_pause_message() const {
        char b[320];
        std::snprintf(b, sizeof(b), "memory_critical: free system RAM fell to %.0f MiB (threshold %.0f MiB); the generation was stopped instead of shrinking the cache. Retry later, or use /api/jobs (a job pauses with a resume point)", pal_crit_seen, pal_crit_threshold());
        return b;
    }
    double pal_crit_threshold() const {
        return cfg.crit_mib > 0 ? static_cast<double>(cfg.crit_mib) : std::max(1500.0, hard_floor_mib(total_mib_now()));
    }
    // Emergency check, called between two decode calls (not more than 4 times a second): two consecutive readings under the critical
    // threshold raise mem_emergency (the generation loop then pauses / ends). Never resizes the cache.
    void paliers_watch() {
        if (suspended || cfg.ws_ram_mib == 0) {
            return;
        }
        const double t = now_s();
        if (t - pal_last_watch < 0.25) {
            return;
        }
        pal_last_watch = t;
        const double avail = pal_avail_mib();
        gov.avail_mib = avail;
        if (avail < pal_crit_threshold()) {
            if (++pal_low_reads >= 2 && !mem_emergency.exchange(true)) {
                pal_crit_seen = avail;
                ++pal_emergencies;
                std::fprintf(stderr, "[paliers] EMERGENCY: free RAM %.0f MiB < %.0f MiB, the generation stops here\n", avail, pal_crit_threshold());
            }
        } else {
            pal_low_reads = 0;
        }
    }
    // Start of a request (and of a resume after a suspend): measures the free RAM, subtracts the safety margin and snaps to a step.
    // Called with the engine lock held and no decode in flight. Fills res.pal_mib / res.pal_free_mib.
    void paliers_decide(GenResult& res) {
        if (cfg.profile_auto != "paliers" || cfg.ws_ram_mib == 0 || !source.store.is_open()) {
            return;
        }
        mem_emergency = false;
        pal_low_reads = 0;
        if (pal_own_model != cfg.model) {
            const double ne = static_cast<double>(non_expert_bytes(cfg.model)) / 1048576.0;
            pal_own_mib = ne > 0 ? ne + 1000 : 2500;
            pal_own_model = cfg.model;
        }
        const double model_mib = static_cast<double>(model_bytes(cfg.model)) / 1048576.0;
        const double margin = cfg.margin_user_mib > 0 ? static_cast<double>(cfg.margin_user_mib) : kPalMargin;
        const double avail = std::max(0.0, pal_avail_mib() - g_reserved_ram_mib);
        const double cap_mib = static_cast<double>(source.store.capacity_bytes()) / 1048576.0;
        // what the cache already holds in RAM counts as available to it (conservative: our working set minus our own estimate, at most the capacity)
        const double resident = std::max(0.0, std::min(cap_mib, our_ws_mib() - pal_own_mib));
        const double budget = avail + resident - margin;
        const auto lv = pal_levels(static_cast<double>(cfg.pal_max_user_mib), model_mib);
        int dir = 0;
        // the step in force is the one chosen last time; after a load / reload it is the capacity of the store
        double cur = pal_cur;
        if (cur <= 0) {
            cur = cap_mib;
        }
        const double next = pal_choose(lv, budget, cur, &dir);
        pal_budget_mib = budget;
        pal_free_mib = avail;
        gov.avail_mib = avail;
        ++pal_decisions;
        if (std::abs(next - cap_mib) > 64) {
            if (store_resize(static_cast<std::size_t>(next) * 1048576)) {
                if (next > cap_mib) {
                    ++pal_ups;
                } else {
                    ++pal_downs;
                }
            }
        }
        pal_cur = next;
        pal_dir = dir;
        cfg.ws_ram_mib = static_cast<std::size_t>(next);
        res.pal_mib = next;
        res.pal_free_mib = avail;
        std::fprintf(stderr, "[paliers] free %.0f MiB, cache holds %.0f, margin %.0f -> budget %.0f MiB: step %.0f MiB (cache was %.0f)%s\n", avail, resident, margin, budget, next,
                     cap_mib, dir > 0 ? " UP" : (dir < 0 ? " DOWN" : ""));
    }

    void governor_tick() {
        if (on_tick) {
            on_tick();
        }
        live_tick();
        if (cfg.profile_auto == "paliers") {
            paliers_watch();  // the cache size does not move during a generation: only the emergency check runs
            return;
        }
        if (cfg.margin_mib == 0 || cfg.ws_ram_mib == 0 || suspended) {
            gov.pause_ms = 0;
            return;
        }
        if (gov.pause_ms > 0) {
            ++gov.pauses;
            std::this_thread::sleep_for(std::chrono::milliseconds(gov.pause_ms));
        }
        const double t = now_s();
        if (gov.born_s == 0) {
            gov.born_s = t;
        }
        const bool ramp = t - gov.born_s < 90.0;  // just (re)loaded: the cache is smaller than it should be, refill it quickly
        if (t - gov.last_s < (ramp ? 0.4 : 2.0)) {
            return;
        }
        gov.last_s = t;
        constexpr double kMiB = 1048576.0;
        const double avail = available_mib();
        gov.avail_mib = avail;
        update_gear();
        const double target = static_cast<double>(cfg.margin_mib), hyst = target * 0.1;
        const double floor_mib = std::max(target * 0.5, hard_floor_mib(total_mib_now()));
        const std::size_t cap = source.store.capacity_bytes();
        const std::size_t max_cap = phase_cap ? std::min(phase_cap, source.store.max_capacity_bytes()) : source.store.max_capacity_bytes();
        const std::size_t min_cap = std::max(source.store.min_capacity_bytes(), gov.floor_cap);
        if (avail < floor_mib) {
            const double deficit = (floor_mib - avail) * kMiB;
            auto want = static_cast<std::size_t>(std::max(0.0, std::min(static_cast<double>(cap) * 0.8, static_cast<double>(cap) - deficit)));
            want = std::max(want, min_cap);
            if (want < cap && store_resize(want)) {
                ++gov.shrinks;
                std::fprintf(stderr, "[governor] available %.0f MiB < %.0f: cache %zu -> %zu MiB, pause %d ms\n", avail, floor_mib, cap >> 20, want >> 20, gov.pause_ms);
            }
            gov.pause_ms = static_cast<int>(std::min(400.0, 100.0 + 300.0 * (floor_mib - avail) / floor_mib));
        } else {
            gov.pause_ms = 0;
            if (avail > target + hyst && cap < max_cap) {
                const double room = (avail - target - hyst) * kMiB * 0.5;
                auto want = cap + static_cast<std::size_t>(std::min(static_cast<double>(cap) * (ramp ? 0.5 : 0.1), room * (ramp ? 1.6 : 1.0)));
                want = std::min(want, max_cap);
                if (want > cap + 32 * 1024 * 1024 && store_resize(want)) {
                    ++gov.grows;
                    if (ramp) {
                        warm();  // pins and preloads the hottest experts into the new room
                    }
                    std::fprintf(stderr, "[governor] available %.0f MiB > %.0f: cache %zu -> %zu MiB\n", avail, target + hyst, cap >> 20, want >> 20);
                }
            }
        }
    }

    std::atomic<int> fg_waiting{0};  // foreground requests waiting for the engine
    std::atomic<int> suspend_waiting{0};  // /api/suspend calls waiting for the engine (an image is about to take the GPU): background slices give way
    std::atomic<bool> held_off{false};    // suspended on request (images): background slices wait instead of reloading the model; a dialogue or /api/resume clears it
    std::atomic<bool> stop_request{false};  // POST /api/stop: the running chat generation ends after the current token
    bool suspended = true;
    std::size_t phase_cap = 0;               // PhaseMgr: ceiling for this engine's RAM cache (0 = none); the governor never grows past it
    std::function<void()> on_generated;      // a foreground generation just ended (phases follow the conversation)
    std::function<void()> on_tick;           // between two decode calls (PhaseMgr advances its slide from the generating thread)

    // every touch of the expert store from outside a decode goes through the decode lock (resize must not overlap a fetch)
    bool store_resize(std::size_t bytes) {
        std::lock_guard<std::recursive_mutex> dl(g_decode_mx);
        return source.store.resize(bytes);
    }
    void store_set_profile(const std::vector<std::pair<int, int>>& prof, double pin_fraction = 0.75) {
        std::lock_guard<std::recursive_mutex> dl(g_decode_mx);
        source.store.set_profile(prof, pin_fraction);
    }
    // pins and preloads (in the background) the experts this engine uses most, as many as the cache holds: called when the engine is
    // about to work and its cache has just been enlarged
    void warm() {
        if (!preheat || cfg.ws_ram_mib == 0 || suspended) {
            return;
        }
        std::vector<std::pair<int, int>> prof;
        {
            std::lock_guard<std::mutex> l(sheets_mx);
            if (!sheets_ok) {
                return;
            }
            const std::size_t want = source.store.slot_count();
            for (const auto& e : sheets.ranked(cur_domain)) {
                const auto uses = cur_domain >= 0 ? sheets.count(cur_domain, e.layer, e.expert) : sheets.expert_total(e.layer, e.expert);
                if (prof.size() >= want || uses == 0) {
                    break;
                }
                prof.emplace_back(e.layer, e.expert);
            }
        }
        if (!prof.empty()) {
            store_set_profile(prof, 0.9);
        }
    }

    // A new context starts with an empty VRAM expert cache, which it fills slowly while generating. This uploads the experts the
    // current domain uses most, as many as the cache holds, before the first decode (caller: no decode runs meanwhile).
    std::size_t warm_vram() {
        const std::size_t slot_b = source.store.slot_bytes();
        if (!ctx || suspended || cfg.cpu_stream || cfg.cache_mib == 0 || cfg.ws_ram_mib == 0 || slot_b == 0) {
            return 0;
        }
        std::vector<std::vector<std::int32_t>> per_layer;
        {
            std::lock_guard<std::mutex> l(sheets_mx);
            if (!sheets_ok) {
                return 0;
            }
            per_layer.resize(static_cast<std::size_t>(sheets.n_layer()));
            const std::size_t want = cfg.cache_mib * 1048576 / 100 * 95 / (3 * slot_b);  // 3 tensors per expert
            std::size_t n = 0;
            for (const auto& e : sheets.ranked(cur_domain)) {
                const auto uses = cur_domain >= 0 ? sheets.count(cur_domain, e.layer, e.expert) : sheets.expert_total(e.layer, e.expert);
                if (n >= want || uses == 0) {
                    break;
                }
                per_layer[static_cast<std::size_t>(e.layer)].push_back(e.expert);
                ++n;
            }
        }
        std::lock_guard<std::recursive_mutex> dl(g_decode_mx);
        bind_hooks();
        std::size_t loaded = 0;
        for (std::size_t il = 0; il < per_layer.size(); ++il) {
            if (!per_layer[il].empty()) {
                loaded += llama_moe_cache_preload(ctx, static_cast<std::int32_t>(il), per_layer[il].data(), per_layer[il].size());
            }
        }
        return loaded;
    }
    int cur_ubatch = 0;          // micro-batch of the current context (0 = cfg.ubatch)
    std::size_t boosts = 0;      // prompts prefilled with the big micro-batch
    std::string error;

    bool load_locked() {
        if (model) {
            return true;
        }
        llama_model_params mp = llama_model_default_params();
        mp.n_gpu_layers = 999;
        static const llama_model_tensor_buft_override overrides[] = {
            {"\\.ffn_(up|down|gate|gate_up)_(ch|)exps", ggml_backend_cpu_buffer_type()},
            {nullptr, nullptr},
        };
        if (cfg.ws_ram_mib > 0) {
            if (!store_kept.empty() && store_kept == cfg.model && source.store.is_open()) {
                source.store.forget_tensor_pointers();  // same file, cache kept: only the tensor addresses are new
                std::fprintf(stderr, "[load] expert cache kept across the suspend (%.0f MiB)\n", static_cast<double>(source.store.capacity_bytes()) / 1048576.0);
            } else {
                source.store.close();
                if (!source.store.open(cfg.model, cfg.ws_ram_mib * 1024 * 1024, std::max(cfg.ws_ram_mib, cfg.ws_max_mib) * 1024 * 1024)) {
                    error = "ExpertStore: " + source.store.last_error();
                    return false;
                }
            }
            store_kept.clear();
            source.failed = false;
            gov = Governor();
            gov.floor_cap = std::min<std::size_t>(cfg.ws_ram_mib, 2000) * 1024 * 1024;
            mp.tensor_buft_overrides = overrides;
            mp.use_extra_bufts = false;  // the repacked CPU copy would bypass the streaming hook
            // the experts are served by the ExpertStore, never read from the mapping: llama.cpp must not prefetch the whole file
            // (PrefetchVirtualMemory) into RAM in one burst
            _putenv_s("WEIGHTSTREAM_NO_PREFETCH", "1");
            if (cfg.cpu_stream) {
                ggml_cpu_set_expert_fetch(serve_cpu_experts, &source);
            } else {
                llama_moe_set_expert_source(serve_experts, &source);
                llama_moe_set_bulk_reader(cfg.bulk_prefill ? serve_bulk : nullptr, &source);
            }
        }
        model = llama_model_load_from_file(cfg.model.c_str(), mp);
        if (!model) {
            error = "model load failed";
            return false;
        }
        vocab = llama_model_get_vocab(model);
        std::string tmpl_override;
        if (!cfg.chat_template_file.empty()) {
            std::ifstream in(cfg.chat_template_file, std::ios::binary);
            std::stringstream ss;
            ss << in.rdbuf();
            tmpl_override = ss.str();
        }
        tmpls = common_chat_templates_init(model, tmpl_override);
        if (!tmpls) {
            error = "no usable chat template";
            return false;
        }
        const char* bt = llama_vocab_bos(vocab) >= 0 ? llama_vocab_get_text(vocab, llama_vocab_bos(vocab)) : nullptr;
        bos_text = bt ? bt : "";
        init_sheets_locked();
        if (cfg.ws_ram_mib > 0) {
            if (cfg.cpu_stream) {
                source.route = [this](int layer, const std::int32_t* ids, std::size_t n) { record_route(layer, ids, n); };
            } else {
                llama_moe_set_expert_observer(observe_routing, this);
            }
        }
        return true;
    }

    // ---- expert sheets: which experts each domain (character, request label) routes to, learned from use ----
    ws::ExpertSheets sheets;
    std::mutex sheets_mx;
    bool sheets_ok = false;
    int cur_domain = -1;
    bool preheat = true;     // when the domain changes, pin its most used experts in the RAM cache
    int gens_since_save = 0;

    // ---- typing warm-up ----
    // While someone types a message the engine gets ready: the model loads and the thread wakes if they were asleep, the expert cache
    // gets a short burst of extra RAM (small in the strong gears, which already keep a lot in memory; a bit more in the low gears, which
    // do not), the experts of the domain are preloaded, and the finished words of the draft go through the model. The burst is given back
    // when the answer ends, or after `typing_idle_s` seconds without a keystroke (a draft that is never sent), and comes back with the next
    // keystroke. On by default (--no-typing-warm turns it off).
    bool typing_warm = true;
    double typing_idle_s = 90;
    int typing_boost_mib = 0;  // 0 = by gear
    struct TypingJob {
        std::string key;
        json messages;  // the conversation with the draft as its last user message
        Sampling sp;
        std::string draft;
    };
    std::mutex ty_mx;
    std::condition_variable ty_cv;
    TypingJob ty_job;
    bool ty_has = false;
    std::atomic<bool> ty_quit{false}, ty_boosted{false};  // ty_boosted changes under g_decode_mx
    double ty_last = 0;
    std::atomic<std::uint64_t> ty_gen{0};
    std::atomic<int> gen_running{0};
    std::size_t ty_base = 0, ty_added = 0;  // cache capacity before the burst, bytes added by it (guarded by g_decode_mx)
    std::atomic<std::uint64_t> ty_signals{0}, ty_prefilled{0}, ty_bursts{0};
    std::thread ty_th;

    ~Engine() {
        {
            std::lock_guard<std::mutex> l(ty_mx);
            ty_quit = true;
        }
        ty_cv.notify_all();
        if (ty_th.joinable()) {
            ty_th.join();
        }
    }

    void typing_signal(TypingJob job) {
        if (!typing_warm) {
            return;
        }
        std::lock_guard<std::mutex> l(ty_mx);
        ty_job = std::move(job);
        ty_has = true;
        ty_last = now_s();
        ++ty_gen;
        ++ty_signals;
        if (!ty_th.joinable()) {
            ty_th = std::thread([this] { typing_loop(); });
        }
        ty_cv.notify_all();
    }
    // a real request is coming: whatever was waiting to be warmed is obsolete
    void typing_cancel() {
        std::lock_guard<std::mutex> l(ty_mx);
        ty_has = false;
        ++ty_gen;
    }
    void typing_loop() {
        std::unique_lock<std::mutex> l(ty_mx);
        while (!ty_quit) {
            if (!ty_has) {
                if (ty_boosted) {
                    const double left = typing_idle_s - (now_s() - ty_last);
                    if (left <= 0) {
                        if (gen_running.load() == 0) {
                            l.unlock();
                            typing_release();
                            l.lock();
                        } else {
                            ty_cv.wait_for(l, std::chrono::seconds(5));  // an answer is being written: it gives the burst back itself
                        }
                        continue;
                    }
                    ty_cv.wait_for(l, std::chrono::duration<double>(left));
                } else {
                    ty_cv.wait(l);
                }
                continue;
            }
            TypingJob job = std::move(ty_job);
            ty_has = false;
            const std::uint64_t gen = ty_gen.load();
            l.unlock();
            typing_run(job, gen);
            l.lock();
        }
    }
    // extra RAM for the expert cache while someone types, by gear; never goes under the hard floor of the governor
    void typing_boost_locked() {
        std::lock_guard<std::recursive_mutex> dl(g_decode_mx);
        if (ty_boosted || cfg.ws_ram_mib == 0 || cfg.margin_mib == 0 || suspended) {
            ty_boosted = ty_boosted.load() || (cfg.ws_ram_mib > 0 && !suspended);
            return;
        }
        static const double kBoost[6] = {1536, 1100, 800, 550, 380, 256};
        const double g = gov.gear_eff > 0 ? gov.gear_eff : (cfg.gear > 0 ? cfg.gear : 3.0);
        const double want_mib = typing_boost_mib > 0 ? typing_boost_mib : kBoost[std::min(5, std::max(0, static_cast<int>(g + 0.5) - 1))];
        const double floor_mib = std::max(static_cast<double>(cfg.margin_mib) * 0.5, hard_floor_mib(total_mib_now()));
        const double room = available_mib() - floor_mib - 512.0;
        const double add = std::min(want_mib, room);
        const std::size_t cap = source.store.capacity_bytes();
        const std::size_t max_cap = phase_cap ? std::min(phase_cap, source.store.max_capacity_bytes()) : source.store.max_capacity_bytes();
        if (add < 128.0 || cap >= max_cap) {
            ty_boosted = true;  // nothing to add, but the draft is still being warmed: the idle timer applies
            ty_added = 0;
            ty_base = cap;
            return;
        }
        const std::size_t target = std::min(max_cap, cap + static_cast<std::size_t>(add * 1048576.0));
        if (source.store.resize(target)) {
            ty_base = cap;
            ty_added = source.store.capacity_bytes() - cap;
            ++ty_bursts;
            std::fprintf(stderr, "[typing] burst: cache %zu -> %zu MiB (available %.0f MiB)\n", cap >> 20, source.store.capacity_bytes() >> 20, available_mib());
        }
        ty_boosted = true;
    }
    // gives the burst back (the governor takes over); safe to call at any time and from any thread
    void typing_release() {
        std::lock_guard<std::recursive_mutex> dl(g_decode_mx);
        if (!ty_boosted) {
            return;
        }
        ty_boosted = false;
        if (ty_added > 0 && !suspended && cfg.ws_ram_mib > 0) {
            const std::size_t cap = source.store.capacity_bytes();
            const std::size_t want = std::max(ty_base, std::max(source.store.min_capacity_bytes(), gov.floor_cap));
            if (cap > want && source.store.resize(want)) {
                std::fprintf(stderr, "[typing] released: cache %zu -> %zu MiB\n", cap >> 20, source.store.capacity_bytes() >> 20);
            }
        }
        ty_added = 0;
    }
    // the finished words of the draft go through the model, a few tokens at a time so that a real request can take over at once
    std::size_t typing_prefill_locked(const TypingJob& job, std::uint64_t gen) {
        if (!ctx || suspended || !llama_memory_can_shift(llama_get_memory(ctx))) {
            return 0;  // a recurrent model cannot cut its state back to a shorter prefix: a wrong guess would cost a full prefill
        }
        const std::string prompt = render(job.messages, job.sp);
        const std::size_t at = job.draft.empty() ? std::string::npos : prompt.rfind(job.draft);
        if (at == std::string::npos) {
            return 0;
        }
        std::size_t cut = job.draft.size();
        while (cut > 0 && !std::isspace(static_cast<unsigned char>(job.draft[cut - 1]))) {
            --cut;
        }
        const std::string prefix = prompt.substr(0, at + cut);
        const bool add_bos = llama_vocab_get_add_bos(vocab) && !(!bos_text.empty() && prefix.rfind(bos_text, 0) == 0);
        int n = -llama_tokenize(vocab, prefix.c_str(), static_cast<int32_t>(prefix.size()), nullptr, 0, add_bos, true);
        if (n <= 1) {
            return 0;
        }
        std::vector<llama_token> toks(static_cast<std::size_t>(n));
        llama_tokenize(vocab, prefix.c_str(), static_cast<int32_t>(prefix.size()), toks.data(), n, add_bos, true);
        toks.pop_back();  // the last token may merge with the next word
        if (static_cast<int>(toks.size()) + 8 + job.sp.reserve >= cfg.n_ctx) {
            return 0;
        }
        wake_locked(job.key);
        Thread& th = threads[job.key];
        const llama_seq_id seq = static_cast<llama_seq_id>(th.slot);
        std::size_t common = 0;
        while (common < th.tokens.size() && common < toks.size() && th.tokens[common] == toks[common]) {
            ++common;
        }
        if (common >= toks.size()) {
            return 0;
        }
        if (common < th.tokens.size()) {
            if (!llama_memory_seq_rm(llama_get_memory(ctx), seq, static_cast<llama_pos>(common), -1)) {
                return 0;
            }
            th.tokens.resize(common);
        }
        const std::size_t chunk = static_cast<std::size_t>(std::max(8, cur_ubatch > 0 ? cur_ubatch : cfg.ubatch));
        llama_batch b = llama_batch_init(static_cast<int32_t>(chunk), 0, 1);
        std::size_t done = 0;
        for (std::size_t off = common; off < toks.size(); off += chunk) {
            if (fg_waiting.load() > 0 || ty_gen.load() != gen || ty_quit) {
                break;  // a request (or a newer draft) is waiting: stop here, what went through stays in the thread
            }
            const std::size_t m = std::min(chunk, toks.size() - off);
            for (std::size_t i = 0; i < m; ++i) {
                b.token[i] = toks[off + i];
                b.pos[i] = static_cast<llama_pos>(off + i);
                b.n_seq_id[i] = 1;
                b.seq_id[i][0] = seq;
                b.logits[i] = false;
            }
            b.n_tokens = static_cast<int32_t>(m);
            if (decode_bound(b)) {
                llama_memory_seq_rm(llama_get_memory(ctx), seq, static_cast<llama_pos>(off), -1);
                break;
            }
            th.tokens.insert(th.tokens.end(), toks.begin() + static_cast<std::ptrdiff_t>(off), toks.begin() + static_cast<std::ptrdiff_t>(off + m));
            done += m;
            governor_tick();
        }
        llama_batch_free(b);
        ty_prefilled += done;
        return done;
    }
    void typing_run(const TypingJob& job, std::uint64_t gen) {
        std::unique_lock<std::mutex> lock(mx);  // waits for a running generation to end
        if (ty_gen.load() != gen || ty_quit) {
            return;  // a request or a newer draft came meanwhile
        }
        if (!ensure_running_locked()) {
            return;
        }
        set_domain_locked(job.sp.domain.empty() ? std::string("general") : job.sp.domain);
        const double t0 = now_s();
        typing_boost_locked();
        warm();
        const std::size_t n = typing_prefill_locked(job, gen);
        if (n > 0) {
            std::fprintf(stderr, "[typing] %zu draft tokens prefilled in %.1f s\n", n, now_s() - t0);
        }
    }

    // everything that only makes sense for one model file (expert sheets, thread KV states, pre-caches) lives under
    // <data-dir>/models/<name>-<hash of file name and size>/ : a new model file starts clean, the old one is kept
    // until it is purged (DELETE /api/models/<id>)
    std::string model_id() const {
        std::error_code ec;
        const std::string fn = fs::path(cfg.model).filename().string();
        return fs::path(cfg.model).stem().string() + "-" + to_hex(std::hash<std::string>{}(fn + ":" + std::to_string(model_bytes(cfg.model)))).substr(0, 8);
    }
    fs::path model_dir() const { return fs::path(cfg.data_dir) / "models" / model_id(); }
    std::string sheets_path() const { return (model_dir() / "expert_sheets.wssheets").string(); }

    static json read_model_json(const fs::path& dir) {
        std::ifstream f(dir / "model.json", std::ios::binary);
        json j = json::parse(f, nullptr, false);
        return j.is_object() ? j : json::object();
    }
    static void write_model_json_to(const fs::path& dir, const json& j) { std::ofstream(dir / "model.json", std::ios::binary | std::ios::trunc) << j.dump(1); }

    void write_model_json() {
        std::error_code ec;
        fs::create_directories(model_dir());
        json j = read_model_json(model_dir());  // keeps the user's marks (pin)
        j["id"] = model_id();
        j["file"] = fs::path(cfg.model).filename().string();
        j["path"] = fs::absolute(cfg.model).string();
        j["size_bytes"] = static_cast<long long>(model_bytes(cfg.model));
        j["last_used"] = static_cast<long long>(std::time(nullptr));
        write_model_json_to(model_dir(), j);
    }

    std::string meta(const std::string& key) const {
        char buf[128];
        const int n = llama_model_meta_val_str(model, key.c_str(), buf, sizeof(buf));
        return n > 0 ? std::string(buf) : std::string();
    }

    void init_sheets_locked() {
        const int n_layer = llama_model_n_layer(model);
        const int n_expert = std::atoi(meta(meta("general.architecture") + ".expert_count").c_str());
        std::lock_guard<std::mutex> l(sheets_mx);
        if (n_expert <= 1 || n_layer <= 0) {
            sheets_ok = false;  // dense model: nothing to follow
            return;
        }
        const std::string name = fs::path(cfg.model).filename().string();
        if (sheets_ok && sheets.model_name() == name && sheets.n_layer() == n_layer && sheets.n_expert() == n_expert) {
            return;  // resumed after a suspend: keep what has been learned
        }
        ws::ExpertSheets loaded;
        if (loaded.load(sheets_path()) && loaded.model_name() == name && loaded.n_layer() == n_layer && loaded.n_expert() == n_expert) {
            sheets = std::move(loaded);
        } else {
            sheets = ws::ExpertSheets();
            sheets.init(name, n_layer, n_expert);
        }
        cur_domain = -1;
        sheets_ok = true;
    }

    // ---- live working set: the experts the current conversation really uses, with a memory of a few hundred decode steps ----
    // Every routed expert adds a weight that grows with time (so older uses fade, half-life ~300 steps). During a long task on one
    // subject the same experts come back and dominate; the most used ones are pinned in the RAM cache until the talk moves elsewhere.
    std::vector<float> live;
    double live_w = 1.0;
    int live_last_layer = 1 << 30;
    std::uint64_t live_passes = 0, live_pass_pinned = 0, live_repins = 0;
    std::vector<std::uint64_t> live_pinned;  // (layer << 32 | expert) pinned at the last re-pin, sorted

    void live_add(int layer, const std::int32_t* ids, std::size_t n_ids) {  // sheets_mx held
        const std::size_t ne = static_cast<std::size_t>(sheets.n_expert());
        if (live.size() != static_cast<std::size_t>(sheets.n_layer()) * ne) {
            live.assign(static_cast<std::size_t>(sheets.n_layer()) * ne, 0.0f);
            live_w = 1.0;
        }
        if (layer <= live_last_layer) {  // a new decode step (layers come in increasing order within one)
            ++live_passes;
            live_w /= 0.9977;
            if (live_w > 1e6) {
                for (float& v : live) {
                    v *= 1e-6f;
                }
                live_w *= 1e-6;
            }
        }
        live_last_layer = layer;
        for (std::size_t i = 0; i < n_ids; ++i) {
            if (ids[i] >= 0 && static_cast<std::size_t>(ids[i]) < ne) {
                live[static_cast<std::size_t>(layer) * ne + static_cast<std::size_t>(ids[i])] += static_cast<float>(live_w);
            }
        }
    }

    void live_tick() {  // between two decode calls
        if (!preheat || cfg.ws_ram_mib == 0 || suspended) {
            return;
        }
        std::vector<std::pair<int, int>> prof;
        {
            std::lock_guard<std::mutex> l(sheets_mx);
            if (!sheets_ok || live.empty() || live_passes < 200 || live_passes - live_pass_pinned < 100) {
                return;
            }
            live_pass_pinned = live_passes;
            const std::size_t ne = static_cast<std::size_t>(sheets.n_expert());
            const std::size_t want = std::min(live.size(), source.store.slot_count() / 4);  // 3 tensors per expert, 3/4 of the slots may be pinned
            std::vector<std::uint32_t> idx;
            for (std::size_t i = 0; i < live.size(); ++i) {
                if (live[i] > 0.0f) {
                    idx.push_back(static_cast<std::uint32_t>(i));
                }
            }
            if (want == 0 || idx.empty()) {
                return;
            }
            const std::size_t n = std::min(want, idx.size());
            std::partial_sort(idx.begin(), idx.begin() + static_cast<std::ptrdiff_t>(n), idx.end(), [&](std::uint32_t a, std::uint32_t b) { return live[a] > live[b]; });
            std::vector<std::uint64_t> keys;
            for (std::size_t i = 0; i < n; ++i) {
                keys.push_back((static_cast<std::uint64_t>(idx[i] / ne) << 32) | (idx[i] % ne));
                prof.emplace_back(static_cast<int>(idx[i] / ne), static_cast<int>(idx[i] % ne));
            }
            std::sort(keys.begin(), keys.end());
            std::vector<std::uint64_t> common;
            std::set_intersection(keys.begin(), keys.end(), live_pinned.begin(), live_pinned.end(), std::back_inserter(common));
            if (!live_pinned.empty() && common.size() * 100 >= keys.size() * 85) {
                return;  // the hot set barely moved: leave the pins alone
            }
            live_pinned = std::move(keys);
            ++live_repins;
        }
        store_set_profile(prof);
    }

    void record_route(int layer, const std::int32_t* ids, std::size_t n_ids) {
        std::lock_guard<std::mutex> l(sheets_mx);
        if (sheets_ok && layer >= 0 && layer < sheets.n_layer()) {
            live_add(layer, ids, n_ids);
        }
        if (sheets_ok && cur_domain >= 0 && layer >= 0 && layer < sheets.n_layer()) {
            sheets.record(cur_domain, layer, ids, n_ids);
        }
    }

    void save_sheets() {
        std::lock_guard<std::mutex> l(sheets_mx);
        if (sheets_ok && sheets.grand_total() > 0) {
            fs::create_directories(model_dir());
            sheets.save(sheets_path());
        }
        gens_since_save = 0;
    }

    // called when a request starts: its routing is recorded under `name`, and its profile is preheated if it is a new domain
    void set_domain_locked(const std::string& name) {
        std::vector<std::pair<int, int>> profile;
        {
            std::lock_guard<std::mutex> l(sheets_mx);
            if (!sheets_ok) {
                return;
            }
            const int id = sheets.domain_id(name);
            const bool changed = id != cur_domain;
            cur_domain = id;
            if (!changed || !preheat || cfg.ws_ram_mib == 0 || sheets.domain_total(id) < 500) {
                return;
            }
            for (const auto& e : sheets.ranked(id)) {
                if (profile.size() >= source.store.slot_count() || sheets.count(id, e.layer, e.expert) == 0) {
                    break;
                }
                profile.emplace_back(e.layer, e.expert);
            }
        }
        if (!profile.empty()) {
            store_set_profile(profile);
        }
    }

    json experts_summary(const std::string& domain_name) {
        std::lock_guard<std::mutex> l(sheets_mx);
        json j;
        j["available"] = sheets_ok;
        if (!sheets_ok) {
            j["reason"] = model ? "dense model (no experts to follow)" : "model not loaded yet (send a request or POST /api/resume)";
            return j;
        }
        j["model"] = sheets.model_name();
        j["n_layer"] = sheets.n_layer();
        j["n_expert"] = sheets.n_expert();
        j["grand_total"] = sheets.grand_total();
        j["preheat"] = preheat;
        j["domains"] = json::array();
        int d = -1;
        for (std::size_t i = 0; i < sheets.domains().size(); ++i) {
            j["domains"].push_back({{"name", sheets.domains()[i]}, {"total", sheets.domain_total(static_cast<int>(i))}});
            if (sheets.domains()[i] == domain_name) {
                d = static_cast<int>(i);
            }
        }
        j["selected"] = d >= 0 ? domain_name : std::string();
        const double total = static_cast<double>(d >= 0 ? sheets.domain_total(d) : sheets.grand_total());
        auto uses = [&](const ws::ExpertSheets::ExpertId& e) {
            return d >= 0 ? sheets.count(d, e.layer, e.expert) : sheets.expert_total(e.layer, e.expert);
        };
        const auto ranked = sheets.ranked(d);
        j["top"] = json::array();
        std::size_t used = 0;
        for (const auto& e : ranked) {
            const auto u = uses(e);
            if (u == 0) {
                break;
            }
            ++used;
            if (j["top"].size() < 30) {
                j["top"].push_back({{"layer", e.layer}, {"expert", e.expert}, {"uses", u}, {"share", total > 0 ? u / total : 0.0},
                                    {"affinity", d >= 0 ? sheets.affinity(d, e.layer, e.expert) : 1.0}});
            }
        }
        j["experts_used"] = used;
        j["experts_total"] = static_cast<std::size_t>(sheets.n_layer()) * static_cast<std::size_t>(sheets.n_expert());
        // how concentrated the usage is: share of all uses covered by the most used X% of experts
        json cov = json::array();
        for (const int pct : {1, 5, 10, 25, 50}) {
            const std::size_t k = static_cast<std::size_t>(std::ceil(pct / 100.0 * static_cast<double>(j["experts_total"].get<std::size_t>())));
            double sum = 0;
            for (std::size_t i = 0; i < k && i < ranked.size(); ++i) {
                sum += static_cast<double>(uses(ranked[i]));
            }
            cov.push_back({{"top_percent", pct}, {"covers", total > 0 ? sum / total : 0.0}});
        }
        j["coverage"] = cov;
        return j;
    }

    json experts_heatmap(const std::string& domain_name) {
        std::lock_guard<std::mutex> l(sheets_mx);
        json j;
        j["available"] = sheets_ok;
        if (!sheets_ok) {
            return j;
        }
        int d = -1;
        for (std::size_t i = 0; i < sheets.domains().size(); ++i) {
            if (sheets.domains()[i] == domain_name) {
                d = static_cast<int>(i);
            }
        }
        std::uint64_t mx = 0;
        json rows = json::array();
        for (int ly = 0; ly < sheets.n_layer(); ++ly) {
            json row = json::array();
            for (int e = 0; e < sheets.n_expert(); ++e) {
                const std::uint64_t u = d >= 0 ? sheets.count(d, ly, e) : sheets.expert_total(ly, e);
                mx = std::max(mx, u);
                row.push_back(u);
            }
            rows.push_back(std::move(row));
        }
        j["n_layer"] = sheets.n_layer();
        j["n_expert"] = sheets.n_expert();
        j["max"] = mx;
        j["rows"] = std::move(rows);
        return j;
    }

    // the "sheet" of one expert: its use and its affinity in each domain
    json expert_card(int layer, int expert) {
        std::lock_guard<std::mutex> l(sheets_mx);
        json j;
        if (!sheets_ok || layer < 0 || layer >= sheets.n_layer() || expert < 0 || expert >= sheets.n_expert()) {
            j["available"] = false;
            return j;
        }
        j["available"] = true;
        j["layer"] = layer;
        j["expert"] = expert;
        j["uses"] = sheets.expert_total(layer, expert);
        j["domains"] = json::array();
        for (std::size_t i = 0; i < sheets.domains().size(); ++i) {
            const int d = static_cast<int>(i);
            const double dt = static_cast<double>(sheets.domain_total(d));
            const auto u = sheets.count(d, layer, expert);
            j["domains"].push_back({{"name", sheets.domains()[i]}, {"uses", u}, {"share", dt > 0 ? u / dt : 0.0}, {"affinity", sheets.affinity(d, layer, expert)}});
        }
        return j;
    }

    static ggml_type kv_ggml_type(const std::string& t) {
        return t == "q8_0" ? GGML_TYPE_Q8_0 : t == "q4_0" ? GGML_TYPE_Q4_0 : GGML_TYPE_F16;
    }
    static bool kv_type_ok(const std::string& t) { return t == "f16" || t == "q8_0" || t == "q4_0"; }

    bool make_context_locked() {
        if (ctx) {
            return true;
        }
        llama_context_params cp = llama_context_default_params();
        cp.n_ctx = static_cast<uint32_t>(cfg.n_ctx * cfg.slots);
        cp.n_seq_max = static_cast<uint32_t>(cfg.slots);
        cp.n_batch = static_cast<uint32_t>(std::max(512, cur_ubatch));  // a boosted prefill decodes one big batch: every layer's experts are read once per batch
        cp.swa_full = cfg.swa_full;
        cp.kv_unified = true;  // one shared KV buffer: saved thread states stay valid when the number of slots changes
        const int ub = cur_ubatch > 0 ? cur_ubatch : cfg.ubatch;
        if (ub > 0) {
            cp.n_ubatch = static_cast<uint32_t>(ub);
        }
        cp.moe_cache_size = cfg.cache_mib * 1024 * 1024;
        cp.type_k = kv_ggml_type(cfg.kv_type_k);
        cp.type_v = kv_ggml_type(cfg.kv_type_v);
        if (cp.type_k != GGML_TYPE_F16 || cp.type_v != GGML_TYPE_F16) {
            cp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_ENABLED;  // a quantized V cache needs flash attention
        }
        ctx = llama_init_from_model(model, cp);
        if (!ctx) {
            error = "context init failed";
            return false;
        }
        owner.assign(static_cast<std::size_t>(cfg.slots), std::string());
        for (auto& [k, t] : threads) {
            t.slot = -1;
            t.tokens.clear();
        }
        return true;
    }

    // brings the engine to "running" (model loaded, context created)
    bool ensure_running_locked() {
        if (!suspended && model && ctx) {
            return true;
        }
        {
            std::lock_guard<std::recursive_mutex> dl(g_decode_mx);
            if (!load_locked() || !make_context_locked()) {
                return false;
            }
            bind_hooks();
        }
        suspended = false;
        if (cfg.light) {
            trim_working_set();  // the pages the load touched are not needed again
        }
        write_model_json();
        run_precaches_locked();
        return true;
    }

    // ---- pre-caches: a prompt prefix (system prompt, character sheet) prefilled once and kept as a KV state on disk ----
    // The recipe (data-dir/precaches/<name>.json) is independent of the model; the KV state belongs to the model file, so
    // changing the model only costs a rebuild of the states, at the moment the recipe's policy says.
    //   load: "startup" (built when the service starts), "first_use" (built when the model is loaded), "manual"
    //   keep: true = state survives the service closing, false = removed at shutdown
    std::map<std::string, json> recipes;
    std::map<std::string, json> precache_info;  // build time and tokens of the states built by this process
    bool in_precache = false;

    fs::path recipes_dir() const { return fs::path(cfg.data_dir) / "precaches"; }

    void load_recipes() {
        std::error_code ec;
        for (const auto& d : fs::directory_iterator(recipes_dir(), ec)) {
            std::ifstream f(d.path(), std::ios::binary);
            json j = json::parse(f, nullptr, false);
            if (j.is_object() && j.contains("name") && j["name"].is_string() && j.value("system", std::string()).size() > 0) {
                recipes[j["name"].get<std::string>()] = j;
            }
        }
    }

    bool put_recipe_locked(const std::string& name, const json& b, std::string& err) {
        if (!b.is_object() || !b.contains("system") || !b["system"].is_string() || b["system"].get<std::string>().empty()) {
            err = "system (the prefix to prefill) is required";
            return false;
        }
        const std::string load = b.value("load", "first_use");
        if (load != "startup" && load != "first_use" && load != "manual") {
            err = "load must be startup, first_use or manual";
            return false;
        }
        json r = {{"name", name}, {"system", b["system"]}, {"load", load}, {"keep", b.value("keep", true)}, {"thread", b.value("thread", std::string())}};
        fs::create_directories(recipes_dir());
        std::ofstream(recipes_dir() / (name + ".json"), std::ios::binary | std::ios::trunc) << r.dump(1);
        recipes[name] = r;
        return true;
    }

    std::string precache_key(const json& r) const {
        const std::string t = r.value("thread", std::string());
        return t.empty() ? "sys:" + to_hex(std::hash<std::string>{}(r["system"].get<std::string>())) : t;  // same key the OpenAI route derives from a system message
    }

    bool precache_ready_locked(const json& r) {
        const std::string key = precache_key(r);
        const auto it = threads.find(key);
        return it != threads.end() && (it->second.slot >= 0 || (it->second.has_state && fs::exists(state_file(key))));
    }

    bool build_precache_locked(const std::string& name, std::string& err, bool evict = false, json* info = nullptr) {
        const auto it = recipes.find(name);
        if (it == recipes.end()) {
            err = "unknown pre-cache";
            return false;
        }
        const json& r = it->second;
        if (precache_ready_locked(r)) {
            return true;
        }
        if (precache_cap_mib > 0) {
            const long long est = estimate_precache_bytes(r), cap = static_cast<long long>(precache_cap_mib) * 1024 * 1024;
            if (total_precache_bytes() + est > cap) {
                json cand;
                if (!make_room(est, evict, cand)) {
                    err = "cap_reached: this pre-cache needs about " + std::to_string(est / 1048576) + " MB and the total would exceed the " +
                          std::to_string(precache_cap_mib) + " MB cap. Consider replacing the pre-caches of unused models instead of adding more (" +
                          (cand.empty() ? "no other model has pre-caches to replace; raise the cap or delete a pre-cache" : "retry with evict=auto to replace the least recently used ones") + ")";
                    if (info) {
                        (*info)["candidates"] = cand;
                    }
                    return false;
                }
            }
        }
        if (!ensure_running_locked()) {
            err = error;
            return false;
        }
        const std::string key = precache_key(r);
        Sampling sp;
        sp.max_tokens = 0;  // prefill only
        GenResult g;
        const double t0 = now_s();
        const bool saved_flag = in_precache;
        in_precache = true;
        const bool ok = generate_locked(key, json::array({{{"role", "system"}, {"content", r["system"]}}}), sp, [](const std::string&) { return true; }, g, err);
        in_precache = saved_flag;
        if (!ok) {
            return false;
        }
        sleep_thread_locked(key);  // writes the KV state; a request for this thread then wakes it in ~0.03 s
        write_index_locked();
        precache_info[name] = {{"tokens", g.prompt_tokens}, {"build_s", now_s() - t0}, {"fast_prefill", g.boosted}};
        return true;
    }

    // builds the missing states of every pre-cache that is not "manual"
    void run_precaches_locked() {
        if (in_precache) {
            return;
        }
        in_precache = true;
        for (const auto& [name, r] : recipes) {
            if (r.value("load", "") != "manual" && !precache_ready_locked(r)) {
                std::string err;
                in_precache = false;
                if (!build_precache_locked(name, err)) {
                    std::fprintf(stderr, "[ws_npc_server] pre-cache %s not built: %s\n", name.c_str(), err.c_str());
                    if (err.rfind("cap_reached", 0) == 0) {
                        precache_info[name] = {{"blocked", "cap_reached"}};
                    }
                }
                in_precache = true;
            }
        }
        in_precache = false;
    }

    // at shutdown: states of pre-caches declared keep=false are removed
    void drop_volatile_precaches_locked() {
        for (const auto& [name, r] : recipes) {
            if (!r.value("keep", true)) {
                drop_thread_locked(precache_key(r));
            }
        }
        write_index_locked();
    }

    json precaches_json_locked() {
        json a = json::array();
        for (const auto& [name, r] : recipes) {
            const std::string key = precache_key(r);
            std::error_code ec;
            const auto sz = fs::exists(state_file(key), ec) ? static_cast<long long>(fs::file_size(state_file(key), ec)) : 0LL;
            json e = {{"name", name}, {"load", r["load"]}, {"keep", r["keep"]}, {"thread", key}, {"system_chars", r["system"].get<std::string>().size()},
                      {"state", precache_ready_locked(r) ? "ready" : (precache_info.count(name) && precache_info[name].contains("blocked") ? "blocked_by_cap" : "missing")}, {"kv_bytes", sz}};
            if (precache_info.count(name)) {
                e["last_build"] = precache_info[name];
            }
            a.push_back(e);
        }
        return a;
    }

    // ---- storage policy: cap on the pre-caches, idle models, removal with confirmation ----
    std::size_t precache_cap_mib = 1024;  // total of all pre-cache states of all models (0 = no limit)
    int precache_ttl_days = 30;           // a model unused for that long gets its pre-caches proposed for removal (0 = never)
    bool auto_clean = false;              // apply that removal at launch (the latest used model, pinned models and the current one are exempt)

    fs::path settings_path() const { return fs::path(cfg.data_dir) / "settings.json"; }
    json settings_json() const {
        return {{"precache_cap_mib", precache_cap_mib}, {"precache_ttl_days", precache_ttl_days}, {"auto_clean", auto_clean}};
    }
    void apply_settings(const json& b) {
        if (b.contains("precache_cap_mib") && b["precache_cap_mib"].is_number()) {
            precache_cap_mib = static_cast<std::size_t>(std::max<long long>(0, b["precache_cap_mib"].get<long long>()));
        }
        if (b.contains("precache_ttl_days") && b["precache_ttl_days"].is_number()) {
            precache_ttl_days = std::max(0, b["precache_ttl_days"].get<int>());
        }
        if (b.contains("auto_clean") && b["auto_clean"].is_boolean()) {
            auto_clean = b["auto_clean"].get<bool>();
        }
    }
    void load_settings() {
        std::ifstream f(settings_path(), std::ios::binary);
        json j = json::parse(f, nullptr, false);
        if (j.is_object()) {
            apply_settings(j);
        }
    }
    void save_settings() {
        fs::create_directories(cfg.data_dir);
        std::ofstream(settings_path(), std::ios::binary | std::ios::trunc) << settings_json().dump(1);
    }

    struct ModelInfo {
        std::string id;
        fs::path dir;
        json meta;
        long long last_used = 0, pre_bytes = 0, dir_bytes = 0, kv_bytes = 0;
        bool pinned = false, current = false, file_present = false;
        std::vector<json> pre_files;
    };

    std::vector<json> precache_files(const fs::path& mdir) {
        std::vector<json> v;
        std::error_code ec;
        for (const auto& [name, r] : recipes) {
            const fs::path f = mdir / "state" / state_name(precache_key(r));
            if (fs::exists(f, ec)) {
                v.push_back({{"name", name}, {"path", fs::absolute(f).string()}, {"bytes", static_cast<long long>(fs::file_size(f, ec))}});
            }
        }
        return v;
    }

    std::vector<ModelInfo> scan_models() {
        std::vector<ModelInfo> out;
        std::error_code ec;
        for (const auto& d : fs::directory_iterator(fs::path(cfg.data_dir) / "models", ec)) {
            if (!d.is_directory(ec)) {
                continue;
            }
            ModelInfo m;
            m.dir = d.path();
            m.id = d.path().filename().string();
            m.meta = read_model_json(m.dir);
            m.last_used = m.meta.value("last_used", 0LL);
            m.pinned = m.meta.value("pin", false);
            m.current = m.id == model_id();
            m.file_present = m.meta.contains("path") && fs::exists(m.meta.value("path", std::string()), ec);
            m.pre_files = precache_files(m.dir);
            for (const auto& f : m.pre_files) {
                m.pre_bytes += f["bytes"].get<long long>();
            }
            for (const auto& e : fs::recursive_directory_iterator(m.dir, ec)) {
                if (e.is_regular_file(ec)) {
                    const auto n = static_cast<long long>(e.file_size(ec));
                    m.dir_bytes += n;
                    if (e.path().extension() == ".kv") {
                        m.kv_bytes += n;
                    }
                }
            }
            out.push_back(std::move(m));
        }
        std::sort(out.begin(), out.end(), [](const ModelInfo& a, const ModelInfo& b) { return a.last_used > b.last_used; });
        return out;
    }

    long long total_precache_bytes() {
        long long t = 0;
        for (const auto& m : scan_models()) {
            t += m.pre_bytes;
        }
        return t;
    }

    // size of a recipe's state: measured in any model folder, else guessed (~4 characters a token, ~120 KB a token on Gemma 4)
    long long estimate_precache_bytes(const json& r) {
        long long best = 0;
        for (const auto& m : scan_models()) {
            for (const auto& f : m.pre_files) {
                if (f["name"] == r["name"]) {
                    best = std::max(best, f["bytes"].get<long long>());
                }
            }
        }
        return best > 0 ? best : static_cast<long long>(r["system"].get<std::string>().size() / 4) * 120000;
    }

    void remove_precache_files(const ModelInfo& m) {
        std::error_code ec;
        if (m.current) {  // may be awake in a slot: go through the thread table
            for (const auto& [name, r] : recipes) {
                drop_thread_locked(precache_key(r));
            }
            write_index_locked();
            return;
        }
        for (const auto& f : m.pre_files) {
            fs::remove(f["path"].get<std::string>(), ec);
        }
    }

    // Looks for `need` bytes under the cap by replacing the pre-caches of the least recently used models (never the current
    // model nor a pinned one). `cand` lists what could be (or was) replaced. Removes them only when `evict` is true.
    bool make_room(long long need, bool evict, json& cand) {
        const long long cap = static_cast<long long>(precache_cap_mib) * 1024 * 1024;
        long long total = total_precache_bytes();
        cand = json::array();
        auto ms = scan_models();
        std::reverse(ms.begin(), ms.end());  // oldest first
        for (const auto& m : ms) {
            if (total + need <= cap) {
                break;
            }
            if (m.current || m.pinned || m.pre_bytes == 0) {
                continue;
            }
            cand.push_back({{"model", m.id}, {"last_used", m.last_used}, {"precache_bytes", m.pre_bytes}});
            total -= m.pre_bytes;
            if (evict) {
                remove_precache_files(m);
            }
        }
        return total + need <= cap && (evict || cand.empty());
    }

    json models_json_locked() {
        const long long now = static_cast<long long>(std::time(nullptr));
        const long long cap = static_cast<long long>(precache_cap_mib) * 1024 * 1024;
        json arr = json::array(), advice = json::array();
        long long total = 0;
        for (const auto& m : scan_models()) {
            total += m.pre_bytes;
            const double idle = m.last_used > 0 ? static_cast<double>(now - m.last_used) / 86400.0 : -1.0;
            json adv = json::array();
            if (!m.file_present && m.meta.contains("path")) {
                adv.push_back("The model file is gone (" + m.meta.value("path", std::string()) + "). This folder (" + std::to_string(m.dir_bytes / 1048576) +
                              " MB, of which " + std::to_string(m.pre_bytes / 1048576) + " MB pre-caches) can be deleted.");
            } else if (precache_ttl_days > 0 && idle >= precache_ttl_days && m.pre_bytes > 0 && !m.current && !m.pinned) {
                adv.push_back("Not used for " + std::to_string(static_cast<int>(idle)) + " days: its pre-caches (" + std::to_string(m.pre_bytes / 1048576) +
                              " MB) can be removed - they can be re-generated next time you use this model.");
            }
            for (const auto& a : adv) {
                advice.push_back(m.id + ": " + a.get<std::string>());
            }
            arr.push_back({{"id", m.id}, {"file", m.meta.value("file", std::string())}, {"path", m.meta.value("path", std::string())},
                           {"size_bytes", m.meta.value("size_bytes", 0LL)}, {"last_used", m.last_used}, {"idle_days", idle}, {"pinned", m.pinned},
                           {"current", m.current}, {"model_file_present", m.file_present}, {"dir", fs::absolute(m.dir).string()},
                           {"dir_bytes", m.dir_bytes}, {"kv_state_bytes", m.kv_bytes}, {"has_expert_sheets", fs::exists(m.dir / "expert_sheets.wssheets")},
                           {"precache_bytes", m.pre_bytes}, {"precaches", m.pre_files}, {"advice", adv}});
        }
        if (cap > 0 && total * 10 >= cap * 9) {
            advice.push_back("Pre-cache storage is at " + std::to_string(total / 1048576) + " of " + std::to_string(precache_cap_mib) +
                             " MB. Consider replacing the pre-caches of models you no longer use rather than adding more.");
        }
        return {{"models", arr}, {"precache_total_bytes", total}, {"precache_cap_bytes", cap}, {"settings", settings_json()}, {"advice", advice}};
    }

    // models whose pre-caches the idle rule would clear: not used for precache_ttl_days, except the current model, the most
    // recently used one (kept as the "last model in date"), and pinned models
    json housekeeping_plan_locked() {
        json plan = json::array();
        if (precache_ttl_days <= 0) {
            return plan;
        }
        const long long now = static_cast<long long>(std::time(nullptr));
        const auto ms = scan_models();
        for (std::size_t i = 1; i < ms.size(); ++i) {  // ms[0] is the most recently used
            const auto& m = ms[i];
            const double idle = static_cast<double>(now - m.last_used) / 86400.0;
            if (!m.current && !m.pinned && m.pre_bytes > 0 && idle >= precache_ttl_days) {
                plan.push_back({{"model", m.id}, {"idle_days", idle}, {"precache_bytes", m.pre_bytes}});
            }
        }
        return plan;
    }

    json housekeeping_locked(bool apply) {
        json plan = housekeeping_plan_locked();
        if (apply) {
            for (const auto& e : plan) {
                for (const auto& m : scan_models()) {
                    if (m.id == e["model"].get<std::string>()) {
                        remove_precache_files(m);
                    }
                }
            }
        }
        return {{"plan", plan}, {"applied", apply}};
    }

    void free_context_locked() {
        sleep_all_locked();
        if (ctx) {
            llama_free(ctx);
            ctx = nullptr;
        }
        owner.clear();
    }

    // keep_ram_mib > 0 (and the expert cache open): only the GPU side goes away. The RAM cache of experts stays (shrunk to that size so
    // an image generator can have the rest of the RAM); the next load re-binds the new model's tensors to it instead of re-reading the SSD.
    std::string store_kept;  // model file whose expert cache was kept across the last suspend
    void suspend_locked(std::size_t keep_ram_mib = 0) {
        save_sheets();
        free_context_locked();
        if (model) {
            llama_model_free(model);
            model = nullptr;
            tmpls.reset();
        }
        {
            std::lock_guard<std::recursive_mutex> dl(g_decode_mx);
            llama_moe_set_expert_source(nullptr, nullptr);
            llama_moe_set_bulk_reader(nullptr, nullptr);
            llama_moe_set_expert_observer(nullptr, nullptr);
            ggml_cpu_set_expert_fetch(nullptr, nullptr);
            if (keep_ram_mib > 0 && cfg.ws_ram_mib > 0 && source.store.is_open()) {
                const std::size_t want = std::min<std::size_t>(keep_ram_mib, cfg.ws_ram_mib) * 1024 * 1024;
                if (source.store.capacity_bytes() > want) {
                    source.store.resize(want);  // hands the rest back to the OS now
                }
                store_kept = cfg.model;
            } else {
                source.store.close();
                store_kept.clear();
            }
            suspended = true;
        }
        write_index_locked();
    }

    // changes the resources; RAM cache only = in place, anything else = new context (threads sleep and wake lazily)
    bool apply_resources_locked(const json& b, std::string& err) {
        const Config old = cfg;
        auto get_sz = [&](const char* k, std::size_t& dst) {
            if (b.contains(k) && b[k].is_number()) {
                dst = static_cast<std::size_t>(std::max<long long>(0, b[k].get<long long>()));
            }
        };
        auto get_int = [&](const char* k, int& dst) {
            if (b.contains(k) && b[k].is_number()) {
                dst = std::max(1, b[k].get<int>());
            }
        };
        if (b.contains("preheat") && b["preheat"].is_boolean()) {
            std::lock_guard<std::mutex> l(sheets_mx);
            preheat = b["preheat"].get<bool>();
        }
        if (b.contains("typing_warm") && b["typing_warm"].is_boolean()) {
            typing_warm = b["typing_warm"].get<bool>();
            if (!typing_warm) {
                typing_cancel();
                typing_release();
            }
        }
        if (b.contains("typing_idle_s") && b["typing_idle_s"].is_number()) {
            typing_idle_s = std::min(900.0, std::max(5.0, b["typing_idle_s"].get<double>()));
        }
        if (b.contains("typing_boost_mib") && b["typing_boost_mib"].is_number()) {
            typing_boost_mib = std::max(0, b["typing_boost_mib"].get<int>());
        }
        if (b.contains("gear") && b["gear"].is_number()) {  // 0 = auto, 1..6 = manual
            cfg.gear = std::min(6, std::max(0, b["gear"].get<int>()));
            cfg.gear_user = true;
            cfg.margin_user_mib = 0;
            if (cfg.ws_ram_mib > 0) {
                cfg.margin_mib = static_cast<std::size_t>(gear_margin_mib(total_mib_now(), cfg.gear == 0 ? 3.0 : cfg.gear));
            }
        }
        get_sz("cache_mib", cfg.cache_mib);
        {
            std::size_t m = cfg.margin_mib;
            get_sz("mem_margin_mib", m);
            if (m != cfg.margin_mib) {
                cfg.margin_mib = cfg.margin_user_mib = m;  // takes effect at the next governor step; 0 = governor off
            }
        }
        get_sz("ws_ram_mib", cfg.ws_ram_mib);
        get_int("slots", cfg.slots);
        get_int("n_ctx", cfg.n_ctx);
        for (const char* k : {"kv_type", "kv_type_k", "kv_type_v"}) {  // "kv_type" sets both
            if (b.contains(k) && b[k].is_string() && kv_type_ok(b[k].get<std::string>())) {
                const std::string t = b[k].get<std::string>();
                if (std::string(k) != "kv_type_v") {
                    cfg.kv_type_k = t;
                }
                if (std::string(k) != "kv_type_k") {
                    cfg.kv_type_v = t;
                }
            }
        }
        if (b.contains("prefill_ubatch") && b["prefill_ubatch"].is_number()) {
            cfg.prefill_ubatch = std::max(0, b["prefill_ubatch"].get<int>());
        }
        if (old.ws_ram_mib > 0 && cfg.ws_ram_mib == 0) {
            cfg.ws_ram_mib = old.ws_ram_mib;  // streaming cannot be switched off at runtime (needs a model reload)
        }
        if (cfg.cache_mib != old.cache_mib || cfg.ws_ram_mib != old.ws_ram_mib) {
            cfg.profile_auto.clear();  // sizes edited by hand: no longer an adaptive profile
        }
        const bool ctx_change = cfg.cache_mib != old.cache_mib || cfg.slots != old.slots || cfg.n_ctx != old.n_ctx || cfg.kv_type_k != old.kv_type_k || cfg.kv_type_v != old.kv_type_v;
        if (suspended) {
            return true;  // takes effect at the next resume
        }
        if (ctx_change) {
            free_context_locked();
            if (!make_context_locked()) {
                err = error;
                cfg = old;
                make_context_locked();
                return false;
            }
        }
        if (cfg.ws_ram_mib != old.ws_ram_mib && cfg.ws_ram_mib > 0) {
            const std::size_t want = std::min(cfg.ws_ram_mib, source.store.max_capacity_bytes() / (1024 * 1024)) * 1024 * 1024;
            if (!source.store.resize(want)) {
                err = "RAM cache resize failed: " + source.store.last_error();
                return false;
            }
        }
        return true;
    }

    static std::string state_name(const std::string& key) { return "t-" + to_hex(std::hash<std::string>{}(key)) + ".kv"; }

    // ---- threads (one KV cache each) ----
    std::string state_file(const std::string& key) const {
        return (model_dir() / "state" / state_name(key)).string();
    }

    void sleep_thread_locked(const std::string& key) {
        Thread& t = threads[key];
        if (t.slot < 0 || !ctx) {
            return;
        }
        fs::create_directories(model_dir() / "state");
        const std::string f = state_file(key);
        llama_state_seq_save_file(ctx, f.c_str(), static_cast<llama_seq_id>(t.slot), t.tokens.data(), t.tokens.size());
        llama_memory_seq_rm(llama_get_memory(ctx), static_cast<llama_seq_id>(t.slot), -1, -1);
        owner[static_cast<std::size_t>(t.slot)].clear();
        t.slot = -1;
        t.tokens.clear();
        t.has_state = true;
    }

    void sleep_all_locked() {
        for (auto& [k, t] : threads) {
            if (t.slot >= 0) {
                sleep_thread_locked(k);
            }
        }
        write_index_locked();
    }

    bool wake_locked(const std::string& key) {
        Thread& t = threads[key];
        t.last_used = ++tick;
        if (t.slot >= 0) {
            return true;
        }
        int slot = -1;
        for (std::size_t k = 0; k < owner.size() && slot < 0; ++k) {
            if (owner[k].empty()) {
                slot = static_cast<int>(k);
            }
        }
        if (slot < 0) {  // evict the least recently used thread
            std::string victim;
            std::uint64_t oldest = ~0ull;
            for (const auto& o : owner) {
                if (threads[o].last_used < oldest) {
                    oldest = threads[o].last_used;
                    victim = o;
                }
            }
            slot = threads[victim].slot;
            sleep_thread_locked(victim);
        }
        llama_memory_seq_rm(llama_get_memory(ctx), static_cast<llama_seq_id>(slot), -1, -1);
        t.slot = slot;
        t.tokens.clear();
        owner[static_cast<std::size_t>(slot)] = key;
        if (t.has_state) {
            std::vector<llama_token> buf(static_cast<std::size_t>(cfg.n_ctx));
            std::size_t n = 0;
            if (llama_state_seq_load_file(ctx, state_file(key).c_str(), static_cast<llama_seq_id>(slot), buf.data(), buf.size(), &n) == 0) {
                llama_memory_seq_rm(llama_get_memory(ctx), static_cast<llama_seq_id>(slot), -1, -1);  // unreadable: start over
            } else {
                buf.resize(n);
                t.tokens = std::move(buf);
            }
        }
        return true;
    }

    // Job checkpoint side file: the logits that follow the last token of the saved state. A recurrent state cannot be cut back by one
    // token to re-decode it, so without these the resume could not continue exactly where the run stopped.
    void save_job_logits(const std::string& key, std::size_t n_tokens, const float* lg) {
        if (!lg) {
            return;
        }
        const std::string f = state_file(key) + ".logits";
        if (std::FILE* o = std::fopen((f + ".tmp").c_str(), "wb")) {
            const std::uint64_t n = n_tokens;
            const std::int32_t nv = llama_vocab_n_tokens(vocab);
            std::fwrite(&n, sizeof(n), 1, o);
            std::fwrite(&nv, sizeof(nv), 1, o);
            std::fwrite(lg, sizeof(float), static_cast<std::size_t>(nv), o);
            std::fclose(o);
            std::error_code ec;
            fs::rename(f + ".tmp", f, ec);
        }
    }
    bool load_job_logits(const std::string& key, std::size_t n_tokens, std::vector<float>& out) {
        std::FILE* i = std::fopen((state_file(key) + ".logits").c_str(), "rb");
        if (!i) {
            return false;
        }
        std::uint64_t n = 0;
        std::int32_t nv = 0;
        bool ok = std::fread(&n, sizeof(n), 1, i) == 1 && std::fread(&nv, sizeof(nv), 1, i) == 1 && n == n_tokens && nv == llama_vocab_n_tokens(vocab);
        if (ok) {
            out.resize(static_cast<std::size_t>(nv));
            ok = std::fread(out.data(), sizeof(float), out.size(), i) == out.size();
        }
        std::fclose(i);
        return ok;
    }

    // End-of-prompt checkpoint (recurrent / hybrid models): a copy of the state right after the prompt was read, before any generated token.
    std::string prompt_end_file(const std::string& key) const { return state_file(key) + ".pe"; }
    void save_prompt_end(const std::string& key, llama_seq_id seq, const std::vector<llama_token>& toks) {
        fs::create_directories(model_dir() / "state");
        const std::string f = prompt_end_file(key), tmp = f + ".tmp";
        if (llama_state_seq_save_file(ctx, tmp.c_str(), seq, toks.data(), toks.size()) > 0) {
            std::error_code ec;
            fs::rename(tmp, f, ec);
        }
    }
    // Loads the checkpoint into the (empty) slot of `t` when its tokens are a strict prefix of `toks` (with `strict` false, also equal).
    // Returns the number of tokens now held (0 = unusable, the slot is left empty).
    std::size_t restore_prompt_end(const std::string& key, Thread& t, const std::vector<llama_token>& toks, bool /*have_logits*/) {
        const std::string f = prompt_end_file(key);
        std::error_code ec;
        if (!fs::exists(f, ec) || t.slot < 0) {
            return 0;
        }
        llama_memory_seq_rm(llama_get_memory(ctx), static_cast<llama_seq_id>(t.slot), -1, -1);
        std::vector<llama_token> buf(static_cast<std::size_t>(cfg.n_ctx));
        std::size_t n = 0;
        if (llama_state_seq_load_file(ctx, f.c_str(), static_cast<llama_seq_id>(t.slot), buf.data(), buf.size(), &n) == 0) {
            llama_memory_seq_rm(llama_get_memory(ctx), static_cast<llama_seq_id>(t.slot), -1, -1);
            return 0;
        }
        buf.resize(n);
        bool prefix = n > 0 && n < toks.size();  // at least one token must still be decoded to get logits
        for (std::size_t i = 0; prefix && i < n; ++i) {
            prefix = buf[i] == toks[i];
        }
        if (!prefix) {
            llama_memory_seq_rm(llama_get_memory(ctx), static_cast<llama_seq_id>(t.slot), -1, -1);
            return 0;
        }
        t.tokens = std::move(buf);
        return n;
    }

    void drop_thread_locked(const std::string& key) {
        auto it = threads.find(key);
        if (it == threads.end()) {
            std::error_code ec0;
            fs::remove(state_file(key) + ".logits", ec0);
            fs::remove(prompt_end_file(key), ec0);
            fs::remove(state_file(key), ec0);  // a state file may exist without the thread being loaded (job after a restart)
            return;
        }
        if (it->second.slot >= 0 && ctx) {
            llama_memory_seq_rm(llama_get_memory(ctx), static_cast<llama_seq_id>(it->second.slot), -1, -1);
            owner[static_cast<std::size_t>(it->second.slot)].clear();
        }
        std::error_code ec;
        fs::remove(state_file(key) + ".logits", ec);
        fs::remove(prompt_end_file(key), ec);
        fs::remove(state_file(key), ec);
        threads.erase(it);
    }

    // ---- persistence of the thread list (the KV files themselves are written when threads go to sleep) ----
    std::string fingerprint() const {
        std::error_code ec;
        return fs::path(cfg.model).filename().string() + ":" + std::to_string(model_bytes(cfg.model)) + ":" + std::to_string(cfg.n_ctx) + ":u1:k" + cfg.kv_type_k + ":v" + cfg.kv_type_v + (cfg.swa_full ? "" : ":swa");
    }

    void write_index_locked() {
        fs::create_directories(model_dir());
        json j;
        j["fingerprint"] = fingerprint();
        j["threads"] = json::array();
        for (const auto& [k, t] : threads) {
            if (t.has_state) {
                j["threads"].push_back(k);
            }
        }
        std::ofstream(model_dir() / "threads.json") << j.dump(1);
    }

    void read_index() {
        std::ifstream in(model_dir() / "threads.json");
        if (!in) {
            return;
        }
        json j = json::parse(in, nullptr, false);
        if (j.is_discarded() || j.value("fingerprint", "") != fingerprint()) {
            return;
        }
        for (const auto& k : j["threads"]) {
            if (fs::exists(state_file(k.get<std::string>()))) {
                threads[k.get<std::string>()].has_state = true;
            }
        }
    }

    // ---- generation ----
    static bool uses_tools(const json& messages, const Sampling& sp) {
        if (sp.has_tools()) {
            return true;
        }
        for (const auto& m : messages) {
            if (m.is_object() && (m.value("role", "") == "tool" || m.contains("tool_calls"))) {
                return true;
            }
        }
        return false;
    }

    // chat-template inputs for an agentic request: OpenAI messages (tool_calls, tool results) and tools parsed by llama.cpp's own code
    common_chat_templates_inputs tool_inputs(const json& messages, const Sampling& sp) {
        common_chat_templates_inputs in;
        in.use_jinja = true;
        in.add_generation_prompt = true;
        in.enable_thinking = sp.enable_thinking;
        in.messages = common_chat_msgs_parse_oaicompat(common_json::parse(messages.dump()));
        if (sp.has_tools()) {
            in.tools = common_chat_tools_parse_oaicompat(common_json::parse(sp.tools.dump()));
            in.tool_choice = common_chat_tool_choice_parse_oaicompat(sp.tool_choice);
            in.parallel_tool_calls = sp.parallel_tool_calls;
        }
        return in;
    }

    // Parses a finished generation into content / reasoning / tool calls (the template decides the syntax).
    common_chat_msg parse_output(const json& messages, const Sampling& sp, const std::string& text) {
        std::lock_guard<std::mutex> lock(mx);
        common_chat_session session(tmpls.get(), vocab, tool_inputs(messages, sp));
        return common_chat_msg(session.finish(common_chat_input(text)));
    }

    std::string render(const json& messages, const Sampling& sp) {
        const bool enable_thinking = sp.enable_thinking;
        if (uses_tools(messages, sp)) {
            try {
                return common_chat_templates_apply(tmpls.get(), tool_inputs(messages, sp)).prompt.str();
            } catch (const std::exception&) {
            }
        }
        auto build = [&](bool merge_system) {
            common_chat_templates_inputs in;
            in.use_jinja = true;
            in.add_generation_prompt = true;
            in.enable_thinking = enable_thinking;
            std::string pending_sys;
            for (const auto& m : messages) {
                common_chat_msg cm;
                cm.role = m.value("role", "user");
                if (m["content"].is_string()) {
                    cm.content = m["content"].get<std::string>();
                } else if (m["content"].is_array()) {
                    for (const auto& part : m["content"]) {
                        if (part.is_object() && part.contains("text")) {
                            cm.content += part["text"].get<std::string>();
                        }
                    }
                }
                if (merge_system && cm.role == "system") {
                    pending_sys += (pending_sys.empty() ? "" : "\n\n") + cm.content;
                    continue;
                }
                if (merge_system && cm.role == "user" && !pending_sys.empty()) {
                    cm.content = pending_sys + "\n\n" + cm.content;
                    pending_sys.clear();
                }
                in.messages.push_back(cm);
            }
            return common_chat_templates_apply(tmpls.get(), in).prompt.str();
        };
        try {
            return build(false);
        } catch (const std::exception&) {
            return build(true);
        }
    }

    llama_sampler* make_sampler(const Sampling& sp) {
        llama_sampler* s = llama_sampler_chain_init(llama_sampler_chain_default_params());
        if (sp.repeat_penalty != 1.0f || sp.presence_penalty != 0.0f || sp.frequency_penalty != 0.0f) {
            llama_sampler_chain_add(s, llama_sampler_init_penalties(llama_vocab_n_tokens(vocab), sp.penalty_last_n, sp.repeat_penalty,
                                                                    sp.frequency_penalty, sp.presence_penalty));
        }
        if (sp.dry_multiplier > 0.0f) {
            std::vector<const char*> br;
            for (const auto& b : sp.dry_breakers) {
                br.push_back(b.c_str());
            }
            llama_sampler_chain_add(s, llama_sampler_init_dry(vocab, sp.dry_multiplier, sp.dry_base, sp.dry_allowed_length,
                                                              sp.dry_penalty_last_n < 0 ? cfg.n_ctx : sp.dry_penalty_last_n, br.data(), br.size()));
        }
        if (sp.temperature <= 0.0f) {
            llama_sampler_chain_add(s, llama_sampler_init_greedy());
            return s;
        }
        if (sp.top_k > 0) {
            llama_sampler_chain_add(s, llama_sampler_init_top_k(sp.top_k));
        }
        if (sp.top_p < 1.0f) {
            llama_sampler_chain_add(s, llama_sampler_init_top_p(sp.top_p, 1));
        }
        if (sp.min_p > 0.0f) {
            llama_sampler_chain_add(s, llama_sampler_init_min_p(sp.min_p, 1));
        }
        llama_sampler_chain_add(s, llama_sampler_init_temp(sp.temperature));
        llama_sampler_chain_add(s, llama_sampler_init_dist(sp.seed));
        return s;
    }

    // `on_text` receives the new text as it is produced; returning false stops the generation
    bool generate(const std::string& key, const json& messages, const Sampling& sp, const std::function<bool(const std::string&)>& on_text,
                  GenResult& res, std::string& err, JobHook* job = nullptr) {
        // a request without a hook is a foreground one (a conversation): background work (summaries) steps aside while it waits
        const bool fg = job == nullptr;
        if (fg) {
            held_off = false;  // a dialogue wakes the model again
            ++fg_waiting;
            typing_cancel();
        }
        std::unique_lock<std::mutex> lock(mx);
        if (fg) {
            --fg_waiting;
        }
        ++gen_running;
        const double t_gen0 = now_s();
        const bool ok = generate_locked(key, messages, sp, on_text, res, err, job);
        --gen_running;
        char pal_txt[96] = "";
        if (res.pal_mib > 0) {
            std::snprintf(pal_txt, sizeof(pal_txt), " palier=%.0fMiB free=%.0fMiB", res.pal_mib, res.pal_free_mib);
        }
        std::fprintf(stderr, "[gen] %s key=%s prompt=%d reused=%d prefill=%.1fs gen=%d tok %.1fs total=%.1fs%s%s%s%s\n", fg ? "fg" : "bg", key.substr(0, 24).c_str(),
                     res.prompt_tokens, res.reused_tokens, res.prefill_s, res.completion_tokens, res.gen_s, now_s() - t_gen0, res.boosted ? " boosted" : "",
                     pal_txt, res.memory_pause ? " MEMORY-PAUSE" : "", ok ? "" : " FAILED");
        lock.unlock();
        if (fg) {
            typing_release();  // the answer is written: the burst of the typing warm-up goes back
            if (cfg.light) {
                trim_working_set();
            }
        }
        if (fg && ok && on_generated) {
            on_generated();
        }
        return ok;
    }

    // A background generation (summaries of old days, journal notes...) made of small slices: 64 prompt tokens, then 8 generated tokens at a
    // time. Between two slices any conversation (or decision) that is waiting for the engine goes first, and the background work resumes
    // when it is done. The text is complete only when the slices end; a dialogue never waits for more than one slice.
    bool generate_sliced(const std::string& key, const json& messages, Sampling sp, GenResult& out, std::string& err,
                         const std::function<bool()>& client_gone = nullptr) {
        constexpr std::size_t kSlice = 8;
        const std::size_t total = sp.max_tokens > 0 ? static_cast<std::size_t>(sp.max_tokens) : 450;
        JobHook hook;
        hook.max_prefill = 64;
        hook.checkpoint_s = 1e9;
        std::vector<llama_token> got;
        hook.on_token = [&](llama_token t) { got.push_back(t); };
        GenResult r;
        std::string text_out;
        bool ok = true;
        const std::string bg_key = "bg:" + key;
        for (;;) {
            for (int w = 0; (fg_waiting.load() > 0 || g_decide_pending.load() > 0 || suspend_waiting.load() > 0 || held_off.load()) && w < 12000; ++w) {  // up to 10 min of politeness
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
            }
            if (client_gone && client_gone()) {  // nobody waits for this text any more (the caller quit): stop, free the engine
                ok = false;
                err = "client disconnected";
                break;
            }
            hook.prior = got;
            hook.prior_text.clear();
            sp.max_tokens = static_cast<int>(std::min(total, got.size() + kSlice));
            r = GenResult();
            if (!generate(bg_key, messages, sp, [](const std::string&) { return true; }, r, err, &hook)) {
                ok = false;
                break;
            }
            if (r.finish == "prefill_partial") {
                continue;
            }
            text_out = hook.prior_text + r.text;
            if (r.finish == "stop" || got.size() >= total) {
                if (r.finish != "stop") {
                    r.finish = "length";
                }
                break;
            }
        }
        {
            std::lock_guard<std::mutex> l(mx);
            drop_thread_locked(bg_key);
        }
        if (!ok) {
            return false;
        }
        r.text = text_out;
        r.completion_tokens = static_cast<int>(got.size());
        out = r;
        return true;
    }

    // Reads the prompt of the NEXT dialogue turn while the user is still reading the last answer: same thread `key` as the real request,
    // big micro-batch, one token generated at the end. A waiting dialogue / decision / image cuts it between two batches; what was read stays.
    bool prewarm(const std::string& key, const json& messages, Sampling sp, GenResult& out, std::string& err, const std::function<bool()>& client_gone = nullptr) {
        JobHook hook;
        hook.max_prefill = 0;
        hook.prewarm = true;
        hook.checkpoint_s = 1e9;
        hook.on_token = [](llama_token) {};
        sp.max_tokens = 1;
        for (;;) {
            for (int w = 0; (fg_waiting.load() > 0 || g_decide_pending.load() > 0 || suspend_waiting.load() > 0 || held_off.load()) && w < 12000; ++w) {
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
            }
            if (client_gone && client_gone()) {
                err = "client disconnected";
                return false;
            }
            GenResult r;
            if (!generate(key, messages, sp, [](const std::string&) { return true; }, r, err, &hook)) {
                return false;
            }
            if (r.finish == "prefill_partial") {
                continue;
            }
            out = r;
            return true;
        }
    }

    // ---- decisions in one pass ----
    // All the questions about one state: the common prefix of their prompts goes through the model once (and stays in the thread `key`),
    // then every question's own tokens ride in the same micro-batch, each on its own sequence (the prefix is shared by seq_cp, which
    // only tags KV cells). Each layer's experts are thus read once for all the questions. Returns, per question, the logits at the
    // last prompt token. Questions beyond the free sequences / the micro-batch size go in further groups.
    bool decide_batch(const std::string& key, const std::vector<json>& msgs, const Sampling& sp, std::vector<std::vector<float>>& out, DecideStats& st,
                      std::string& err) {
        ++fg_waiting;
        std::unique_lock<std::mutex> lock(mx);
        --fg_waiting;
        return decide_batch_locked(key, msgs, sp, out, st, err);
    }

    bool decide_batch_locked(const std::string& key, const std::vector<json>& msgs, const Sampling& sp, std::vector<std::vector<float>>& out, DecideStats& st,
                             std::string& err) {
        if (!ensure_running_locked()) {
            err = error;
            return false;
        }
        set_domain_locked("decide");
        const std::size_t nq = msgs.size();
        std::vector<std::vector<llama_token>> toks(nq);
        for (std::size_t k = 0; k < nq; ++k) {
            const std::string prompt = render(msgs[k], sp);
            const bool add_bos = llama_vocab_get_add_bos(vocab) && !(!bos_text.empty() && prompt.rfind(bos_text, 0) == 0);
            const int n = -llama_tokenize(vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), nullptr, 0, add_bos, true);
            toks[k].resize(static_cast<std::size_t>(std::max(n, 0)));
            if (n > 0) {
                llama_tokenize(vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), toks[k].data(), n, add_bos, true);
            }
            if (toks[k].empty() || static_cast<int>(toks[k].size()) + 8 >= cfg.n_ctx) {
                err = "question " + std::to_string(k) + " exceeds the context size (n_ctx " + std::to_string(cfg.n_ctx) + ", prompt " + std::to_string(toks[k].size()) + " tokens)";
                return false;
            }
            st.full_tokens += static_cast<int>(toks[k].size());
        }
        // longest prefix shared by all the prompts; every question keeps at least one token of its own (to read its logits)
        std::size_t cp = toks[0].size();
        for (std::size_t k = 1; k < nq; ++k) {
            std::size_t c = 0;
            while (c < cp && c < toks[k].size() && toks[k][c] == toks[0][c]) {
                ++c;
            }
            cp = c;
        }
        for (std::size_t k = 0; k < nq; ++k) {
            cp = std::min(cp, toks[k].size() - 1);
        }
        wake_locked(key);
        Thread& th = threads[key];
        const llama_seq_id s0 = static_cast<llama_seq_id>(th.slot);
        llama_memory_t mem = llama_get_memory(ctx);
        std::size_t common = 0;
        while (common < th.tokens.size() && common < cp && th.tokens[common] == toks[0][common]) {
            ++common;
        }
        if (common < th.tokens.size()) {
            if (!llama_memory_seq_rm(mem, s0, static_cast<llama_pos>(common), -1)) {
                llama_memory_seq_rm(mem, s0, -1, -1);
                common = 0;
            }
            th.tokens.resize(common);
        }
        llama_batch b = llama_batch_init(512, 0, static_cast<int32_t>(owner.size()) + 1);
        bool ok = true;
        // sequences for the questions: free slots first, then the least recently used threads are put to sleep
        std::vector<int> tmp;
        const std::string kTmp = "\x01" "decide-tmp";
        while (ok && tmp.size() + 1 < owner.size() && tmp.size() < nq) {
            int slot = -1;
            for (std::size_t i = 0; i < owner.size() && slot < 0; ++i) {
                if (static_cast<llama_seq_id>(i) != s0 && owner[i].empty()) {
                    slot = static_cast<int>(i);
                }
            }
            if (slot < 0) {
                std::string victim;
                std::uint64_t oldest = ~0ull;
                for (std::size_t i = 0; i < owner.size(); ++i) {
                    if (static_cast<llama_seq_id>(i) != s0 && owner[i] != kTmp && threads[owner[i]].last_used < oldest) {
                        oldest = threads[owner[i]].last_used;
                        victim = owner[i];
                    }
                }
                if (victim.empty()) {
                    break;
                }
                slot = threads[victim].slot;
                sleep_thread_locked(victim);
            }
            llama_memory_seq_rm(mem, static_cast<llama_seq_id>(slot), -1, -1);
            owner[static_cast<std::size_t>(slot)] = kTmp;
            tmp.push_back(slot);
        }
        if (ok && tmp.empty()) {
            err = "no free sequence for the questions (raise --decider-slots)";
            ok = false;
        }
        // when the new part of the prefix and every question's own tokens fit one micro-batch, they go through the model in ONE pass
        // (the prefix tokens carry the sequence of the thread and those of all the questions): each layer's experts are read once, not twice
        std::size_t sum_all = 0;
        for (std::size_t k = 0; k < nq; ++k) {
            sum_all += toks[k].size() - cp;
        }
        const std::size_t new_prefix = cp - common;
        const bool merged = ok && new_prefix > 0 && tmp.size() >= nq && new_prefix + sum_all <= 512;
        for (std::size_t off = common; off < cp && ok && !merged; off += 512) {  // the shared prefix
            const std::size_t m = std::min<std::size_t>(512, cp - off);
            for (std::size_t i = 0; i < m; ++i) {
                b.token[i] = toks[0][off + i];
                b.pos[i] = static_cast<llama_pos>(off + i);
                b.n_seq_id[i] = 1;
                b.seq_id[i][0] = s0;
                b.logits[i] = false;
            }
            b.n_tokens = static_cast<int32_t>(m);
            if (decode_bound(b)) {
                err = "prefix prefill failed";
                ok = false;
            }
            ++st.passes;
            st.new_tokens += static_cast<int>(m);
            governor_tick();
        }
        if (ok && !merged) {
            th.tokens.assign(toks[0].begin(), toks[0].begin() + static_cast<std::ptrdiff_t>(cp));
            th.last_used = ++tick;
        }
        out.assign(nq, {});
        const int nv = llama_vocab_n_tokens(vocab);
        std::size_t qi = 0;
        while (ok && qi < nq) {
            std::size_t gj = qi, sum = 0;
            while (gj < nq && gj - qi < tmp.size() && sum + (toks[gj].size() - cp) <= 512) {
                sum += toks[gj].size() - cp;
                ++gj;
            }
            if (gj == qi) {
                err = "question " + std::to_string(qi) + " is bigger than a micro-batch (512 tokens)";
                ok = false;
                break;
            }
            int bi = 0;
            std::vector<int> last(gj - qi);
            if (merged) {
                for (std::size_t i = 0; i < new_prefix; ++i, ++bi) {
                    b.token[bi] = toks[0][common + i];
                    b.pos[bi] = static_cast<llama_pos>(common + i);
                    b.n_seq_id[bi] = static_cast<int32_t>(1 + (gj - qi));
                    b.seq_id[bi][0] = s0;
                    for (std::size_t k = qi; k < gj; ++k) {
                        b.seq_id[bi][1 + (k - qi)] = static_cast<llama_seq_id>(tmp[k - qi]);
                    }
                    b.logits[bi] = false;
                }
            }
            for (std::size_t k = qi; k < gj; ++k) {
                const llama_seq_id sq = static_cast<llama_seq_id>(tmp[k - qi]);
                const std::size_t shared = merged ? common : cp;  // the cached part of the prefix; a merged pass computes the rest itself
                if (shared > 0) {
                    llama_memory_seq_cp(mem, s0, sq, 0, static_cast<llama_pos>(shared));
                }
                for (std::size_t i = cp; i < toks[k].size(); ++i, ++bi) {
                    b.token[bi] = toks[k][i];
                    b.pos[bi] = static_cast<llama_pos>(i);
                    b.n_seq_id[bi] = 1;
                    b.seq_id[bi][0] = sq;
                    b.logits[bi] = i + 1 == toks[k].size();
                }
                last[k - qi] = bi - 1;
            }
            b.n_tokens = bi;
            const double t_pass = now_s();
            if (decode_bound(b)) {
                err = "decode failed";
                ok = false;
            } else {
                if (merged) {
                    th.tokens.assign(toks[0].begin(), toks[0].begin() + static_cast<std::ptrdiff_t>(cp));
                    th.last_used = ++tick;
                }
                std::fprintf(stderr, "[decide] pass: %d tokens, %zu questions, %.0f ms (ubatch %d)\n", bi, gj - qi, (now_s() - t_pass) * 1000.0, cur_ubatch > 0 ? cur_ubatch : cfg.ubatch);
                for (std::size_t k = qi; k < gj; ++k) {
                    const float* lg = llama_get_logits_ith(ctx, last[k - qi]);
                    if (lg) {
                        out[k].assign(lg, lg + nv);
                    }
                }
            }
            ++st.passes;
            st.new_tokens += static_cast<int>(sum);
            for (std::size_t k = qi; k < gj; ++k) {
                llama_memory_seq_rm(mem, static_cast<llama_seq_id>(tmp[k - qi]), -1, -1);
            }
            governor_tick();
            qi = gj;
        }
        for (const int slot : tmp) {
            llama_memory_seq_rm(mem, static_cast<llama_seq_id>(slot), -1, -1);
            owner[static_cast<std::size_t>(slot)].clear();
        }
        llama_batch_free(b);
        for (const auto& o : out) {
            if (ok && o.empty()) {
                err = "no logits";
                ok = false;
            }
        }
        return ok;
    }

    // changes the VRAM expert cache: the context is rebuilt (threads sleep on disk and wake lazily, ~1-2 s measured); the PhaseMgr does it
    // while the player reads. Does not touch the profile (an adaptive profile stays adaptive).
    bool set_vram_cache_locked(std::size_t mib, std::string& err) {
        if (cfg.cache_mib == mib) {
            return true;
        }
        const std::size_t old = cfg.cache_mib;
        cfg.cache_mib = mib;
        if (suspended || !ctx) {
            return true;  // takes effect at the next context
        }
        std::lock_guard<std::recursive_mutex> dl(g_decode_mx);
        free_context_locked();
        if (!make_context_locked()) {
            err = error;
            cfg.cache_mib = old;
            make_context_locked();
            bind_hooks();
            return false;
        }
        bind_hooks();
        return true;
    }

    bool generate_locked(const std::string& key, const json& messages, const Sampling& sp, const std::function<bool(const std::string&)>& on_text,
                         GenResult& res, std::string& err, JobHook* job = nullptr) {
        if (!ensure_running_locked()) {
            err = error;
            return false;
        }
        paliers_decide(res);  // "paliers": the cache size for the whole of this request
        set_domain_locked(sp.domain.empty() ? std::string("general") : sp.domain);
        if (!job) {
            stop_request = false;  // a stop aimed at an earlier generation must not cut this one
        }
        const std::string prompt = render(messages, sp);
        const bool add_bos = llama_vocab_get_add_bos(vocab) && !(!bos_text.empty() && prompt.rfind(bos_text, 0) == 0);
        int n = -llama_tokenize(vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), nullptr, 0, add_bos, true);
        std::vector<llama_token> toks(static_cast<std::size_t>(std::max(n, 0)));
        if (n > 0) {
            llama_tokenize(vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), toks.data(), n, add_bos, true);
        }
        if (job) {
            for (const llama_token t : job->prior) {
                char pc[256];
                const int pn = llama_token_to_piece(vocab, t, pc, sizeof(pc), 0, false);
                if (pn > 0) {
                    job->prior_text.append(pc, static_cast<std::size_t>(pn));
                }
            }
            toks.insert(toks.end(), job->prior.begin(), job->prior.end());
            Thread& jt = threads[key];
            if (jt.slot < 0) {
                jt.has_state = fs::exists(state_file(key));  // the last checkpoint, if any
            }
        }
        res.prompt_tokens = static_cast<int>(toks.size());
        if (toks.empty() || static_cast<int>(toks.size()) + 8 + sp.reserve >= cfg.n_ctx) {
            res.overflow = true;
            err = "the request exceeds the available context size (n_ctx " + std::to_string(cfg.n_ctx) + ", prompt " + std::to_string(toks.size()) + " tokens)";
            return false;
        }
        // when the KV cache can shift, a long answer never stops at the end of the context: the oldest exchanges are dropped instead
        const bool can_shift = !job && llama_memory_can_shift(llama_get_memory(ctx));
        const int room = can_shift ? sp.max_tokens : cfg.n_ctx - static_cast<int>(toks.size()) - 1;
        const int max_new = std::min(sp.max_tokens - (job ? static_cast<int>(job->prior.size()) : 0), room);
        int n_keep = -1;  // tokens that survive a shift (the system prompt), computed on first need
        auto keep_prefix = [&]() -> int {
            if (messages.empty() || messages[0].value("role", "") != "system") {
                return 1;
            }
            const std::string sys = render(json::array({messages[0]}), sp);
            const bool bos = llama_vocab_get_add_bos(vocab) && !(!bos_text.empty() && sys.rfind(bos_text, 0) == 0);
            int m = -llama_tokenize(vocab, sys.c_str(), static_cast<int32_t>(sys.size()), nullptr, 0, bos, true);
            std::vector<llama_token> v(static_cast<std::size_t>(std::max(m, 0)));
            if (m > 0) {
                llama_tokenize(vocab, sys.c_str(), static_cast<int32_t>(sys.size()), v.data(), m, bos, true);
            }
            std::size_t c = 0;
            while (c < v.size() && c < toks.size() && v[c] == toks[c]) {
                ++c;
            }
            return static_cast<int>(std::max<std::size_t>(1, std::min(c, toks.size() / 2)));
        };

        // A big prompt is prefilled with a big micro-batch: every layer's experts are then read once for many tokens
        // instead of once per 32. The micro-batch is fixed when the context is created, so the context is rebuilt
        // (threads are saved and restored, ~1 s) and rebuilt again for generation.
        std::size_t known = 0;
        wake_locked(key);  // a sleeping thread (pre-cache, character) is loaded first, so what it already holds counts as known
        if (const auto it = threads.find(key); it != threads.end() && it->second.slot >= 0) {
            const auto& tk = it->second.tokens;
            while (known < tk.size() && known < toks.size() && tk[known] == toks[known]) {
                ++known;
            }
        }
        // Recurrent / hybrid models (Qwen3-Next...) cannot cut their state back by even one token: a restored thread is only usable
        // if it is a plain prefix of what must be read now AND (for a job) the saved logits of its last token are there.
        const bool recurrent_model = llama_model_is_recurrent(model) || llama_model_is_hybrid(model);
        const std::size_t n_prompt_part = job ? toks.size() - job->prior.size() : toks.size();  // a job: what the original run read in big batches
        std::vector<float> saved_logits;                                                       // logits after the last restored token (job checkpoint)
        bool have_logits = false;
        if (job && known > 0) {
            const Thread& jt = threads[key];
            if (jt.slot >= 0 && known == jt.tokens.size() && known == toks.size()) {
                have_logits = load_job_logits(key, known, saved_logits);
            }
        }
        if (recurrent_model) {
            if (const auto it = threads.find(key); it != threads.end() && it->second.slot >= 0) {
                const std::size_t held = it->second.tokens.size();
                const bool must_cut = known < held || (known == held && known == toks.size() && !have_logits);  // would need a cut (or a re-decode of the last token)
                if (must_cut || held == 0) {
                    const std::size_t known_old = known;
                    if (must_cut) {
                        llama_memory_seq_rm(llama_get_memory(ctx), static_cast<llama_seq_id>(it->second.slot), -1, -1);
                        it->second.tokens.clear();
                        known = 0;
                    }
                    // End-of-prompt checkpoint: the state saved when the previous request's prompt had just been read. The next request
                    // (previous prompt + answer as the client re-formats it + new message) usually still starts with exactly those tokens.
                    const std::size_t pe = restore_prompt_end(key, it->second, toks, have_logits);
                    if (pe > 0) {
                        known = pe;
                        std::fprintf(stderr, "[resume] %s: recurrent model, the saved state (%zu tokens) cannot be cut back to %zu: restarted from the end-of-prompt checkpoint (%zu tokens), %zu new tokens to read\n",
                                     key.substr(0, 24).c_str(), held, known_old, pe, toks.size() - pe);
                    } else if (must_cut) {
                        std::fprintf(stderr, "[resume] %s: recurrent model, the saved state (%zu tokens) cannot be cut back to %zu and %s: the prompt is read again from zero with the fast prefill\n",
                                     key.substr(0, 24).c_str(), held, known_old, known_old == held ? "its logits were not saved" : "it is not a prefix of the request");
                    }
                }
            }
        }
        const std::size_t to_read_fast = job ? (n_prompt_part > known ? n_prompt_part - known : 0) : toks.size() - known;
        const bool boost = !(job && job->max_prefill > 0) && cfg.prefill_ubatch > cfg.ubatch && to_read_fast > 128;
        if (boost) {
            free_context_locked();
            cur_ubatch = cfg.prefill_ubatch;
            if (!make_context_locked()) {
                err = error;
                return false;
            }
            res.boosted = true;
            ++boosts;
        }
        wake_locked(key);
        Thread& th = threads[key];
        llama_seq_id seq = static_cast<llama_seq_id>(th.slot);
        // reuse the longest common prefix with what the KV already holds
        std::size_t common = 0;
        while (common < th.tokens.size() && common < toks.size() && th.tokens[common] == toks[common]) {
            ++common;
        }
        if (!have_logits) {
            common = std::min(common, toks.size() - 1);  // at least one token must be decoded to get logits
        }
        if (common < th.tokens.size()) {
            if (!llama_memory_seq_rm(llama_get_memory(ctx), seq, static_cast<llama_pos>(common), -1)) {  // recurrent models cannot cut
                llama_memory_seq_rm(llama_get_memory(ctx), seq, -1, -1);
                common = 0;
            }
            th.tokens.resize(common);
        }
        res.reused_tokens = static_cast<int>(common);

        llama_sampler* smpl = make_sampler(sp);
        for (const llama_token t : toks) {
            llama_sampler_accept(smpl, t);
        }
        const double t0 = now_s();
        const std::size_t pf_step = boost ? static_cast<std::size_t>(std::max(512, cfg.prefill_ubatch)) : 512;
        llama_batch b = llama_batch_init(static_cast<int32_t>(pf_step), 0, 1);
        bool ok = true;
        const std::size_t limit = job && job->max_prefill > 0 ? std::min(toks.size(), common + static_cast<std::size_t>(job->max_prefill)) : toks.size();
        std::size_t aborted_at = 0;  // prewarm: the prompt tokens read before a waiting dialogue made us stop
        bool mem_abort = false;      // "paliers": stopped by the critical free-RAM threshold
        bool user_abort = false;     // a job / resumable request paused by the user while the prompt is being read
        std::size_t m = 0;
        for (std::size_t off = common; off < limit && ok; off += m) {
            m = std::min<std::size_t>(pf_step, limit - off);
            const bool replay = job && off >= n_prompt_part;  // tokens the job generated before: replayed one by one, as they were produced
            if (job && off < n_prompt_part) {
                m = std::min(m, n_prompt_part - off);  // same batch boundaries as the original prefill
            } else if (replay) {
                m = 1;
            }
            for (std::size_t i = 0; i < m; ++i) {
                b.token[i] = toks[off + i];
                b.pos[i] = static_cast<llama_pos>(off + i);
                b.n_seq_id[i] = 1;
                b.seq_id[i][0] = seq;
                b.logits[i] = replay || off + i + 1 == toks.size();
            }
            b.n_tokens = static_cast<int32_t>(m);
            if (decode_bound(b)) {
                err = "prefill failed";
                ok = false;
            }
            governor_tick();
            if (ok && off + m < limit && mem_emergency.load()) {  // "paliers": the free RAM is critical, stop between two micro-batches
                aborted_at = off + m;
                mem_abort = true;
                break;
            }
            if (ok && job && job->pause && job->pause->load() && off + m < limit) {  // pause requested during the prefill: KV of what was read is saved
                aborted_at = off + m;
                user_abort = true;
                break;
            }
            if (ok && job && job->prewarm && off + m < limit && (fg_waiting.load() > 0 || g_decide_pending.load() > 0 || suspend_waiting.load() > 0)) {
                aborted_at = off + m;
                break;
            }
        }
        if (aborted_at > 0) {  // prewarm cut short: keep what was read, go back to the frugal micro-batch, let the waiting request in
            th.tokens.assign(toks.begin(), toks.begin() + static_cast<std::ptrdiff_t>(aborted_at));
            if ((mem_abort || user_abort) && job) {  // resume point: the KV of the prompt read so far
                fs::create_directories(model_dir() / "state");
                const std::string f = state_file(key), tmp = f + ".tmp";
                if (llama_state_seq_save_file(ctx, tmp.c_str(), seq, th.tokens.data(), th.tokens.size()) > 0) {
                    std::error_code ec;
                    fs::rename(tmp, f, ec);
                }
            }
            llama_batch_free(b);
            llama_sampler_free(smpl);
            th.last_used = ++tick;
            res.finish = "prefill_partial";
            if (mem_abort) {
                res.memory_pause = true;
                res.finish = job ? "paused" : "memory_low";
                if (!job) {
                    err = mem_pause_message();
                }
            }
            if (user_abort) {
                res.finish = "paused";
            }
            if (boost) {
                free_context_locked();
                cur_ubatch = cfg.ubatch;
                if (!make_context_locked()) {
                    err = error;
                    return false;
                }
                wake_locked(key);
                trim_working_set();
            }
            return !(mem_abort && !job);
        }
        if (limit < toks.size()) {  // sliced prefill: the rest of the prompt comes with the next call
            th.tokens.assign(toks.begin(), toks.begin() + static_cast<std::ptrdiff_t>(limit));
            llama_batch_free(b);
            llama_sampler_free(smpl);
            th.last_used = ++tick;
            res.finish = "prefill_partial";
            return ok;
        }
        th.tokens = toks;
        llama_token first_token = -1;  // sampled before the context is rebuilt (the new one has no logits yet)
        auto peek = [&]() {
            if (sp.peek && ok) {
                sp.peek(llama_get_logits_ith(ctx, -1), llama_vocab_n_tokens(vocab));
            }
        };
        if (have_logits && ok && common == toks.size()) {  // restored checkpoint: nothing to decode, the next token comes from the saved logits
            const int nv = llama_vocab_n_tokens(vocab);
            if (sp.peek) {
                sp.peek(saved_logits.data(), nv);
            }
            std::vector<llama_token_data> cur(static_cast<std::size_t>(nv));
            for (int t = 0; t < nv; ++t) {
                cur[static_cast<std::size_t>(t)] = llama_token_data{t, saved_logits[static_cast<std::size_t>(t)], 0.0f};
            }
            llama_token_data_array arr = {cur.data(), cur.size(), -1, false};
            llama_sampler_apply(smpl, &arr);
            first_token = arr.data[arr.selected].id;
            llama_sampler_accept(smpl, first_token);
            std::fprintf(stderr, "[resume] %s: checkpoint restored exactly (%zu tokens), no prompt re-read\n", key.substr(0, 24).c_str(), toks.size());
        } else if (boost && ok) {
            peek();
            first_token = llama_sampler_sample(smpl, ctx, -1);
        }
        if (ok && recurrent_model && n_prompt_part == toks.size() && toks.size() >= 512 && !getenv("WS_NO_PROMPT_END")) {  // end-of-prompt checkpoint (see restore_prompt_end)
            save_prompt_end(key, seq, toks);
        }
        if (boost) {  // back to the frugal micro-batch for generation, and give the pages the prefill touched back
            free_context_locked();
            cur_ubatch = cfg.ubatch;
            if (!make_context_locked()) {
                err = error;
                llama_batch_free(b);
                llama_sampler_free(smpl);
                return false;
            }
            wake_locked(key);
            seq = static_cast<llama_seq_id>(threads[key].slot);
            trim_working_set();
        }
        res.prefill_s = now_s() - t0;

        const double t1 = now_s();
        std::string pending, full;
        std::size_t emitted = 0;
        std::size_t hold = 0;
        for (const auto& s : sp.stop) {
            hold = std::max(hold, s.size());
        }
        bool stopped = false;
        auto flush = [&](bool final_flush) {
            std::size_t upto = full.size();
            if (!final_flush && hold > 0) {
                upto = upto > hold ? upto - (hold - 1) : 0;
            }
            if (upto > emitted) {
                const std::string piece = full.substr(emitted, upto - emitted);
                emitted = upto;
                if (!on_text(piece)) {
                    stopped = true;
                }
            }
        };
        res.finish = "length";
        double last_ckpt = now_s();
        auto checkpoint = [&]() {
            if (job->sync) {
                job->sync();
            }
            fs::create_directories(model_dir() / "state");
            const std::string f = state_file(key), tmp = f + ".tmp";
            if (llama_state_seq_save_file(ctx, tmp.c_str(), seq, th.tokens.data(), th.tokens.size()) > 0) {
                save_job_logits(key, th.tokens.size(), llama_get_logits_ith(ctx, -1));
                std::error_code ec;
                fs::rename(tmp, f, ec);  // atomic replace: a crash mid-save leaves the previous checkpoint intact
            }
            if (job->on_checkpoint) {
                job->on_checkpoint(job->prior_text + full);
            }
            last_ckpt = now_s();
        };
        for (int i = 0; ok && i < max_new && !stopped && (job || !stop_request.load()); ++i) {
            if (i == 0 && first_token < 0) {
                peek();
            }
            const llama_token id = i == 0 && first_token >= 0 ? first_token : llama_sampler_sample(smpl, ctx, -1);
            if (llama_vocab_is_eog(vocab, id)) {
                res.finish = "stop";
                break;
            }
            char piece[256];
            const int pn = llama_token_to_piece(vocab, id, piece, sizeof(piece), 0, sp.has_tools());
            if (pn > 0) {
                pending.append(piece, static_cast<std::size_t>(pn));
            }
            const std::size_t ready = utf8_complete_prefix(pending);
            full.append(pending, 0, ready);
            pending.erase(0, ready);
            ++res.completion_tokens;
            bool hit = false;
            for (const auto& s : sp.stop) {
                if (const auto at = full.find(s, emitted > s.size() ? emitted - s.size() : 0); at != std::string::npos) {
                    full.resize(at);
                    hit = true;
                    break;
                }
            }
            if (can_shift && static_cast<int>(th.tokens.size()) + 1 >= cfg.n_ctx) {
                if (n_keep < 0) {
                    n_keep = keep_prefix();
                }
                const int n_left = static_cast<int>(th.tokens.size()) - n_keep;
                const int n_discard = std::max(1, n_left / 2);
                llama_memory_t mem = llama_get_memory(ctx);
                llama_memory_seq_rm(mem, seq, n_keep, n_keep + n_discard);
                llama_memory_seq_add(mem, seq, n_keep + n_discard, -1, -n_discard);
                th.tokens.erase(th.tokens.begin() + n_keep, th.tokens.begin() + n_keep + n_discard);
                ++res.shifts;
            }
            // measurement only (never set in production): WS_GEN_IDS=<file> logs the generated ids; WS_BATCH_TEST=K + WS_BATCH_SCRIPT=<ids file>
            // replays the known greedy continuation K tokens per llama_decode (all "accepted"), to time/measure the verification of a K-token draft
            static const int bt_k = [] { const char* e = std::getenv("WS_BATCH_TEST"); return e ? std::max(1, std::atoi(e)) : 1; }();
            static FILE* gen_ids = [] { const char* p = std::getenv("WS_GEN_IDS"); return p ? std::fopen(p, "ab") : nullptr; }();
            static const std::vector<llama_token> bt_script = [] {
                std::vector<llama_token> v;
                if (const char* p = std::getenv("WS_BATCH_SCRIPT")) {
                    if (FILE* f = std::fopen(p, "rb")) { int t; while (std::fscanf(f, "%d", &t) == 1) v.push_back(t); std::fclose(f); }
                }
                return v;
            }();
            if (gen_ids) { std::fprintf(gen_ids, "%d\n", static_cast<int>(id)); std::fflush(gen_ids); }
            if (bt_k > 1 && static_cast<std::size_t>(i + bt_k) <= bt_script.size() && static_cast<int>(b.n_tokens) >= 0 && i + bt_k <= max_new && b.n_tokens <= 1 && llama_n_batch(ctx) >= static_cast<uint32_t>(bt_k)) {
                // the script holds the continuation starting at the token sampled at i == 0 (script[i] == id)
                for (int j = 0; j < bt_k; ++j) {
                    b.token[j] = bt_script[static_cast<std::size_t>(i + j)];
                    b.pos[j] = static_cast<llama_pos>(th.tokens.size() + static_cast<std::size_t>(j));
                    b.n_seq_id[j] = 1;
                    b.seq_id[j][0] = seq;
                    b.logits[j] = (j == bt_k - 1);
                }
                b.n_tokens = bt_k;
                if (decode_bound(b)) { err = "decode failed"; ok = false; break; }
                for (int j = 0; j < bt_k; ++j) th.tokens.push_back(bt_script[static_cast<std::size_t>(i + j)]);
                res.completion_tokens += bt_k - 1;
                i += bt_k - 1;
                governor_tick();
                continue;
            }
            b.token[0] = id;
            b.pos[0] = static_cast<llama_pos>(th.tokens.size());
            b.n_seq_id[0] = 1;
            b.seq_id[0][0] = seq;
            b.logits[0] = true;
            b.n_tokens = 1;
            if (decode_bound(b)) {
                err = "decode failed";
                ok = false;
                break;
            }
            th.tokens.push_back(id);
            governor_tick();
            if (mem_emergency.load()) {  // "paliers": critical free RAM; no silent shrinking, the work stops with a resume point
                res.memory_pause = true;
                if (job) {
                    if (job->on_token) {
                        job->on_token(id);
                    }
                    checkpoint();
                    res.finish = "paused";
                } else {
                    res.finish = "memory_low";
                    err = mem_pause_message();
                    ok = false;
                }
                break;
            }
            if (job) {
                if (job->on_token) {
                    job->on_token(id);
                }
                if (job->pause && job->pause->load()) {
                    checkpoint();
                    res.finish = "paused";
                    break;
                }
                if (now_s() - last_ckpt >= job->checkpoint_s) {
                    checkpoint();
                }
            }
            if (hit) {
                res.finish = "stop";
                break;
            }
            flush(false);
        }
        if (!job && stop_request.exchange(false)) {
            res.finish = "stopped";
        }
        flush(true);
        res.gen_s = now_s() - t1;
        res.text = full;
        llama_batch_free(b);
        llama_sampler_free(smpl);
        th.last_used = ++tick;
        if (++gens_since_save >= 10) {
            save_sheets();
        }
        if (source.failed) {
            std::fprintf(stderr, "[ws_npc_server] WeightStream fetch failed at least once (fell back to mmap)\n");
            source.failed = false;
        }
        return ok;
    }

    std::string current_profile() const {
        if (!cfg.profile_auto.empty()) {
            return cfg.profile_auto;
        }
        for (const auto& p : kProfiles) {
            if (p.autom || p.hidden) {
                continue;
            }
            if (cfg.ws_ram_mib == p.ram_mib && cfg.cpu_stream == p.cpu && (p.cpu || cfg.ws_ram_mib == 0 || cfg.cache_mib == p.vram_mib)) {
                return p.name;
            }
        }
        return "custom";
    }

    json available_models() const {
        json a = json::array();
        std::error_code ec;
        fs::path dir = cfg.models_dir.empty() ? fs::path(cfg.model).parent_path() : fs::path(cfg.models_dir);
        for (const auto& e : fs::directory_iterator(dir, ec)) {
            if (e.is_regular_file(ec) && e.path().extension() == ".gguf" && shard_number(e.path().filename().string()) == 1) {
                a.push_back({{"path", fs::absolute(e.path()).string()}, {"file", e.path().filename().string()}, {"size_bytes", static_cast<long long>(model_bytes(e.path()))}});
            }
        }
        std::sort(a.begin(), a.end(), [](const json& x, const json& y) { return x["file"].get<std::string>() < y["file"].get<std::string>(); });
        return a;
    }

    // Changes the model and/or the resource profile: the current model is unloaded (threads and expert sheets saved), the new
    // one loaded. A failure puts the previous model back.
    bool switch_locked(const std::string& path, const std::string& profile, std::string& err) {
        const ProfileDef* pd = nullptr;
        for (const auto& p : kProfiles) {
            if (profile == p.name) {
                pd = &p;
            }
        }
        if (!profile.empty() && profile != "custom" && !pd) {
            err = "unknown profile";
            return false;
        }
        if (!path.empty() && !fs::exists(path)) {
            err = "model file not found";
            return false;
        }
        const Config old = cfg;
        suspend_locked();
        if (!path.empty()) {
            cfg.model = fs::absolute(path).string();
        }
        if (pd) {
            apply_profile(cfg, *pd);
        }
        threads.clear();
        owner.clear();
        precache_info.clear();
        error.clear();
        read_index();
        if (!ensure_running_locked()) {
            err = error;
            cfg = old;
            threads.clear();
            read_index();
            ensure_running_locked();
            return false;
        }
        std::ofstream(fs::path(cfg.data_dir) / "launcher.json", std::ios::binary | std::ios::trunc)
            << json{{"model", cfg.model}, {"profile", current_profile()}}.dump(1);  // the launcher starts from here next time
        return true;
    }

    json status_locked() {
        json j;
        j["state"] = suspended ? "suspended" : "running";
        j["model"] = cfg.model;
        j["model_path"] = cfg.model;
        j["model_file"] = fs::path(cfg.model).filename().string();
        j["profile"] = current_profile();
        j["profiles"] = json::array();
        for (const auto& p : kProfiles) {
            if (p.hidden) {
                continue;
            }
            j["profiles"].push_back({{"name", p.name}, {"label", p.label}});
        }
        j["models"] = available_models();
        j["governor"] = {{"on", cfg.margin_mib > 0 && cfg.ws_ram_mib > 0}, {"margin_mib", cfg.margin_mib}, {"available_mib", static_cast<long long>(gov.avail_mib)},
                         {"cache_mib", static_cast<long long>(source.store.capacity_bytes() / (1024 * 1024))}, {"pause_ms", gov.pause_ms},
                         {"grows", gov.grows}, {"shrinks", gov.shrinks}, {"pauses", gov.pauses},
                         {"gear", cfg.gear}, {"gear_eff", gov.gear_eff}, {"busy", gov.busy}, {"custom", cfg.margin_user_mib > 0}};
        j["paliers"] = paliers_json();
        j["streaming"] = cfg.ws_ram_mib > 0 ? (cfg.cpu_stream ? "cpu" : "gpu-cache") : "off";
        j["resources"] = {{"slots", cfg.slots}, {"n_ctx", cfg.n_ctx}, {"cache_mib", cfg.cache_mib}, {"ws_ram_mib", cfg.ws_ram_mib}, {"mem_margin_mib", cfg.margin_mib}, {"gear", cfg.gear}, {"kv_type_k", cfg.kv_type_k}, {"kv_type_v", cfg.kv_type_v}, {"ubatch", cfg.ubatch}, {"prefill_ubatch", cfg.prefill_ubatch}, {"fast_prefills", boosts}};
        json th = json::array();
        for (const auto& [k, t] : threads) {
            th.push_back({{"key", k}, {"state", t.slot >= 0 ? "awake" : (t.has_state ? "asleep" : "empty")}, {"slot", t.slot}, {"tokens", t.tokens.size()}});
        }
        j["threads"] = th;
        j["typing"] = {{"on", typing_warm}, {"idle_s", typing_idle_s}, {"boosted", ty_boosted.load()}, {"boost_mib", ty_added >> 20}, {"signals", ty_signals.load()},
                       {"bursts", ty_bursts.load()}, {"prefilled_tokens", ty_prefilled.load()}};
        {
            std::lock_guard<std::mutex> l(sheets_mx);
            j["experts_tracked"] = {{"enabled", sheets_ok}, {"observations", sheets_ok ? sheets.grand_total() : 0ull}, {"preheat", preheat}};
            j["live_priority"] = {{"on", preheat}, {"steps", live_passes}, {"repins", live_repins}, {"hot_experts", live_pinned.size()}};
        }
        if (cfg.ws_ram_mib > 0 && !suspended) {
            const auto st = source.store.stats();
            j["expert_cache"] = {{"requests", st.requests}, {"ram_hits", st.ram_hits}, {"disk_reads", st.disk_reads}, {"disk_mib", st.disk_bytes / 1048576.0},
                                 {"capacity_mib", source.store.capacity_bytes() / 1048576}, {"max_mib", source.store.max_capacity_bytes() / 1048576}};
        }
#ifdef _WIN32
        PROCESS_MEMORY_COUNTERS_EX m{};
        GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&m), sizeof(m));
        j["process"] = {{"working_set_mib", m.WorkingSetSize / 1048576}, {"private_mib", m.PrivateUsage / 1048576}};
#endif
        for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
            ggml_backend_dev_t d = ggml_backend_dev_get(i);
            if (ggml_backend_dev_type(d) == GGML_BACKEND_DEVICE_TYPE_GPU) {
                size_t fr = 0, tot = 0;
                ggml_backend_dev_memory(d, &fr, &tot);
                j["gpu"] = {{"name", ggml_backend_dev_name(d)}, {"free_mib", fr / 1048576}, {"total_mib", tot / 1048576}};
                break;
            }
        }
        return j;
    }

    llama_model* model = nullptr;
    llama_context* ctx = nullptr;
    const llama_vocab* vocab = nullptr;
    common_chat_templates_ptr tmpls;
    std::string bos_text;
    ExpertSource source;
    std::map<std::string, Thread> threads;
    std::vector<std::string> owner;
    std::uint64_t tick = 0;

    static std::string to_hex(std::size_t v) {
        char b[32];
        std::snprintf(b, sizeof(b), "%016llx", static_cast<unsigned long long>(v));
        return b;
    }
};

void observe_routing(void* user, int32_t il, const int32_t* ids, size_t n_ids) {
    static_cast<Engine*>(user)->record_route(il, ids, n_ids);
}

// ---- character sheets ----
// Resumable background generations. One worker runs them one after the other (the engine serves one request at a time,
// so a running job keeps the service busy: pause it to chat). State lives in <data-dir>/jobs/<id>/ : job.json (request and
// status), tokens.bin (journal of generated tokens), partial.txt / output.txt; the KV checkpoint is the thread "job:<id>".
class Jobs {
public:
    Jobs(Engine& e, const fs::path& dir) : eng(e), root(dir) {
        fs::create_directories(root);
        for (const auto& d : fs::directory_iterator(root)) {
            std::ifstream f(d.path() / "job.json", std::ios::binary);
            json j = json::parse(f, nullptr, false);
            if (j.is_object() && j.contains("id")) {
                if (j.value("status", "") == "running") {
                    j["resumed_after_crash"] = true;
                    // a /v1 request run as a job (origin "v1") has nobody to answer to now: it waits for the same request to be sent again
                    j["status"] = j.value("origin", "") == "v1" ? "interrupted" : "queued";  // otherwise restart from the last checkpoint
                }
                metas[j["id"].get<std::string>()] = j;
            }
        }
        // finished or abandoned /v1 jobs are kept 3 days (a replayed request gets its answer back without the model)
        std::error_code pec;
        for (auto it = metas.begin(); it != metas.end();) {
            const auto mt = fs::last_write_time(root / it->first / "job.json", pec);
            const bool old = !pec && std::chrono::duration_cast<std::chrono::hours>(fs::file_time_type::clock::now() - mt).count() > 72;
            if (old && it->second.value("origin", "") == "v1" && it->second.value("status", "") != "running") {
                fs::remove_all(root / it->first, pec);
                it = metas.erase(it);
            } else {
                ++it;
            }
        }
        for (const auto& [id, j] : metas) {
            if (j.value("status", "") == "queued") {
                queue.push_back(id);
            }
        }
    }

    void start(bool auto_resume) {
        if (!auto_resume) {
            for (const auto& id : queue) {
                metas[id]["status"] = "paused";
                save(id);
            }
            queue.clear();
        }
        worker = std::thread([this] { loop(); });
    }

    void shutdown() {
        {
            std::lock_guard<std::mutex> l(m);
            quit = true;
        }
        pause_flag = true;  // the running job checkpoints and returns; it stays "queued" so the next start resumes it
        {
            std::lock_guard<std::mutex> l(m);
            for (auto& [k, lv] : lives) {
                lv->action = "shutdown";
                lv->pause = true;
            }
        }
        cv.notify_all();
        if (worker.joinable()) {
            worker.join();
        }
    }

    std::string submit(const json& body) {
        std::lock_guard<std::mutex> l(m);
        const std::string id = std::to_string(static_cast<long long>(now_s() * 1000)) + "-" + std::to_string(++counter);
        json j = {{"id", id}, {"name", body.value("name", id)}, {"status", "queued"}, {"created", now_s()}, {"request", body}, {"n_generated", 0}};
        metas[id] = j;
        fs::create_directories(root / id);
        save(id);
        queue.push_back(id);
        cv.notify_all();
        return id;
    }

    // "pause", "resume" or "cancel"; returns false for an unknown job or a nonsensical transition
    bool act(const std::string& id, const std::string& what, std::string& err) {
        std::unique_lock<std::mutex> l(m);
        auto it = metas.find(id);
        if (it == metas.end()) {
            err = "unknown job";
            return false;
        }
        json& j = it->second;
        const std::string st = j.value("status", "");
        if (const auto lv = lives.find(id); lv != lives.end()) {  // a /v1 request is attached: the engine answers through it
            Live& L = *lv->second;
            if (what == "pause") {
                if (st == "running") {
                    L.action = "paused";
                    L.pause = true;
                }
            } else if (what == "resume") {
                if (st == "paused") {
                    L.action.clear();
                    L.go = true;
                    cv.notify_all();
                } else if (st == "running" && L.action == "paused") {  // pause not taken yet: just withdrawn
                    L.action.clear();
                    L.pause = false;
                } else {
                    err = "job is " + st + ", only a paused job can be resumed";
                    return false;
                }
            } else if (what == "cancel") {
                L.action = "cancelled";
                L.pause = true;
                L.go = true;
                cv.notify_all();
            } else {
                err = "unknown action";
                return false;
            }
            return true;
        }
        if (j.value("origin", "") == "v1") {  // no request attached (client gone, engine restarted): only the state can change
            if (what == "resume") {
                err = "no request is attached to this job: send the same /v1 request again (ws_job) to continue it";
                return false;
            }
            if (what == "pause") {
                if (st == "interrupted") {
                    j["status"] = "paused";
                    save(id);
                }
            } else if (what == "cancel") {  // also "forget": the caller got the answer (or gave up), the stored state is removed
                std::error_code rec;
                fs::remove_all(root / id, rec);
                metas.erase(it);
            } else {
                err = "unknown action";
                return false;
            }
            return true;
        }
        if (what == "pause") {
            if (st == "running" && running == id) {
                user_action = "paused";
                pause_flag = true;
            } else if (st == "queued") {
                queue.erase(std::remove(queue.begin(), queue.end(), id), queue.end());
                j["status"] = "paused";
                save(id);
            } else if (st != "paused") {
                err = "job is " + st;
                return false;
            }
        } else if (what == "resume") {
            if (st != "paused") {
                err = "job is " + st + ", only a paused job can be resumed";
                return false;
            }
            j["status"] = "queued";
            queue.push_back(id);
            save(id);
            cv.notify_all();
        } else if (what == "cancel") {
            if (st == "running" && running == id) {
                user_action = "cancelled";
                pause_flag = true;
            } else {
                queue.erase(std::remove(queue.begin(), queue.end(), id), queue.end());
                j["status"] = "cancelled";
                save(id);
                l.unlock();
                std::lock_guard<std::mutex> el(eng.mx);
                eng.drop_thread_locked("job:" + id);
            }
        } else {
            err = "unknown action";
            return false;
        }
        return true;
    }

    // A /v1 chat request run as a resumable job (body field "ws_job": "<id>", chosen by the caller: the same request always has the
    // same id). Every token goes to the journal and the KV is checkpointed every checkpoint_s; POST /api/jobs/<id>/pause stops the
    // generation at the next token (or micro-batch of the prompt) with a checkpoint and the request WAITS, connection kept open
    // (keep-alive pings), until /resume or /cancel. If the client goes away (or the engine dies) the job stays "interrupted":
    // sending the same request again continues from the journal (exact text) and replays what was already produced, or returns the
    // stored answer at once if the job had finished. skip_chars = characters of text the client already received.
    // outcome: "done" | "detached" (client gone / shutdown, state kept) | "cancelled" | "failed" | "busy"
    bool serve_v1(const std::string& id, const std::string& key, const json& messages, const Sampling& sp, double checkpoint_s,
                  const std::function<bool(const std::string&)>& emit, const std::function<bool()>& ping, std::size_t skip_chars,
                  GenResult& out, std::string& err, std::string& outcome) {
        auto live = std::make_shared<Live>();
        std::size_t skip = skip_chars;
        auto send = [&](const std::string& piece) {
            std::string p = piece;
            if (skip > 0) {
                const std::size_t k = std::min(skip, p.size());
                skip -= k;
                p.erase(0, k);
            }
            return p.empty() ? true : emit(p);
        };
        std::string replay;
        bool replay_done = false;
        {
            std::lock_guard<std::mutex> l(m);
            if (lives.count(id)) {
                err = "this job is already attached to a running request";
                outcome = "busy";
                return false;
            }
            auto it = metas.find(id);
            if (it == metas.end()) {
                json j = {{"id", id}, {"name", id}, {"origin", "v1"}, {"status", "running"}, {"created", now_s()}, {"request", {{"origin", "v1"}}}, {"n_generated", 0}};
                metas[id] = j;
                fs::create_directories(root / id);
            } else {
                json& j = it->second;
                const std::string st = j.value("status", "");
                if (st == "done") {
                    std::ifstream t(root / id / "output.txt", std::ios::binary);
                    std::stringstream ss;
                    ss << t.rdbuf();
                    replay = ss.str();
                    replay_done = true;
                    out = GenResult();
                    out.text = replay;
                    out.finish = j.value("finish", std::string("stop"));
                    out.completion_tokens = j.value("n_generated", 0);
                } else {
                    j["status"] = "running";
                    j.erase("pause_reason");
                    j["attached_count"] = j.value("attached_count", 0) + 1;
                    j["resumed_at"] = static_cast<long long>(std::time(nullptr));
                }
            }
            if (!replay_done) {
                lives[id] = live;
                save(id);
            }
        }
        if (replay_done) {
            send(replay);
            outcome = "done";
            return true;
        }
        const fs::path jdir = root / id;
        bool resumed = false;
        for (;;) {
            JobHook hook;
            {
                std::ifstream t(jdir / "tokens.bin", std::ios::binary);
                llama_token v;
                while (t.read(reinterpret_cast<char*>(&v), sizeof(v))) {
                    hook.prior.push_back(v);
                }
            }
            std::FILE* journal = std::fopen((jdir / "tokens.bin").string().c_str(), "ab");
            live->n = static_cast<int>(hook.prior.size());
            hook.pause = &live->pause;
            hook.checkpoint_s = checkpoint_s;
            hook.on_token = [&](llama_token t) {
                if (journal) {
                    std::fwrite(&t, sizeof(t), 1, journal);
                    std::fflush(journal);
                }
                ++live->n;
            };
            hook.sync = [&] {
                if (journal) {
                    std::fflush(journal);
                    _commit(_fileno(journal));
                }
            };
            hook.on_checkpoint = [&](const std::string& text) {
                {
                    std::ofstream o(jdir / "partial.txt", std::ios::binary | std::ios::trunc);
                    o << text;
                }
                std::lock_guard<std::mutex> l(m);
                metas[id]["n_generated"] = live->n.load();
                metas[id]["last_checkpoint"] = static_cast<long long>(std::time(nullptr));
                save(id);
            };
            bool gone = false, prior_sent = resumed;  // resumed on the same connection: the client already has the text produced before the pause
            auto wrapped = [&](const std::string& piece) {
                if (!prior_sent) {
                    prior_sent = true;
                    if (!send(hook.prior_text)) {
                        gone = true;
                        return false;
                    }
                }
                if (!send(piece)) {
                    gone = true;
                    return false;
                }
                return true;
            };
            GenResult r;
            std::string gerr;
            const bool ok = eng.generate(key, messages, sp, wrapped, r, gerr, &hook);
            if (journal) {
                hook.sync();
                std::fclose(journal);
            }
            if (ok && !prior_sent && !gone) {  // no new piece came: what was produced before the pause is still owed to the client
                prior_sent = true;
                if (!send(hook.prior_text)) {
                    gone = true;
                }
            }
            const std::string text = hook.prior_text + r.text;
            std::unique_lock<std::mutex> l(m);
            json& j = metas[id];
            j["n_generated"] = live->n.load();
            j["gen_seconds_this_run"] = r.gen_s;
            if (resumed) {
                j["resume_prefill_s"] = r.prefill_s;  // time to be ready again (0 s when the checkpoint is restored exactly)
            }
            if (r.pal_mib > 0) {
                j["palier_mib"] = static_cast<long long>(r.pal_mib);
            }
            if (!ok) {
                j["status"] = "failed";
                j["error"] = gerr;
                save(id);
                lives.erase(id);
                err = gerr;
                out = r;
                outcome = "failed";
                return false;
            }
            if (live->action == "cancelled") {  // cancelled and the client went away at the same time: forget everything
                lives.erase(id);
                std::error_code rec;
                fs::remove_all(jdir, rec);
                metas.erase(id);
                outcome = "cancelled";
                err = "cancelled";
                return false;
            }
            if (gone || live->action == "shutdown") {
                j["status"] = "interrupted";
                std::ofstream o(jdir / "partial.txt", std::ios::binary | std::ios::trunc);
                o << text;
                save(id);
                lives.erase(id);
                outcome = "detached";
                return true;
            }
            if (r.finish != "paused") {
                j["status"] = "done";
                j["finish"] = r.finish;
                std::ofstream o(jdir / "output.txt", std::ios::binary | std::ios::trunc);
                o << text;
                save(id);
                lives.erase(id);
                out = r;
                out.text = text;
                outcome = "done";
                return true;
            }
            // paused (by the user, by a critical free RAM, or cancelled): a checkpoint was written
            {
                std::ofstream o(jdir / "partial.txt", std::ios::binary | std::ios::trunc);
                o << text;
            }
            if (live->action == "cancelled") {
                j["status"] = "cancelled";
                save(id);
                lives.erase(id);
                outcome = "cancelled";
                err = "cancelled";
                return false;
            }
            j["status"] = "paused";
            j["paused_at"] = static_cast<long long>(std::time(nullptr));
            j["last_checkpoint"] = static_cast<long long>(std::time(nullptr));
            if (r.memory_pause) {
                j["pause_reason"] = "memory_critical";
                j["paused_free_mib"] = static_cast<long long>(eng.pal_crit_seen);
                live->action = "paused";  // waits for an explicit resume
            } else {
                j["pause_reason"] = "user";
            }
            save(id);
            live->go = false;
            for (;;) {
                if (live->action == "cancelled") {
                    metas[id]["status"] = "cancelled";
                    save(id);
                    lives.erase(id);
                    outcome = "cancelled";
                    err = "cancelled";
                    return false;
                }
                if (live->action == "shutdown") {
                    metas[id]["status"] = "interrupted";
                    save(id);
                    lives.erase(id);
                    outcome = "detached";
                    return true;
                }
                if (live->action.empty()) {  // resumed (possibly while the pause was still being taken)
                    break;
                }
                cv.wait_for(l, std::chrono::seconds(1));
                l.unlock();
                const bool alive = ping();
                l.lock();
                if (!alive) {  // the client left while paused: the checkpoint stays, the same request can come back
                    metas[id]["status"] = "paused";
                    save(id);
                    lives.erase(id);
                    outcome = "detached";
                    return true;
                }
            }
            live->pause = false;
            metas[id]["status"] = "running";
            metas[id].erase("pause_reason");
            metas[id]["resumed_at"] = static_cast<long long>(std::time(nullptr));
            save(id);
            resumed = true;
        }
    }

    json list() {
        std::lock_guard<std::mutex> l(m);
        json a = json::array();
        for (const auto& [id, j] : metas) {
            a.push_back(summary(id, j));
        }
        return a;
    }

    bool get(const std::string& id, json& out) {
        std::lock_guard<std::mutex> l(m);
        auto it = metas.find(id);
        if (it == metas.end()) {
            return false;
        }
        out = summary(id, it->second);
        out["request"] = it->second["request"];
        for (const char* f : {"output.txt", "partial.txt"}) {
            std::ifstream t(root / id / f, std::ios::binary);
            if (t) {
                std::stringstream ss;
                ss << t.rdbuf();
                out["text"] = ss.str();
                out["text_is_final"] = std::string(f) == "output.txt";
                break;
            }
        }
        return true;
    }

private:
    Engine& eng;
    fs::path root;
    std::mutex m;
    std::condition_variable cv;
    std::thread worker;
    std::map<std::string, json> metas;
    std::deque<std::string> queue;
    std::string running, user_action;
    struct Live {  // a /v1 request attached to a job: the engine thread of that request waits and obeys through it
        std::atomic<bool> pause{false};
        std::atomic<int> n{0};
        std::string action;  // "" | "paused" | "cancelled" | "shutdown" (guarded by m)
        bool go = false;
    };
    std::map<std::string, std::shared_ptr<Live>> lives;
    std::atomic<bool> pause_flag{false};
    std::atomic<int> live_count{0};
    bool quit = false;
    int counter = 0;

    json summary(const std::string& id, const json& j) {
        json s = j;
        s.erase("request");
        if (running == id) {
            s["n_generated"] = live_count.load();
        }
        if (const auto lv = lives.find(id); lv != lives.end()) {
            s["n_generated"] = lv->second->n.load();
            s["attached"] = true;
            s["pausing"] = lv->second->action == "paused" && j.value("status", "") == "running";
        }
        return s;
    }

    void save(const std::string& id) {  // caller holds m
        const fs::path f = root / id / "job.json", tmp = root / id / "job.json.tmp";
        {
            std::ofstream o(tmp, std::ios::binary | std::ios::trunc);
            o << metas[id].dump(2);
        }
        std::error_code ec;
        fs::rename(tmp, f, ec);
    }

    void loop() {
        for (;;) {
            std::string id;
            {
                std::unique_lock<std::mutex> l(m);
                cv.wait(l, [&] { return quit || !queue.empty(); });
                if (quit) {
                    return;
                }
                id = queue.front();
                queue.pop_front();
                running = id;
                user_action.clear();
                pause_flag = false;
                metas[id]["status"] = "running";
                save(id);
            }
            run(id);
            std::lock_guard<std::mutex> l(m);
            running.clear();
        }
    }

    void run(const std::string& id) {
        json req;
        {
            std::lock_guard<std::mutex> l(m);
            req = metas[id]["request"];
        }
        json messages = req.contains("messages") && req["messages"].is_array() ? req["messages"] : json::array();
        if (messages.empty()) {
            messages.push_back({{"role", "user"}, {"content", req.value("prompt", std::string())}});
        }
        const Sampling sp = parse_sampling(req);
        const fs::path jdir = root / id;

        JobHook hook;
        {  // the journal: every token generated so far, in order
            std::ifstream t(jdir / "tokens.bin", std::ios::binary);
            llama_token v;
            while (t.read(reinterpret_cast<char*>(&v), sizeof(v))) {
                hook.prior.push_back(v);
            }
        }
        std::FILE* journal = std::fopen((jdir / "tokens.bin").string().c_str(), "ab");
        live_count = static_cast<int>(hook.prior.size());
        hook.pause = &pause_flag;
        hook.checkpoint_s = req.value("checkpoint_s", 300.0);
        hook.on_token = [&](llama_token t) {
            if (journal) {
                std::fwrite(&t, sizeof(t), 1, journal);
                std::fflush(journal);
            }
            ++live_count;
        };
        hook.sync = [&] {
            if (journal) {
                std::fflush(journal);
                _commit(_fileno(journal));
            }
        };
        hook.on_checkpoint = [&](const std::string& text) {
            {
                std::ofstream o(jdir / "partial.txt", std::ios::binary | std::ios::trunc);
                o << text;
            }
            std::lock_guard<std::mutex> l(m);
            metas[id]["n_generated"] = live_count.load();
            metas[id]["last_checkpoint"] = now_s();
            save(id);
        };

        GenResult r;
        std::string err;
        const bool ok = eng.generate("job:" + id, messages, sp, [](const std::string&) { return true; }, r, err, &hook);
        if (journal) {
            hook.sync();
            std::fclose(journal);
        }
        const std::string text = hook.prior_text + r.text;

        bool finished = false;
        {
            std::lock_guard<std::mutex> l(m);
            json& j = metas[id];
            j["n_generated"] = live_count.load();
            j["gen_seconds_this_run"] = r.gen_s;
            if (r.pal_mib > 0) {
                j["palier_mib"] = static_cast<long long>(r.pal_mib);
                j["free_mib_at_start"] = static_cast<long long>(r.pal_free_mib);
            }
            if (!ok) {
                j["status"] = "failed";
                j["error"] = err;
            } else if (r.finish == "paused") {
                // "queued" = the service is shutting down; the next start resumes it
                j["status"] = user_action == "cancelled" ? "cancelled" : user_action == "paused" ? "paused" : "queued";
                if (r.memory_pause) {  // "paliers": critical free RAM; waits for a resume (the new request picks a new step)
                    j["status"] = "paused";
                    j["pause_reason"] = "memory_critical";
                    j["paused_free_mib"] = static_cast<long long>(eng.pal_crit_seen);
                }
                std::ofstream o(jdir / "partial.txt", std::ios::binary | std::ios::trunc);
                o << text;
            } else {
                j["status"] = "done";
                j["finish"] = r.finish;
                std::ofstream o(jdir / "output.txt", std::ios::binary | std::ios::trunc);
                o << text;
            }
            finished = j["status"] == "done" || j["status"] == "failed" || j["status"] == "cancelled";
            save(id);
        }
        if (finished) {
            std::lock_guard<std::mutex> el(eng.mx);
            eng.drop_thread_locked("job:" + id);
        }
    }
};

// ---- phases: the two models take turns on the scarce resources ----
//   decide : the decider is about to work   speak : the main model is   image : something that is not an LLM is   flat : back to the profiles
// VRAM (the real bottleneck, 12 GB shared): the sum of the two VRAM expert caches is a pool; the model about to work gets all of it
// but a floor. The caches are fixed when a context is created, so a change rebuilds the contexts (threads sleep on disk and wake
// lazily, ~1-2 s): it is done in the player's reading window, and the next request waits for it if it comes early.
// RAM (optional, --phase-ram-slide, and for "image"): the RAM expert caches slide inside a pool in steps of ~20 % between two decode
// calls, then the engine that got the room preloads its hot experts. With --auto-phase the phases follow the conversation: when a
// request to the decider arrives (and while it runs) the decider is the active one; when the main model is asked or when a decision
// is finished, the main model is; when the main model has answered, the decider is again (the player reads and thinks).
class PhaseMgr {
public:
    // pool_bytes: ceiling of the shared RAM; own_bytes: what the two processes' non-expert weights and buffers take besides the caches
    PhaseMgr(Engine& m, Engine& d, std::size_t pool_bytes, std::size_t own_bytes) : main_(m), dec_(d), pool_(pool_bytes), own_(own_bytes) {
        vbase_[0] = m.cfg.cpu_stream ? 0 : m.cfg.cache_mib;
        vbase_[1] = d.cfg.cpu_stream ? 0 : d.cfg.cache_mib;
        vswap_ = vbase_[0] > 0 && vbase_[1] > 0;
        vpool_ = vbase_[0] + vbase_[1];
        th_ = std::thread([this] { loop(); });
    }
    ~PhaseMgr() {
        {
            std::lock_guard<std::mutex> l(m_);
            quit_ = true;
        }
        cv_.notify_all();
        if (th_.joinable()) {
            th_.join();
        }
    }
    bool auto_phase = false;
    bool ram_slide = false;  // also slide the RAM caches (default: they stay at the sizes of the profiles)
    bool warm_vram_on = true;  // after a bigger VRAM cache, preload it with the model's most used experts

    void request(const std::string& ph) {
        {
            std::lock_guard<std::mutex> l(m_);
            if (ph == phase_ && !dirty_) {
                return;
            }
            phase_ = ph;
            dirty_ = true;
            dirty_flag_ = true;
            ++changes_;
        }
        cv_.notify_all();
    }
    bool wait_settled(int timeout_ms) {
        std::unique_lock<std::mutex> l(m_);
        return cv_.wait_for(l, std::chrono::milliseconds(timeout_ms), [&] { return !dirty_ || quit_; });
    }
    json status() {
        std::lock_guard<std::mutex> l(m_);
        return {{"phase", phase_}, {"settled", !dirty_}, {"changes", changes_}, {"auto", auto_phase}, {"ram_slide", ram_slide},
                {"vram_swap", vswap_}, {"vram_pool_mib", vpool_}, {"vram_main_mib", main_.cfg.cache_mib}, {"vram_decider_mib", dec_.cfg.cache_mib},
                {"swaps", swaps_.load()}, {"last_swap_s", last_swap_s_.load()},
                {"pool_mib", pool_eff_.load() >> 20}, {"main_cap_mib", cap_main_.load() >> 20}, {"decider_cap_mib", cap_dec_.load() >> 20}};
    }

    // called by the generating thread between two decode calls: moves the RAM slide on without waiting for the background thread
    void poll() {
        if (!ram_slide || !dirty_flag_.load() || now_s() - last_step_.load() < 0.1) {
            return;
        }
        std::unique_lock<std::mutex> sl(step_mx_, std::try_to_lock);
        if (!sl.owns_lock()) {
            return;
        }
        run_step(false);
    }

private:
    static constexpr std::size_t kMiB = 1048576;
    static constexpr std::size_t kVFloor = 600;  // MiB of VRAM expert cache the model in retreat keeps
    Engine &main_, &dec_;
    std::size_t pool_;
    std::mutex m_;
    std::condition_variable cv_;
    std::string phase_ = "none";
    bool dirty_ = false, quit_ = false;
    std::uint64_t changes_ = 0;
    std::atomic<std::size_t> cap_main_{0}, cap_dec_{0}, pool_eff_{0};
    std::atomic<bool> dirty_flag_{false};
    std::atomic<double> last_step_{0.0};
    std::atomic<std::uint64_t> swaps_{0};
    std::atomic<double> last_swap_s_{0.0};
    std::size_t own_;
    std::size_t vbase_[2] = {0, 0}, vpool_ = 0;
    bool vswap_ = false;
    std::mutex step_mx_;
    std::thread th_;

    void loop() {
        std::unique_lock<std::mutex> l(m_);
        while (!quit_) {
            cv_.wait(l, [&] { return quit_ || dirty_; });
            if (quit_) {
                return;
            }
            const std::string ph = phase_;
            l.unlock();
            bool settled;
            {
                std::lock_guard<std::mutex> sl(step_mx_);
                settled = run_step(true);
            }
            l.lock();
            if (!settled) {
                cv_.wait_for(l, std::chrono::milliseconds(120), [&] { return quit_ || phase_ != ph; });
            }
        }
    }

    // one step toward the current phase; true when it is reached
    bool run_step(bool allow_vram) {
        last_step_ = now_s();
        std::string ph;
        {
            std::lock_guard<std::mutex> l(m_);
            ph = phase_;
        }
        const bool ram_on = ram_slide || ph == "image" || ph == "flat";
        bool settled = true;
        if (ram_on) {
            settled = step(ph);
        } else {
            main_.phase_cap = dec_.phase_cap = 0;
        }
        if (settled && allow_vram && vswap_) {
            settled = vram_step(ph);
        }
        if (settled) {
            if (ram_on && ram_slide) {
                warm(ph);
            }
            std::lock_guard<std::mutex> l(m_);
            if (ph == phase_) {
                dirty_ = false;
                dirty_flag_ = false;
                cv_.notify_all();
            }
        }
        return settled;
    }

    void vram_targets(const std::string& ph, std::size_t t[2]) const {
        const std::size_t fl = std::min<std::size_t>(kVFloor, std::min(vbase_[0], vbase_[1]));
        if (ph == "decide") {
            t[0] = fl;
            t[1] = vpool_ - fl;
        } else if (ph == "image") {
            t[0] = t[1] = fl;
        } else {  // speak, flat, none: the sizes of the profiles
            t[0] = vbase_[0];
            t[1] = vbase_[1];
        }
    }

    // rebuilds the contexts whose VRAM cache changes: the one that shrinks first, so the sum never exceeds the pool
    bool vram_step(const std::string& ph) {
        std::size_t t[2];
        vram_targets(ph, t);
        Engine* e[2] = {&main_, &dec_};
        for (int pass = 0; pass < 2; ++pass) {
            for (int i = 0; i < 2; ++i) {
                const std::size_t cur = e[i]->cfg.cache_mib;
                if (!((pass == 0 && cur > t[i]) || (pass == 1 && cur < t[i]))) {
                    continue;
                }
                const double t0 = now_s();
                std::string err;
                bool ok;
                std::size_t warmed = 0;
                double t_swap = 0.0;
                {
                    std::lock_guard<std::mutex> l(e[i]->mx);  // waits for a running generation to end
                    ok = e[i]->set_vram_cache_locked(t[i], err);
                    t_swap = now_s() - t0;
                    if (ok && t[i] > cur && warm_vram_on) {
                        warmed = e[i]->warm_vram();  // the new cache is empty: fill it with the experts this model uses most
                    }
                }
                last_swap_s_ = now_s() - t0;
                ++swaps_;
                if (!ok) {
                    std::fprintf(stderr, "[phase] VRAM cache %zu -> %zu MiB failed: %s\n", cur, t[i], err.c_str());
                } else {
                    std::fprintf(stderr, "[phase] %s: VRAM cache %zu -> %zu MiB in %.1f s, %zu experts preloaded in %.1f s\n", ph.c_str(), cur, t[i], t_swap,
                                 warmed, now_s() - t0 - t_swap);
                }
            }
        }
        return true;
    }

    void warm(const std::string& ph) {
        std::lock_guard<std::recursive_mutex> dl(g_decode_mx);
        Engine& e = ph == "decide" ? dec_ : main_;
        if ((ph == "decide" || ph == "speak") && !e.suspended && e.model) {
            e.warm();
        }
    }

    // one RAM step toward the targets of phase `ph`; true when they are reached (or cannot be, the pool being the limit)
    bool step(const std::string& ph) {
        std::lock_guard<std::recursive_mutex> dl(g_decode_mx);
        Engine* e[2] = {&main_, &dec_};
        std::size_t cur[2] = {0, 0}, tgt[2] = {0, 0}, flo[2] = {0, 0}, mx[2] = {0, 0};
        bool live[2];
        for (int i = 0; i < 2; ++i) {
            live[i] = !e[i]->suspended && e[i]->model != nullptr;
            if (!live[i]) {
                e[i]->phase_cap = 0;
                continue;
            }
            auto& st = e[i]->source.store;
            cur[i] = st.capacity_bytes();
            mx[i] = st.max_capacity_bytes();
            flo[i] = std::min(mx[i], std::max(st.min_capacity_bytes(), std::min<std::size_t>(e[i]->cfg.ws_ram_mib, 2000) * kMiB));
        }
        // the pool is what the machine can really give the caches: what is available now, plus what our caches already hold (their pages
        // count in our working set, beyond the non-expert weights and buffers), minus the margin the governor keeps for the other
        // programs. Never above the configured ceiling, never below the two floors. It follows the other programs: when they grow, it shrinks.
        const double margin_mib = main_.cfg.margin_mib > 0 ? static_cast<double>(main_.cfg.margin_mib) : hard_floor_mib(total_mib_now()) * 3.0;
        const double held_mib = std::max(0.0, our_ws_mib() - static_cast<double>(own_ / kMiB));
        const double room_mib = available_mib() + held_mib - margin_mib;
        const std::size_t pool = std::min(pool_, std::max(flo[0] + flo[1], static_cast<std::size_t>(std::max(0.0, room_mib)) * kMiB));
        pool_eff_ = pool;
        const int act = ph == "speak" ? 0 : ph == "decide" ? 1 : -1;  // who gets the room
        for (int i = 0; i < 2; ++i) {
            if (!live[i]) {
                continue;
            }
            if (ph == "flat") {
                tgt[i] = i == 1 ? std::min(mx[i], std::max(flo[i], static_cast<std::size_t>(e[i]->cfg.ws_ram_mib) * kMiB)) : cur[i];
            } else if (act == i) {
                const std::size_t others = live[1 - i] ? flo[1 - i] : 0;
                tgt[i] = std::min(mx[i], pool > others ? pool - others : flo[i]);
            } else {
                tgt[i] = flo[i];
            }
            e[i]->phase_cap = ph == "flat" ? 0 : tgt[i];
        }
        bool settled = true;
        for (int i = 0; i < 2; ++i) {  // shrink first
            if (live[i] && cur[i] > tgt[i]) {
                const std::size_t next = std::max(tgt[i], cur[i] - std::max<std::size_t>(512 * kMiB, cur[i] / 5));
                if (e[i]->store_resize(next)) {
                    cur[i] = next;
                }
                settled = settled && cur[i] <= tgt[i];
            }
        }
        for (int i = 0; i < 2; ++i) {  // then grow, inside the pool and while the system has room
            if (!live[i] || cur[i] + 64 * kMiB >= tgt[i]) {  // within a few slots of the target counts as reached
                continue;
            }
            const std::size_t other = live[1 - i] ? e[1 - i]->source.store.capacity_bytes() : 0;
            const std::size_t room = ph == "flat" ? mx[i] : (pool > other ? pool - other : 0);
            const std::size_t next = std::min({tgt[i], room, cur[i] + std::max<std::size_t>(512 * kMiB, cur[i] / 5)});
            if (next <= cur[i] + 32 * kMiB) {
                settled = settled && room <= cur[i] + 32 * kMiB && other <= flo[1 - i] + 32 * kMiB;  // pool-limited, nothing left to shrink
                continue;
            }
            if (available_mib() < hard_floor_mib(total_mib_now()) + 256) {
                settled = false;  // the system is short of memory (the governor's hard floor): wait
                continue;
            }
            if (e[i]->store_resize(next)) {
                cur[i] = next;
            }
            settled = settled && cur[i] >= tgt[i];
        }
        for (int i = 0; i < 2; ++i) {
            (i == 0 ? cap_main_ : cap_dec_).store(live[i] ? e[i]->source.store.capacity_bytes() : 0);
        }
        return settled;
    }
};

struct Character {
    std::string name, system, notes;
    json history = json::array();  // [{role, content}], the whole conversation
    std::string summary;           // rolling summary of history[0, summary_upto): what has left the context window
    int summary_upto = 0;
};

class Cast {
public:
    explicit Cast(fs::path dir) : dir_(std::move(dir)) {
        fs::create_directories(dir_);
        for (const auto& e : fs::directory_iterator(dir_)) {
            if (e.path().extension() == ".json") {
                std::ifstream in(e.path());
                json j = json::parse(in, nullptr, false);
                if (j.is_object() && j.contains("name")) {
                    Character c;
                    c.name = j["name"].get<std::string>();
                    c.system = j.value("system", std::string());
                    c.notes = j.value("notes", std::string());
                    c.history = j.value("history", json::array());
                    c.summary = j.value("summary", std::string());
                    c.summary_upto = j.value("summary_upto", 0);
                    chars_[c.name] = c;
                }
            }
        }
    }
    std::mutex mx;
    std::map<std::string, Character> chars_;
    void save(const Character& c) {
        json j = {{"name", c.name}, {"system", c.system}, {"notes", c.notes}, {"history", c.history}, {"summary", c.summary}, {"summary_upto", c.summary_upto}};
        std::ofstream(file(c.name)) << j.dump(1);
    }
    void remove(const std::string& name) {
        std::error_code ec;
        fs::remove(file(name), ec);
        chars_.erase(name);
    }

private:
    fs::path dir_;
    fs::path file(const std::string& name) const {
        std::string s;
        for (const char c : name) {
            s += (std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_') ? c : '_';
        }
        return dir_ / (s + "-" + Engine::to_hex(std::hash<std::string>{}(name)).substr(0, 8) + ".json");
    }
};

// Folds the oldest exchanges of a character into its rolling summary, in the background, once the conversation approaches the
// size of the context window. The summary is written by the loaded model itself, shown (and editable) in the UI, and sent to the
// model as part of the character's system prompt; the full history is always kept.
class Summarizer {
public:
    Summarizer(Engine& e, Cast& c) : eng(e), cast(c) { worker = std::thread([this] { loop(); }); }
    ~Summarizer() { shutdown(); }

    void shutdown() {
        {
            std::lock_guard<std::mutex> l(m);
            quit = true;
        }
        quit_a = true;  // a summary in progress is dropped at the next slice
        cv.notify_all();
        if (worker.joinable()) {
            worker.join();
        }
    }

    void request(const std::string& name, bool force) {
        std::lock_guard<std::mutex> l(m);
        for (auto& q : queue) {
            if (q.first == name) {
                q.second = q.second || force;
                return;
            }
        }
        queue.push_back({name, force});
        cv.notify_all();
    }

    json status() {
        std::lock_guard<std::mutex> l(m);
        return {{"busy", !current.empty()}, {"character", current}, {"queued", queue.size()}, {"last_error", last_error}};
    }

private:
    Engine& eng;
    Cast& cast;
    std::mutex m;
    std::condition_variable cv;
    std::thread worker;
    std::deque<std::pair<std::string, bool>> queue;
    std::string current, last_error;
    bool quit = false;
    std::atomic<bool> quit_a{false};

    static std::size_t est_tokens(const std::string& t) { return t.size() / 3 + 8; }  // conservative for French

    void loop() {
        for (;;) {
            std::pair<std::string, bool> job;
            {
                std::unique_lock<std::mutex> l(m);
                cv.wait(l, [&] { return quit || !queue.empty(); });
                if (quit) {
                    return;
                }
                job = queue.front();
                queue.pop_front();
                current = job.first;
            }
            fold(job.first, job.second);
            std::lock_guard<std::mutex> l(m);
            current.clear();
        }
    }

    void fold(const std::string& name, bool force) {
        Character c;
        {
            std::lock_guard<std::mutex> l(cast.mx);
            const auto it = cast.chars_.find(name);
            if (it == cast.chars_.end()) {
                return;
            }
            c = it->second;
        }
        const std::size_t n_ctx = static_cast<std::size_t>(eng.cfg.n_ctx);
        const json& h = c.history;
        const std::size_t from = std::min<std::size_t>(static_cast<std::size_t>(std::max(0, c.summary_upto)), h.size());
        const std::size_t base = est_tokens(c.system) + est_tokens(c.summary);
        // the most recent messages that fit in ~40% of the context stay verbatim; everything before them gets folded
        const std::size_t keep_budget = force ? 1 : (n_ctx * 4 / 10 > base ? n_ctx * 4 / 10 - base : n_ctx / 5);
        std::size_t cut = h.size(), used = 0;
        while (cut > from) {
            const std::size_t t = est_tokens(h[cut - 1].value("content", std::string()));
            if (used + t > keep_budget) {
                break;
            }
            used += t;
            --cut;
        }
        if (force && h.size() >= from + 3 && cut == h.size()) {
            cut = h.size() - 2;  // a manual summary still leaves the last exchange verbatim
        }
        while (cut < h.size() && h[cut].value("role", std::string()) != "user") {
            ++cut;  // what stays verbatim starts with a user message
        }
        if (cut <= from + 1) {
            return;
        }
        // at most ~45% of the context goes into one summarization prompt
        std::size_t end = from, acc = 0;
        while (end < cut) {
            const std::size_t t = est_tokens(h[end].value("content", std::string()));
            if (end > from + 1 && acc + t > n_ctx * 45 / 100) {
                break;
            }
            acc += t;
            ++end;
        }
        while (end < cut && end > from + 1 && h[end].value("role", std::string()) != "user") {
            --end;
        }
        std::string text;
        for (std::size_t i = from; i < end; ++i) {
            text += (h[i].value("role", std::string()) == "user" ? std::string("Utilisateur") : c.name) + " : " + h[i].value("content", std::string()) + "\n";
        }
        const std::string prompt = "Résumé actuel :\n" + (c.summary.empty() ? std::string("(aucun)") : c.summary) + "\n\nNouveaux échanges à intégrer :\n" + text +
                                   "\nÉcris le résumé mis à jour de toute la conversation, dans la langue de la conversation, en 200 mots maximum : faits importants, "
                                   "noms, lieux, relations, promesses, décisions, état émotionnel des personnages, ce qui reste en suspens. Réponds uniquement par le résumé.";
        json msgs = json::array({{{"role", "system"}, {"content", "Tu résumes des conversations de jeu de rôle pour qu'un personnage garde sa mémoire."}},
                                 {{"role", "user"}, {"content", prompt}}});
        Sampling sp;
        sp.temperature = 0.3f;
        sp.domain = "summary";
        // The summary is produced in small slices (64 prompt tokens, then 8 generated tokens at a time); between two slices a
        // conversation that is waiting for the engine goes first, so a summary never blocks the chat for more than a slice.
        constexpr std::size_t kMaxTokens = 450, kSlice = 8;
        JobHook hook;
        hook.max_prefill = 64;
        hook.checkpoint_s = 1e9;
        std::vector<llama_token> got;
        hook.on_token = [&](llama_token t) { got.push_back(t); };
        GenResult r;
        std::string err, text_out;
        bool ok = true;
        for (;;) {
            while (eng.fg_waiting.load() > 0 && !quit_a.load()) {
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
            }
            if (quit_a.load()) {
                ok = false;
                err = "shutting down";
                break;
            }
            hook.prior = got;
            hook.prior_text.clear();
            sp.max_tokens = static_cast<int>(got.size() + kSlice);
            r = GenResult();
            if (!eng.generate("sum:" + name, msgs, sp, [](const std::string&) { return true; }, r, err, &hook)) {
                ok = false;
                break;
            }
            if (r.finish == "prefill_partial") {
                continue;
            }
            text_out = hook.prior_text + r.text;
            if (r.finish == "stop" || got.size() >= kMaxTokens) {
                break;
            }
        }
        r.text = text_out;
        {
            std::lock_guard<std::mutex> l(eng.mx);
            eng.drop_thread_locked("sum:" + name);
        }
        std::string sm = text_out;
        while (!sm.empty() && std::isspace(static_cast<unsigned char>(sm.back()))) {
            sm.pop_back();
        }
        std::lock_guard<std::mutex> l(m);
        if (!ok || quit || sm.empty()) {
            last_error = ok ? "summary discarded" : err;
            return;
        }
        std::lock_guard<std::mutex> cl(cast.mx);
        const auto it = cast.chars_.find(name);
        if (it == cast.chars_.end() || it->second.summary_upto != c.summary_upto || it->second.history.size() < end) {
            last_error = "conversation changed while summarizing";
            return;
        }
        it->second.summary = sm;
        it->second.summary_upto = static_cast<int>(end);
        cast.save(it->second);
        last_error.clear();
    }
};

const char* kUiPage = R"HTML(<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>WeightStream - personnages</title>
<style>
:root{--bg:#14161a;--fg:#e6e6e6;--mut:#8a8f98;--card:#1d2026;--acc:#6aa6ff;--line:#2a2e36}
@media(prefers-color-scheme:light){:root{--bg:#f6f7f9;--fg:#1b1d21;--mut:#666;--card:#fff;--acc:#1a5fd0;--line:#dde0e5}}
*{box-sizing:border-box}body{margin:0;font:15px system-ui,sans-serif;background:var(--bg);color:var(--fg);display:grid;grid-template-columns:260px 1fr;height:100vh}
aside{border-right:1px solid var(--line);padding:12px;overflow:auto}main{display:flex;flex-direction:column;min-width:0}
h3{margin:.2em 0 .5em;font-size:13px;text-transform:uppercase;color:var(--mut)}
button,input,textarea,select{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 8px}
button{cursor:pointer}button:hover{border-color:var(--acc)}
.ch{padding:6px 8px;border-radius:6px;cursor:pointer;display:flex;justify-content:space-between}.ch.sel{background:var(--card);outline:1px solid var(--acc)}
.ch small{color:var(--mut)}
#tabs{padding:8px 10px;border-bottom:1px solid var(--line)}
#chatv{flex:1;display:flex;flex-direction:column;min-height:0}
#expv{display:none;flex:1;overflow:auto;padding:14px}#esum,.hint{color:var(--mut);font-size:13px}
#hm{max-width:100%;border:1px solid var(--line);cursor:crosshair}#card{margin:10px 0;font-size:14px}
#mt,#pt{border-collapse:collapse;font-size:13px;margin:8px 0}#mt td,#mt th,#pt td,#pt th{padding:4px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.warn{color:#e0a030;margin:4px 0}.pth{color:var(--mut);font-size:12px;word-break:break-all}
#etop{border-collapse:collapse;font-size:13px;margin-top:10px}#etop td,#etop th{padding:3px 10px;border-bottom:1px solid var(--line);text-align:right}
#etop tr.r{cursor:pointer}#etop tr.r:hover{background:var(--card)}.bar{display:inline-block;height:8px;background:var(--acc);border-radius:3px;vertical-align:middle}
#log{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--mut);border-top-color:var(--acc);border-radius:50%;animation:sp .9s linear infinite;vertical-align:-2px;margin-left:6px}@keyframes sp{to{transform:rotate(360deg)}}
.note{color:var(--mut);font-size:12px;font-style:italic;align-self:flex-start;margin:-4px 0 0 4px}
.m{max-width:75%;padding:8px 12px;border-radius:10px;background:var(--card);white-space:pre-wrap}.m.u{align-self:flex-end;background:var(--acc);color:#fff}
#bar{display:flex;gap:6px;padding:10px;border-top:1px solid var(--line)}#bar input{flex:1}
#res{border-top:1px solid var(--line);padding:10px;font-size:13px;color:var(--mut)}
#res label{margin-right:10px;white-space:nowrap}#res input{width:80px}
@media(max-width:700px){body{grid-template-columns:1fr;grid-template-rows:auto 1fr}aside{border-right:0;border-bottom:1px solid var(--line);max-height:34vh}}
</style>
)HTML" R"HTML(<aside>
<h3>Personnages</h3><div id=list></div>
<h3 style="margin-top:14px">Nouvelle fiche</h3>
<input id=nn placeholder="Nom" style="width:100%;margin-bottom:6px">
<textarea id=ns placeholder="Fiche (prompt système) : qui il est, comment il parle, ce qu'il sait" rows=6 style="width:100%"></textarea>
<button onclick=create() style="margin-top:6px">Créer / mettre à jour</button>
</aside>
<main>
<div id=tabs><button onclick="setTab('chat')">Discussion</button> <button onclick="setTab('exp')">Experts du modèle</button> <button onclick="setTab('mod')">Modèles et pré-caches</button></div>
<div id=chatv>
<details id=memv style="padding:6px 14px;border-bottom:1px solid var(--line)"><summary id=mems>Mémoire (résumé)</summary>
<textarea id=memt rows=5 style="width:100%;margin-top:6px" placeholder="Pas encore de résumé : il se crée tout seul quand la conversation approche de la limite du contexte (les anciens échanges y sont résumés, l'historique complet reste conservé). Vous pouvez le corriger."></textarea>
<button onclick=saveMem()>Enregistrer le résumé</button> <button onclick=sumNow()>Résumer maintenant</button> <small id=memst></small></details>
<div id=log></div>
<div id=bar><input id=msg placeholder="Votre message" oninput=typed() onkeydown="if(event.key=='Enter'&&!gen)send()"><button id=sendb onclick=send()>Envoyer</button>
<button onclick=reset() title="Efface l'historique de ce personnage">Réinitialiser</button><button onclick=del()>Supprimer</button></div></div>
<div id=expv>
<div>Domaine suivi : <select id=ed onchange=loadExp()></select>
<label><input type=checkbox id=eph onchange="post('/api/resources',{preheat:$('eph').checked})"> préchauffer les experts du domaine et prioriser ceux que la conversation utilise</label>
<button onclick="post('/api/experts/save')">Enregistrer les fiches</button></div>
<p id=esum></p>
<p class=hint>Carte de chaleur : une ligne par couche, une colonne par expert, plus clair = plus sollicité (cliquer sur une case ouvre la fiche de l'expert).</p>
<canvas id=hm></canvas><div id=card></div>
<table id=etop></table>
</div>
<div id=modv style="display:none;flex:1;overflow:auto;padding:14px">
<div id=msum></div>
<p>Plafond des pré-caches <input id=s_cap type=number min=0 step=128 style="width:90px"> Mo (0 = sans limite)
 · inactivité <input id=s_ttl type=number min=0 style="width:60px"> jours (0 = jamais)
 <label><input type=checkbox id=s_auto> vider automatiquement au lancement (le dernier modèle utilisé, les modèles épinglés et le modèle courant sont épargnés)</label>
 <button onclick=saveSettings()>Enregistrer</button> <button onclick=housekeeping()>Nettoyage proposé…</button></p>
<table id=mt></table>
<h3 style="margin-top:14px">Recettes de pré-caches (indépendantes du modèle)</h3>
<table id=pt></table>
<p class=hint>Un pré-cache est un prompt système déjà préempli, gardé sur disque pour un modèle précis. Il peut toujours être régénéré à la prochaine utilisation du modèle.
Supprimer le dossier d'un modèle ici retire seulement les données de WeightStream (fiches d'experts, états, pré-caches), jamais le fichier du modèle.</p>
</div>
<div id=res><span id=st></span><br>
<div id=swrow style="margin:6px 0"><label>Modèle <select id=sw_model onchange=swChanged()></select></label>
<label>Mode <select id=sw_prof onchange=swChanged()></select></label>
<button id=sw_btn onclick=switchModel()>Changer</button> <small id=sw_hint>(recharge le modèle, ~10 s)</small></div>
<div id=gearbox style="margin:8px 0;padding:8px 12px;border-radius:14px;border:2px solid var(--line)">
<div style="display:flex;align-items:center;gap:12px"><span id=g_face style="font-size:40px;line-height:1;transition:transform .25s">&#128578;</span>
<div style="flex:1;min-width:160px"><div><b id=g_name>Sage</b> <small id=g_desc></small></div>
<input id=g_range type=range min=1 max=6 step=1 value=2 style="width:100%" oninput="gearInput()" onchange="gearSet()">
<div style="display:flex;justify-content:space-between;font-size:11px;opacity:.7"><span>discret</span><span>à fond</span></div></div>
<label title="Auto : WeightStream regarde ce que fait le reste de la machine et s'efface ou prend de la place en conséquence"><input type=checkbox id=g_auto onchange="gearSet()"> Auto</label></div>
<small id=g_info></small></div>
<label>Fils en mémoire <input id=r_slots type=number min=1></label>
<label>Contexte <input id=r_ctx type=number step=512></label>
<label>Cache VRAM Mo <input id=r_cache type=number step=256></label>
<label>Cache RAM Mo <input id=r_ram type=number step=256></label>
<label title="Précision du cache de contexte (KV) : q8_0 = moitié moins de mémoire, q4_0 = un quart (peut dégrader la qualité). Recharge le contexte.">Cache KV <select id=r_kv><option>f16</option><option>q8_0</option><option>q4_0</option></select></label>
<label title="Pendant que tu écris, le modèle se prépare (réveil, experts, début du message déjà lu) avec un petit supplément de RAM rendu à la fin de la réponse ou après un moment sans frappe."><input type=checkbox id=ety onchange="post('/api/resources',{typing_warm:$('ety').checked})"> préchauffer pendant la frappe</label>
<label title="Mémoire que WeightStream laisse disponible aux autres programmes. Le cache RAM s'agrandit au-dessus, se réduit en dessous (à moitié de cette valeur, des pauses s'ajoutent). 0 = pas de régulation.">Marge mémoire (Mo) <input id=r_margin oninput="marginDirty=1" type=number step=500 min=0></label>
<label title="Gros prompts : préremplis avec un gros micro-lot (rapide, beaucoup de RAM un moment) puis retour au mode économe. 0 = désactivé">Préremplissage rapide <input id=r_pf type=number step=128 min=0></label>
<button onclick=applyRes()>Appliquer</button>
<button onclick=post('/api/suspend')>Suspendre (libère VRAM/RAM)</button>
<button onclick=post('/api/resume')>Reprendre</button></div>
</main>
)HTML" R"HTML(<script>
let cur=null;const $=id=>document.getElementById(id);
async function j(u,o){const r=await fetch(u,o);return r.json()}
async function post(u,b){await j(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});refresh()}
async function refresh(){
 let c=await j('/api/characters'),s=await j('/api/status');
 if(!c.characters.length&&!window.seeded){window.seeded=true;await j('/api/characters/Assistant',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({system:'Tu es un assistant serviable et concis. Tu reponds dans la langue de l\'utilisateur.'})});c=await j('/api/characters')}
 if(!cur&&c.characters.length){cur=c.characters[0].name;show()}
 const st={};(s.threads||[]).forEach(t=>st[t.key]=t.state);
 $('list').innerHTML='';c.characters.forEach(x=>{const d=document.createElement('div');d.className='ch'+(x.name==cur?' sel':'');
  const t=st['char:'+x.name];d.innerHTML='<span></span><small>'+(t=='awake'?'● éveillé':t=='asleep'?'zz endormi':'')+'</small>';d.firstChild.textContent=x.name;
  d.onclick=()=>{cur=x.name;show()};$('list').appendChild(d)});
 fillSwitch(s);memStatus(s);gearStatus(s);window.tyOn=!!(s.typing&&s.typing.on);if(document.activeElement.id!='ety')$('ety').checked=window.tyOn;
 const r=s.resources||{};$('st').textContent='État : '+s.state+' · streaming : '+s.streaming+(s.gpu?' · VRAM libre '+s.gpu.free_mib+'/'+s.gpu.total_mib+' Mo':'')+(s.process?' · RAM processus '+s.process.working_set_mib+' Mo':'');
 for(const [k,v] of [['slots','r_slots'],['n_ctx','r_ctx'],['cache_mib','r_cache'],['ws_ram_mib','r_ram'],['prefill_ubatch','r_pf'],['mem_margin_mib','r_margin']])if(document.activeElement.id!=v)$(v).value=r[k];if(document.activeElement.id!='r_kv')$('r_kv').value=r.kv_type_k==r.kv_type_v?r.kv_type_k:'f16'}
async function saveMem(){if(!cur)return;await j('/api/characters/'+encodeURIComponent(cur),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({summary:$('memt').value})});$('memst').textContent='enregistré'}
async function sumNow(){if(!cur)return;await j('/api/characters/'+encodeURIComponent(cur)+'/summarize',{method:'POST'});$('memst').textContent='résumé demandé…'}
let wasBusy=false;
function memStatus(s){const m=s.memory||{};if(m.busy)$('memst').textContent='résumé en cours ('+m.character+')…';else if(wasBusy){$('memst').textContent=m.last_error?('échec : '+m.last_error):'résumé mis à jour';if(cur)show()}wasBusy=!!m.busy}
async function show(){if(!cur)return;const c=await j('/api/characters/'+encodeURIComponent(cur));$('log').innerHTML='';
 $('mems').textContent='Mémoire (résumé) — '+(c.summary_upto||0)+' messages résumés sur '+(c.history||[]).length;if(document.activeElement!==$('memt'))$('memt').value=c.summary||'';
 (c.history||[]).forEach(m=>add(m.role=='user'?'u':'a',m.content));$('log').scrollTop=1e9;refresh()}
function add(k,t){const d=document.createElement('div');d.className='m '+k;d.textContent=t;$('log').appendChild(d);$('log').scrollTop=1e9;return d}
let gen=null;
function stopGen(){if(gen){gen.abort();fetch('/api/stop',{method:'POST'})}}
let tyLast=0,tyTimer=0;
function typed(){if(!cur||!window.tyOn)return;const now=Date.now();clearTimeout(tyTimer);
 const go=()=>{tyLast=Date.now();fetch('/api/typing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({character:cur,draft:$('msg').value})}).catch(()=>{})};
 if(now-tyLast>2000)go();else tyTimer=setTimeout(go,2000-(now-tyLast))}
async function send(){
 if(gen){stopGen();return}
 clearTimeout(tyTimer);
 if(!$('msg').value)return;
 if(!cur){add('a','Sélectionnez ou créez d\'abord un personnage (colonne de gauche).');return}
 const t=$('msg').value;$('msg').value='';add('u',t);
 const w=add('a',''),txt=document.createElement('span'),sp=document.createElement('span');sp.className='spin';w.appendChild(txt);w.appendChild(sp);
 const note=document.createElement('div');note.className='note';$('log').appendChild(note);
 const ctl=new AbortController();gen=ctl;$('sendb').textContent='Arrêter';
 const t0=Date.now(),tick=setInterval(()=>{note.textContent='WeightStream runs heavy models at the cost of reduced speed, please wait. ('+Math.round((Date.now()-t0)/1000)+' s)'},500);
 note.textContent='WeightStream runs heavy models at the cost of reduced speed, please wait.';$('log').scrollTop=1e9;
 try{
  const r=await fetch('/api/characters/'+encodeURIComponent(cur)+'/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:t,stream:true}),signal:ctl.signal});
  const rd=r.body.getReader(),dec=new TextDecoder();let buf='';
  for(;;){const x=await rd.read();if(x.done)break;buf+=dec.decode(x.value,{stream:true});
   let i;while((i=buf.indexOf('\n\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+2);if(line.indexOf('data: ')!=0)continue;const e=JSON.parse(line.slice(6));
    if(e.delta!==undefined){txt.textContent+=e.delta;$('log').scrollTop=1e9}
    else if(e.done){if(e.error)txt.textContent+='Erreur : '+(e.detail||e.error.message);else if(e.finish_reason=='length')txt.textContent+='\n[contexte plein : réponse coupée]'}}}
 }catch(err){if(txt.textContent=='')txt.textContent='(interrompu)'}
 finally{clearInterval(tick);sp.remove();const el=Math.round((Date.now()-t0)/1000);note.textContent='Réponse en '+(el>=60?Math.floor(el/60)+' min '+el%60+' s':el+' s')+(txt.textContent.length?' · '+txt.textContent.length+' caractères':'');gen=null;$('sendb').textContent='Envoyer';refresh()}
}
async function create(){const n=$('nn').value.trim();if(!n)return;await j('/api/characters/'+encodeURIComponent(n),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({system:$('ns').value})});cur=n;show()}
async function reset(){if(cur&&confirm('Effacer la conversation ?')){await post('/api/characters/'+encodeURIComponent(cur)+'/reset');show()}}
async function del(){if(cur&&confirm('Supprimer '+cur+' ?')){await j('/api/characters/'+encodeURIComponent(cur),{method:'DELETE'});cur=null;$('log').innerHTML='';refresh()}}
let marginDirty=0;
function applyRes(){const b={slots:+$('r_slots').value,n_ctx:+$('r_ctx').value,cache_mib:+$('r_cache').value,ws_ram_mib:+$('r_ram').value,prefill_ubatch:+$('r_pf').value,kv_type:$('r_kv').value};
 if(marginDirty){b.mem_margin_mib=+$('r_margin').value;marginDirty=0}post('/api/resources',b)}
const GEARS=[['\u{1F607}','Ange','presque toute la machine reste à toi','#3fb950'],['\u{1F642}','Sage','le modèle se fait discret','#8bc34a'],['\u{1F60E}','Cool','équilibré','#d4c22a'],['\u{1F624}','Motivé','il prend de la place','#f0a030'],['\u{1F621}','Énervé','il pousse fort, le reste ralentit un peu','#ee6a2c'],['\u{1F92C}','Ultra furieux','il écrase tout ce qu\'il peut (jamais jusqu\'à bloquer)','#e5362d']];
function gearShow(g,auto){const x=GEARS[Math.min(5,Math.max(0,Math.round(g)-1))];$('g_face').textContent=x[0];$('g_name').textContent=(auto?'Auto · ':'')+x[1];$('g_desc').textContent=x[2];
 $('g_range').style.accentColor=x[3];$('gearbox').style.borderColor=x[3];$('g_face').style.transform='scale('+(0.85+0.13*g)+') rotate('+((g-3.5)*4)+'deg)'}
function gearInput(){$('g_auto').checked=false;gearShow(+$('g_range').value,false)}
function gearSet(){post('/api/resources',{gear:$('g_auto').checked?0:+$('g_range').value})}
function gearStatus(s){const gv=s.governor||{};if(document.activeElement.id=='g_range')return;
 if(gv.custom||!gv.on){$('g_info').textContent=gv.custom?'Marge fixée à la main (Mo) : choisis une vitesse pour reprendre la main.':'Pas de régulation sur ce mode.';return}
 const auto=gv.gear==0,g=auto?(gv.gear_eff||3):gv.gear;$('g_auto').checked=auto;$('g_range').value=Math.round(g);gearShow(g,auto);
 const lp=s.live_priority;$('g_info').textContent='Marge '+Math.round((gv.margin_mib||0)/1024*10)/10+' Go · disponible '+Math.round((gv.available_mib||0)/1024*10)/10+' Go'+(lp&&lp.on?' · experts prioritaires : '+lp.hot_experts:'')}
let swDirty=false;
function swChanged(){swDirty=true;$('sw_btn').textContent='Appliquer';$('sw_btn').style.borderColor='var(--acc)';$('sw_hint').textContent='choix pas encore appliqué : cliquer sur Appliquer (recharge le modèle, ~10 s)'}
function swClean(){swDirty=false;$('sw_btn').textContent='Changer';$('sw_btn').style.borderColor='';$('sw_hint').textContent='(recharge le modèle, ~10 s)'}
function fillSwitch(s){
 const m=$('sw_model'),p=$('sw_prof');
 if(!swDirty&&document.activeElement!==m)m.innerHTML=(s.models||[]).map(x=>'<option value="'+esc(x.path)+'"'+(x.path==s.model_path?' selected':'')+'>'+esc(x.file)+' ('+(x.size_bytes/1073741824).toFixed(1)+' Go)</option>').join('');
 if(!swDirty&&document.activeElement!==p)p.innerHTML=(s.profiles||[]).map(x=>'<option value="'+x.name+'"'+(x.name==s.profile?' selected':'')+'>'+esc(x.label)+'</option>').join('')+(s.profile=='custom'?'<option value="custom" selected>Personnalisé</option>':'');
}
async function switchModel(){
 const path=$('sw_model').value,profile=$('sw_prof').value;
 if(!confirm('Recharger avec ce modèle et ce mode ? Les conversations en cours sont sauvegardées.'))return;
 $('sw_btn').disabled=true;$('st').textContent='Changement de modèle en cours…';
 try{const r=await j('/api/model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:path,profile:profile})});if(r.error)alert('Échec : '+(r.detail||r.error.message));else swClean()}
 finally{$('sw_btn').disabled=false;refresh()}
}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let tab='chat',hmDim=null;
function setTab(t){tab=t;$('chatv').style.display=t=='chat'?'flex':'none';$('expv').style.display=t=='exp'?'block':'none';$('modv').style.display=t=='mod'?'block':'none';if(t=='exp')loadExp();if(t=='mod')loadModels()}
)HTML" R"HTML(const mb=b=>(b/1048576).toFixed(0)+' Mo';
async function loadModels(){
 const m=await j('/api/models'),p=await j('/api/precaches');
 $('msum').innerHTML='<p><b>Pré-caches : '+mb(m.precache_total_bytes)+' / '+(m.precache_cap_bytes?mb(m.precache_cap_bytes):'sans limite')+'</b></p>'+(m.advice||[]).map(a=>'<p class=warn>⚠ '+esc(a)+'</p>').join('');
 if(document.activeElement.id!='s_cap')$('s_cap').value=m.settings.precache_cap_mib;
 if(document.activeElement.id!='s_ttl')$('s_ttl').value=m.settings.precache_ttl_days;
 $('s_auto').checked=m.settings.auto_clean;
 $('mt').innerHTML='<tr><th>Modèle</th><th>Dernier usage</th><th>Dossier WeightStream</th><th>Pré-caches</th><th></th></tr>'+m.models.map(x=>
  '<tr><td><b>'+esc(x.file||x.id)+'</b>'+(x.current?' <small>(en cours)</small>':'')+(x.model_file_present?'':' <small class=warn>fichier absent</small>')+'<div class=pth>'+esc(x.path||'')+'</div></td>'+
  '<td>'+(x.idle_days<0?'?':x.idle_days<1?"aujourd'hui":Math.floor(x.idle_days)+' j')+'</td>'+
  '<td>'+mb(x.dir_bytes)+'<div class=pth>'+esc(x.dir)+'</div></td>'+
  '<td>'+(x.precaches.length?x.precaches.map(f=>esc(f.name)+' · '+mb(f.bytes)+'<div class=pth>'+esc(f.path)+'</div>').join(''):'<small>aucun</small>')+'</td>'+
  '<td><button data-id="'+esc(x.id)+'" onclick="mAct(this,\'clear\')">Vider les pré-caches</button> <button data-id="'+esc(x.id)+'" data-pin="'+(x.pinned?0:1)+'" onclick="mAct(this,\'pin\')">'+(x.pinned?'Désépingler':'Épingler')+'</button> '+
  (x.current?'':'<button data-id="'+esc(x.id)+'" onclick="mAct(this,\'del\')">Supprimer les données…</button>')+'</td></tr>').join('');
 $('pt').innerHTML='<tr><th>Recette</th><th>Chargement</th><th>Conservé</th><th>État</th><th></th></tr>'+p.map(x=>
  '<tr><td>'+esc(x.name)+'</td><td>'+esc(x.load)+'</td><td>'+(x.keep?'oui':'non')+'</td><td>'+esc(x.state)+(x.kv_bytes?' · '+mb(x.kv_bytes):'')+'</td>'+
  '<td><button data-n="'+esc(x.name)+'" onclick="pAct(this,\'build\')">Construire</button> <button data-n="'+esc(x.name)+'" onclick="pAct(this,\'clear\')">Vider</button></td></tr>').join('');
}
async function mAct(b,what){const id=b.dataset.id,u='/api/models/'+encodeURIComponent(id);
 if(what=='clear'){if(confirm('Vider les pré-caches de ce modèle ? Ils pourront être régénérés à la prochaine utilisation.'))await j(u+'/clear-precaches',{method:'POST'})}
 else if(what=='pin')await j(u,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:b.dataset.pin=='1'})});
 else{const r=await fetch(u,{method:'DELETE'}),d=await r.json();if(r.status==409&&confirm(d.message))await fetch(u+'?confirm=1',{method:'DELETE'});else if(r.status!=409)alert(d.detail||'ok')}
 loadModels()}
async function pAct(b,what){const u='/api/precaches/'+encodeURIComponent(b.dataset.n)+'/'+what;
 let r=await fetch(u,{method:'POST'});
 if(r.status==409){const d=await r.json();const c=(d.candidates||[]).map(x=>x.model+' ('+mb(x.precache_bytes)+')').join(', ');
  if(confirm(d.detail+'\n\nPré-caches remplaçables : '+(c||'aucun')+'\n\nRemplacer ces pré-caches ?'))r=await fetch(u+'?evict=auto',{method:'POST'})}
 else if(!r.ok){alert((await r.json()).detail)}
 loadModels()}
async function saveSettings(){await j('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({precache_cap_mib:+$('s_cap').value,precache_ttl_days:+$('s_ttl').value,auto_clean:$('s_auto').checked})});loadModels()}
async function housekeeping(){const r=await j('/api/housekeeping',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 if(!r.plan.length){alert('Rien à nettoyer : aucun modèle inactif depuis assez longtemps (ou ils sont épinglés).');return}
 if(confirm('Vider les pré-caches de :\n'+r.plan.map(x=>x.model+' (inactif depuis '+Math.floor(x.idle_days)+' j, '+mb(x.precache_bytes)+')').join('\n')+'\n\nIls pourront être régénérés à la prochaine utilisation du modèle.'))await j('/api/housekeeping',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"apply":true}'});
 loadModels()}
async function loadExp(){
 const d=$('ed').value||'';const s=await j('/api/experts?domain='+encodeURIComponent(d));
 if(!s.available){$('esum').textContent='Pas de suivi : '+(s.reason||'');return}
 const sel=$('ed');sel.innerHTML='<option value="">Tous les domaines</option>'+s.domains.map(x=>'<option value="'+esc(x.name)+'">'+esc(x.name)+' ('+x.total+')</option>').join('');sel.value=d;
 $('eph').checked=s.preheat;
 $('esum').textContent=s.model+' · '+s.n_layer+' couches × '+s.n_expert+' experts · '+s.grand_total+' observations · experts déjà sollicités : '+s.experts_used+'/'+s.experts_total+' · part des usages couverte par les plus sollicités : '+s.coverage.map(c=>'top '+c.top_percent+' % → '+Math.round(c.covers*100)+' %').join(', ');
 const rows=s.top.map(e=>'<tr class=r onclick="card('+e.layer+','+e.expert+')"><td>couche '+e.layer+'</td><td>expert '+e.expert+'</td><td>'+e.uses+'</td><td>'+(e.share*100).toFixed(2)+' %</td><td>'+(d?'×'+e.affinity.toFixed(2):'')+'</td></tr>').join('');
 $('etop').innerHTML='<tr><th>Couche</th><th>Expert</th><th>Usages</th><th>Part</th><th>'+(d?'Affinité':'')+'</th></tr>'+rows;
 const h=await j('/api/experts/heatmap?domain='+encodeURIComponent(d));
 const cw=Math.max(1,Math.min(8,Math.floor(900/h.n_expert))),ch=Math.max(4,Math.min(10,Math.floor(360/h.n_layer)));
 const cv=$('hm');cv.width=h.n_expert*cw;cv.height=h.n_layer*ch;hmDim={cw,ch};const g=cv.getContext('2d');
 h.rows.forEach((r,y)=>r.forEach((v,x)=>{const t=h.max?Math.sqrt(v/h.max):0;g.fillStyle='hsl(215,70%,'+(12+t*60)+'%)';g.fillRect(x*cw,y*ch,cw,ch)}));
}
$('hm').onclick=ev=>{const r=$('hm').getBoundingClientRect(),k=$('hm').width/r.width;card(Math.floor((ev.clientY-r.top)*k/hmDim.ch),Math.floor((ev.clientX-r.left)*k/hmDim.cw))};
async function card(l,e){const c=await j('/api/experts/expert?layer='+l+'&expert='+e);if(!c.available)return;
 const mx=Math.max(1e-9,...c.domains.map(x=>x.share));
 $('card').innerHTML='<b>Couche '+c.layer+', expert '+c.expert+'</b> — '+c.uses+' usages<br>'+c.domains.map(x=>esc(x.name)+' : <span class=bar style="width:'+Math.round(x.share/mx*160)+'px"></span> '+(x.share*100).toFixed(2)+' % de ses usages, affinité ×'+x.affinity.toFixed(2)+' ('+x.uses+')').join('<br>')}
refresh();setInterval(refresh,5000);
</script>)HTML";

httplib::Server* g_server = nullptr;

}  // namespace

int main(int argc, char** argv) {
    Config cfg;
    bool no_resume_jobs = false;  // by default, jobs interrupted by a crash or a shutdown restart on their own
    long long opt_cap = -1;       // command-line overrides of the stored settings (-1 = not given)
    int opt_ttl = -1, opt_auto = -1;
    std::string decider_model, decider_profile = "normal";  // second model, loaded next to the main one, answers /v1/decide
    int decider_ctx = 2048;    // per sequence: a decision prompt is a state plus a question
    int decider_ubatch = 512;  // micro-batch of the decider (its questions are prompts, never generation)
    int decider_slots = 6;     // sequences: the shared prefix + up to 5 questions in one pass
    bool phase_ram_slide = false;
    bool no_vram_warm = false;
    bool typing_warm_opt = false;
    bool typing_warm_off = false;
    double typing_idle_opt = 0;
    std::size_t decider_ram_mib = 0;   // override of the decider profile's RAM expert cache (0 = the profile's)
    long long decider_cache_mib = -1;  // override of its VRAM expert cache (-1 = the profile's)
    std::size_t phase_pool_mib = 0;  // 0 = 60 % of the machine's RAM, at most 20 GB
    bool auto_phase = false;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : std::string(); };
        if (a == "-m") {
            cfg.model = next();
        } else if (a == "--port") {
            cfg.port = std::stoi(next());
        } else if (a == "--host") {
            cfg.host = next();
        } else if (a == "--data-dir") {
            cfg.data_dir = next();
        } else if (a == "--swa-full") {
            cfg.swa_full = std::string(next()) != "0";
        } else if (a == "--slots") {
            cfg.slots = std::max(1, std::stoi(next()));
        } else if (a == "-c") {
            cfg.n_ctx = std::max(256, std::stoi(next()));
        } else if (a == "--bulk-prefill") {
            cfg.bulk_prefill = std::string(next()) != "off";
        } else if (a == "--lookahead") {
            // generation: the router of the next layer, applied to this layer's input, predicts N experts to read ahead (0 = off); same text
            {
                const std::string v = next();  // N or N:D (D = layers ahead, default 1)
                const auto colon = v.find(':');
                llama_moe_set_lookahead(std::atoi(v.c_str()), colon == std::string::npos ? 1 : std::atoi(v.c_str() + colon + 1));
            }
        } else if (a == "--prefill-ubatch") {
            cfg.prefill_ubatch = std::max(0, std::stoi(next()));
        } else if (a == "--ubatch") {
            cfg.ubatch = std::stoi(next());
        } else if (a == "--cache-mib") {
            cfg.cache_mib = std::stoull(next());
        } else if (a == "--profile") {
            cfg.profile_req = next();
        } else if (a == "--ws-ram-mib") {
            cfg.ws_ram_mib = std::stoull(next());
        } else if (a == "--mem-margin-mib") {
            cfg.margin_mib = cfg.margin_user_mib = std::stoull(next());
        } else if (a == "--typing-warm") {
            typing_warm_opt = true;
        } else if (a == "--no-typing-warm") {
            typing_warm_off = true;
        } else if (a == "--typing-idle-s") {
            typing_idle_opt = std::stod(next());
        } else if (a == "--gear") {  // auto | 1..6
            const std::string v = next();
            cfg.gear = v == "auto" ? 0 : std::min(6, std::max(0, std::stoi(v)));
            cfg.gear_user = true;
        } else if (a == "--mem-critical-mib") {
            cfg.crit_mib = std::stoull(next());  // "paliers": free RAM under which a running generation pauses
        } else if (a == "--ws-max-mib") {
            cfg.ws_max_mib = cfg.pal_max_user_mib = std::stoull(next());
        } else if (a == "--kv-type" || a == "--kv-type-k" || a == "--kv-type-v") {
            const std::string t = next();
            if (t != "f16" && t != "q8_0" && t != "q4_0") {
                std::cerr << "KV cache type must be f16, q8_0 or q4_0\n";
                return 1;
            }
            if (a != "--kv-type-v") {
                cfg.kv_type_k = t;
            }
            if (a != "--kv-type-k") {
                cfg.kv_type_v = t;
            }
        } else if (a == "--models-dir") {
            cfg.models_dir = next();
        } else if (a == "--precache-cap-mib") {
            opt_cap = std::stoll(next());
        } else if (a == "--precache-ttl-days") {
            opt_ttl = std::stoi(next());
        } else if (a == "--auto-clean") {
            opt_auto = 1;
        } else if (a == "--no-auto-clean") {
            opt_auto = 0;
        } else if (a == "--no-resume-jobs") {
            no_resume_jobs = true;
        } else if (a == "--cpu-stream") {
            cfg.cpu_stream = true;
        } else if (a == "--chat-template-file") {
            cfg.chat_template_file = next();
        } else if (a == "--phase-pool-mib") {
            phase_pool_mib = std::stoull(next());
        } else if (a == "--auto-phase") {
            auto_phase = true;
        } else if (a == "--decider-model") {
            decider_model = next();
        } else if (a == "--decider-profile") {
            decider_profile = next();
        } else if (a == "--decider-ubatch") {
            decider_ubatch = std::max(1, std::stoi(next()));
        } else if (a == "--decider-slots") {
            decider_slots = std::max(2, std::stoi(next()));
        } else if (a == "--no-vram-warm") {
            no_vram_warm = true;
        } else if (a == "--phase-ram-slide") {
            phase_ram_slide = true;
        } else if (a == "--decider-ram-mib") {
            decider_ram_mib = std::stoull(next());
        } else if (a == "--decider-cache-mib") {
            decider_cache_mib = std::stoll(next());
        } else if (a == "--decider-ctx") {
            decider_ctx = std::max(256, std::stoi(next()));
        } else {
            std::cerr << "Usage: ws_npc_server -m model.gguf [--port 8770] [--data-dir dir] [--slots N] [-c N_CTX]\n"
                         "       [--ws-ram-mib N] [--cache-mib N] [--cpu-stream] [--ubatch N] [--prefill-ubatch N] [--bulk-prefill on|off] [--lookahead N] [--chat-template-file f.jinja]\n"
                         "       [--decider-model f.gguf [--decider-profile eco|normal|confort|cpu] [--decider-ctx N]]  second model for /v1/decide\n"
                         "  Without --ws-ram-mib the model runs as plain llama.cpp (any model); with it, MoE experts are streamed.\n";
            return 1;
        }
    }
    if (cfg.model.empty()) {
        std::cerr << "missing -m model.gguf\n";
        return 1;
    }
    if (cfg.ws_ram_mib > 0 && !cfg.cpu_stream && cfg.cache_mib == 0) {
        cfg.cache_mib = 1024;  // the GPU path needs a VRAM expert cache
    }

    llama_log_set(log_quiet, nullptr);
    ggml_backend_load_all();
    // the decider: a second engine with fixed, small caps; what it takes is taken off what the main model's adaptive profile sees as free
    std::unique_ptr<Engine> decider_p;
    if (!decider_model.empty()) {
        Config dc = cfg;
        dc.model = decider_model;
        dc.data_dir = (fs::path(cfg.data_dir) / "decider").string();
        dc.slots = decider_slots;
        dc.n_ctx = std::min(cfg.n_ctx, decider_ctx);
        dc.ubatch = decider_ubatch;  // the decider never generates: its questions go through in big micro-batches (each layer's experts read once)
        dc.prefill_ubatch = 0;
        dc.profile_req = decider_profile;
        dc.gear = 0;
        dc.gear_user = false;
        dc.margin_user_mib = dc.margin_mib = 0;
        dc.ws_ram_mib = dc.cache_mib = 0;
        dc.cpu_stream = false;
        const ProfileDef* df = nullptr;
        for (const auto& pr : kProfiles) {
            if (decider_profile == pr.name && !pr.autom) {
                df = &pr;
            }
        }
        if (!df) {
            std::cerr << "decider profile must be a fixed one (eco, normal, confort, cpu): " << decider_profile << "\n";
            return 1;
        }
        apply_profile(dc, *df);
        if (decider_ram_mib > 0) {
            dc.ws_ram_mib = decider_ram_mib;
        }
        if (decider_cache_mib >= 0 && !dc.cpu_stream) {
            dc.cache_mib = static_cast<std::size_t>(decider_cache_mib);
        }
        // address space for the cache to grow into during the phases (committed only as it grows)
        dc.ws_max_mib = std::max<std::size_t>(dc.ws_ram_mib, static_cast<std::size_t>(model_bytes(decider_model) / 1048576 * 95 / 100));
        const double ne_mib = static_cast<double>(non_expert_bytes(decider_model)) / 1048576.0;
        g_reserved_ram_mib = static_cast<double>(dc.ws_ram_mib) + (ne_mib > 0 ? ne_mib : 1500.0) + 1000.0;
        g_reserved_vram_mib = (dc.cpu_stream ? 0.0 : static_cast<double>(dc.cache_mib)) + (ne_mib > 0 ? ne_mib * 0.8 : 1500.0) + 700.0;
        std::cerr << "[ws_npc_server] decider " << fs::path(decider_model).filename().string() << ": profile " << df->name << ", RAM cache " << dc.ws_ram_mib
                  << " MiB, VRAM cache " << dc.cache_mib << " MiB (reserved " << static_cast<long long>(g_reserved_ram_mib) << " MiB RAM, "
                  << static_cast<long long>(g_reserved_vram_mib) << " MiB VRAM)\n";
        decider_p = std::make_unique<Engine>(dc);
        decider_p->read_index();
    }
    if (!cfg.profile_req.empty()) {
        const ProfileDef* found = nullptr;
        for (const auto& pr : kProfiles) {
            if (cfg.profile_req == pr.name) {
                found = &pr;
            }
        }
        if (!found) {
            std::cerr << "unknown profile: " << cfg.profile_req << "\n";
            return 1;
        }
        apply_profile(cfg, *found);
        std::cerr << "[ws_npc_server] profile " << found->name << ": RAM cache " << cfg.ws_ram_mib << " MiB, VRAM cache " << cfg.cache_mib
                  << " MiB" << (cfg.cpu_stream ? ", experts on CPU" : "") << "\n";
    }
    Engine engine(cfg);
    engine.typing_warm = !typing_warm_off;
    if (typing_idle_opt > 0) {
        engine.typing_idle_s = typing_idle_opt;
    }
    Engine& dec = decider_p ? *decider_p : engine;  // /v1/decide runs here
    std::unique_ptr<PhaseMgr> phases;
    if (decider_p) {
        const double pool_mib = phase_pool_mib ? static_cast<double>(phase_pool_mib) : std::min(20000.0, total_mib_now() * 0.6);
        const double own_mib = (static_cast<double>(non_expert_bytes(cfg.model)) + static_cast<double>(non_expert_bytes(decider_model))) / 1048576.0 + 2000.0;
        phases = std::make_unique<PhaseMgr>(engine, *decider_p, static_cast<std::size_t>(pool_mib) * 1048576, static_cast<std::size_t>(own_mib) * 1048576);
        phases->auto_phase = auto_phase;
        phases->ram_slide = phase_ram_slide;
        phases->warm_vram_on = !no_vram_warm;
        engine.on_tick = [&phases] { phases->poll(); };
        decider_p->on_tick = [&phases] { phases->poll(); };
        if (auto_phase) {
            engine.on_generated = [&phases] { phases->request("decide"); };
        }
    }
    Cast cast(fs::path(cfg.data_dir) / "characters");
    engine.read_index();
    engine.load_recipes();
    engine.load_settings();
    if (opt_cap >= 0) {
        engine.precache_cap_mib = static_cast<std::size_t>(opt_cap);
    }
    if (opt_ttl >= 0) {
        engine.precache_ttl_days = opt_ttl;
    }
    if (opt_auto >= 0) {
        engine.auto_clean = opt_auto == 1;
    }
    if (engine.auto_clean) {  // before anything loads: pre-caches of models idle for too long are cleared at launch
        std::lock_guard<std::mutex> l(engine.mx);
        const json r = engine.housekeeping_locked(true);
        for (const auto& e : r["plan"]) {
            std::fprintf(stderr, "[ws_npc_server] idle model %s: pre-caches cleared (%lld MB), they are re-generated if the model is used again\n",
                         e["model"].get<std::string>().c_str(), e["precache_bytes"].get<long long>() / 1048576);
        }
    }
    std::mutex chat_mx;  // one character chat at a time (history updates)
    Jobs jobs(engine, fs::path(cfg.data_dir) / "jobs");
    Summarizer summarizer(engine, cast);

    httplib::Server svr;
    g_server = &svr;
    std::signal(SIGINT, [](int) {
        if (g_server) {
            g_server->stop();
        }
    });
    svr.set_payload_max_length(256u * 1024u * 1024u);  // big prompts (system prompts, long histories) come as large JSON bodies
    svr.set_read_timeout(600);
    svr.set_write_timeout(600);

    auto reply_json = [](httplib::Response& res, int status, const json& j) { res.status = status; res.set_content(j.dump(), "application/json; charset=utf-8"); };
    auto reply_err = [&](httplib::Response& res, int status, const std::string& msg) {
        reply_json(res, status, {{"error", {{"message", msg}, {"type", status == 400 ? "invalid_request_error" : "server_error"}}}, {"detail", msg}});
    };

    svr.Get("/", [](const httplib::Request&, httplib::Response& res) { res.set_content(kUiPage, "text/html; charset=utf-8"); });
    svr.Get("/health", [&](const httplib::Request&, httplib::Response& res) {
        reply_json(res, 200, {{"status", "ok"}, {"state", engine.suspended ? "suspended" : "running"}});
    });
    svr.Get("/props", [&](const httplib::Request&, httplib::Response& res) {
        reply_json(res, 200, {{"model_path", cfg.model}, {"modalities", {{"vision", false}, {"audio", false}}}, {"total_slots", cfg.slots}});
    });
    svr.Get("/v1/models", [&](const httplib::Request&, httplib::Response& res) {
        reply_json(res, 200, {{"object", "list"}, {"data", json::array({{{"id", "local"}, {"object", "model"}}})}});
    });

    // ---- OpenAI-compatible chat ----
    // ---- decisions: one forward pass, a probability for each option, no text generated ----
    // Body: {state, question, options:[...]} or {state, questions:{name:{type:"choice"|"noul"|"score", instructions, options|criteria|scale}}}
    // optional: system, temperature (calibration, default 1; >1 flattens), abstain_below (answer null under that confidence), key (KV thread).
    // The probabilities are the softmax over the logits of the option letters at the first answer position. Questions about the same state
    // share its prefix, which stays in the KV cache.
    svr.Post("/v1/decide", [&](const httplib::Request& req, httplib::Response& res) {
        json b = json::parse(req.body, nullptr, false);
        if (!b.is_object() || !b.contains("state")) {
            return reply_err(res, 400, "JSON body expected: {state, question, options} or {state, questions:{name:{type, instructions, options}}}");
        }
        struct Q {
            std::string name, type, instr, extra;
            std::vector<std::string> opts, shown;
        };
        if (phases && phases->auto_phase) {
            phases->request("decide");  // normally done already, in the reading window; otherwise the question waits for the swap
            phases->wait_settled(60000);
        }
        std::vector<Q> qs;
        const bool single = !b.contains("questions");
        auto add = [&](const std::string& name, const json& q) {
            Q x;
            x.name = name;
            x.type = q.value("type", "choice");
            x.instr = q.contains("instructions") && q["instructions"].is_string() ? q["instructions"].get<std::string>() : q.value("question", "");
            if (x.type == "noul") {
                x.opts = {"true", "false"};
                x.shown = {"yes", "no"};
            } else if (x.type == "score") {
                const int n = std::min(10, std::max(2, q.value("scale", 5)));
                for (int k = 1; k <= n; ++k) {
                    x.opts.push_back(std::to_string(k));
                    x.shown.push_back(std::to_string(k));
                }
            } else if (q.contains("options") && q["options"].is_array()) {
                for (const auto& o : q["options"]) {
                    x.opts.push_back(o.is_string() ? o.get<std::string>() : o.dump());
                    x.shown.push_back(x.opts.back());
                }
            } else if (q.contains("criteria") && q["criteria"].is_object()) {
                for (const auto& [k, v] : q["criteria"].items()) {
                    x.opts.push_back(k);
                    x.shown.push_back(v.is_string() && !v.get<std::string>().empty() ? k + " (" + v.get<std::string>() + ")" : k);
                }
            }
            if (q.contains("criteria") && q["criteria"].is_string()) {
                x.extra = q["criteria"].get<std::string>();
            }
            qs.push_back(std::move(x));
        };
        if (single) {
            add("answer", b);
        } else if (b["questions"].is_object()) {
            for (const auto& [k, v] : b["questions"].items()) {
                if (v.is_object()) {
                    add(k, v);
                }
            }
        }
        if (qs.empty()) {
            return reply_err(res, 400, "no question");
        }
        for (const auto& q : qs) {
            if (q.opts.size() < 2 || q.opts.size() > 26) {
                return reply_err(res, 400, "question '" + q.name + "': 2 to 26 options are needed");
            }
        }
        const std::string state = b["state"].is_string() ? b["state"].get<std::string>() : b["state"].dump();
        const double temp = std::max(0.05, b.value("temperature", 1.0));
        const double abstain = b.value("abstain_below", 0.0);
        const std::string key = "decide:" + b.value("key", std::string("default"));
        // every question about this state goes through the model in ONE pass (shared prefix once, each question's own tokens in the same
        // micro-batch): the experts of each layer are read once for all of them
        std::vector<json> all_msgs;
        for (const auto& q : qs) {
            std::string prompt = state + "\n\nQuestion: " + q.instr + "\n";
            if (!q.extra.empty()) {
                prompt += q.extra + "\n";
            }
            prompt += "Options:\n";
            for (std::size_t k = 0; k < q.shown.size(); ++k) {
                prompt += std::string(1, static_cast<char>('A' + k)) + ". " + q.shown[k] + "\n";
            }
            prompt += "Answer with the letter of the chosen option only.";
            json msgs = json::array();
            if (b.contains("system") && b["system"].is_string()) {
                msgs.push_back({{"role", "system"}, {"content", b["system"].get<std::string>()}});
            }
            msgs.push_back({{"role", "user"}, {"content", prompt}});
            all_msgs.push_back(std::move(msgs));
        }
        Sampling dsp;
        dsp.temperature = 0.0f;
        dsp.top_k = 1;
        dsp.max_tokens = 1;
        dsp.enable_thinking = false;
        dsp.domain = "decide";
        std::vector<std::vector<float>> logits;
        DecideStats dst;
        std::string derr;
        const double t_start = now_s();
        bool decided;
        {
            DecidePriority prio;
            decided = dec.decide_batch(key, all_msgs, dsp, logits, dst, derr);
        }
        if (decided) {
            dec.warm();  // pins in the RAM cache the experts the decisions use most (the sheets of the "decide" domain): a cache smaller than the model then still hits
        }
        if (!decided) {
            return reply_err(res, 500, derr.empty() ? "no logits (is the model loaded?)" : derr);
        }
        const double ms = (now_s() - t_start) * 1000.0;
        const int prompt_tokens = dst.full_tokens;
        json out = json::object();
        for (std::size_t qi = 0; qi < qs.size(); ++qi) {
            const auto& q = qs[qi];
            const std::vector<float>& lgv = logits[qi];
            const float* lg = lgv.data();
            const int nv = static_cast<int>(lgv.size());
            std::vector<double> z(q.opts.size(), -1e30);
            double mx = -1e30;
            for (int i = 0; i < nv; ++i) {
                mx = std::max(mx, static_cast<double>(lg[i]));
            }
            double all = 0.0;
            for (int i = 0; i < nv; ++i) {
                all += std::exp(static_cast<double>(lg[i]) - mx);
            }
            double letters = 0.0;
            for (std::size_t k = 0; k < z.size(); ++k) {
                double acc = 0.0;
                for (const char* pre : {"", " "}) {
                    const std::string t = std::string(pre) + static_cast<char>('A' + k);
                    llama_token id[4];
                    const int n = llama_tokenize(dec.vocab, t.c_str(), static_cast<int32_t>(t.size()), id, 4, false, false);
                    if (n >= 1 && id[0] >= 0 && id[0] < nv) {
                        acc += std::exp(static_cast<double>(lg[id[0]]) - mx);
                    }
                }
                letters += acc;
                z[k] = acc > 0.0 ? std::log(acc) + mx : -1e30;
            }
            const double mass = all > 0.0 ? letters / all : 0.0;
            double zmax = -1e30;
            for (double v : z) {
                zmax = std::max(zmax, v);
            }
            std::vector<double> p(z.size());
            double sum = 0.0;
            for (std::size_t k = 0; k < z.size(); ++k) {
                p[k] = z[k] < -1e29 ? 0.0 : std::exp((z[k] - zmax) / temp);
                sum += p[k];
            }
            std::size_t best = 0;
            for (std::size_t k = 0; k < p.size(); ++k) {
                p[k] = sum > 0 ? p[k] / sum : 0.0;
                if (p[k] > p[best]) {
                    best = k;
                }
            }
            json r = {{"type", q.type}, {"options", q.opts}, {"probs", p}, {"confidence", p[best]}, {"letter_mass", mass},
                      {"answer", p[best] >= abstain ? json(q.opts[best]) : json(nullptr)}};
            if (q.type == "noul") {
                r["p_true"] = p[0];
            } else if (q.type == "score") {
                double e = 0.0;
                for (std::size_t k = 0; k < p.size(); ++k) {
                    e += p[k] * static_cast<double>(k + 1);
                }
                r["expected"] = e;
            }
            out[q.name] = std::move(r);
        }
        if (phases && phases->auto_phase) {
            phases->request("speak");  // all the questions are answered: the main model is the next to work
        }
        json resp = {{"results", out}, {"prompt_tokens", prompt_tokens}, {"new_tokens", dst.new_tokens}, {"passes", dst.passes}, {"ms", ms}};
        if (single) {
            for (const auto& [k, v] : out["answer"].items()) {
                resp[k] = v;  // flat form for the one-question call
            }
        }
        reply_json(res, 200, resp);
    });
    svr.Post("/v1/chat/completions", [&](const httplib::Request& req, httplib::Response& res) {
        if (phases && phases->auto_phase) {
            phases->request("speak");
            phases->wait_settled(60000);
        }
        json body = json::parse(req.body, nullptr, false);
        if (!body.is_object() || !body.contains("messages") || !body["messages"].is_array() || body["messages"].empty()) {
            return reply_err(res, 400, "messages missing");
        }
        const Sampling sp = parse_sampling(body);
        // conversation identity: explicit "user" / "thread", else the first system message (one persona = one KV cache)
        std::string key = body.value("thread", body.value("user", std::string()));
        if (key.empty()) {
            std::string first_sys;
            for (const auto& m : body["messages"]) {
                if (m.value("role", "") == "system" && m["content"].is_string()) {
                    first_sys = m["content"].get<std::string>();
                    break;
                }
            }
            key = "sys:" + Engine::to_hex(std::hash<std::string>{}(first_sys));
        }
        const bool stream = body.value("stream", false);
        const std::string id = "chatcmpl-ws" + std::to_string(static_cast<long long>(now_s() * 1000));
        const bool tools = sp.has_tools();
        auto usage_of = [](const GenResult& r) {
            return json{{"prompt_tokens", r.prompt_tokens}, {"completion_tokens", r.completion_tokens}, {"total_tokens", r.prompt_tokens + r.completion_tokens}};
        };
        // assistant message of a finished generation; with tools the text is parsed into content / reasoning / tool_calls
        auto build_message = [&engine, tools](const json& messages, const Sampling& s2, const GenResult& r, std::string& finish) {
            json msg = {{"role", "assistant"}, {"content", r.text}};
            finish = r.finish;
            if (tools) {
                try {
                    const common_chat_msg cm = engine.parse_output(messages, s2, r.text);
                    std::string content = cm.content;
                    for (const char* empty_think : {"<think>\n\n</think>\n\n", "<think>\n\n</think>", "<think></think>"}) {  // empty reasoning block of a non-thinking turn
                        const std::size_t at = content.find(empty_think);
                        if (at != std::string::npos) {
                            content.erase(at, std::strlen(empty_think));
                            break;
                        }
                    }
                    msg["content"] = content.empty() && !cm.tool_calls.empty() ? json(nullptr) : json(content);
                    if (!cm.reasoning_content.empty()) {
                        msg["reasoning_content"] = cm.reasoning_content;
                    }
                    if (!cm.tool_calls.empty()) {
                        json calls = json::array();
                        int n = 0;
                        for (const auto& tc : cm.tool_calls) {
                            calls.push_back({{"id", tc.id.empty() ? "call_ws" + std::to_string(static_cast<long long>(now_s() * 1000)) + "_" + std::to_string(n) : tc.id},
                                             {"type", "function"},
                                             {"function", {{"name", tc.name}, {"arguments", tc.arguments}}}});
                            ++n;
                        }
                        msg["tool_calls"] = calls;
                        if (finish == "stop") {
                            finish = "tool_calls";
                        }
                    }
                } catch (const std::exception&) {  // unparsable output: the raw text is returned as content
                }
            }
            return msg;
        };
        if (!stream) {
            GenResult r;
            std::string err;
            // "background": true = work nobody waits for (summaries, notes): it goes in slices that give way to any dialogue
            const bool bg_ok = body.value("prewarm", false) ? engine.prewarm(key, body["messages"], sp, r, err, [&req] { return req.is_connection_closed(); })
                             : body.value("background", false) ? engine.generate_sliced(key, body["messages"], sp, r, err, [&req] { return req.is_connection_closed(); })
                                                               : engine.generate(key, body["messages"], sp, [](const std::string&) { return true; }, r, err);
            if (!bg_ok) {
                return reply_err(res, r.overflow ? 400 : (r.memory_pause ? 503 : 500), err);
            }
            std::string finish;
            const json msg = build_message(body["messages"], sp, r, finish);
            reply_json(res, 200, {{"id", id}, {"object", "chat.completion"}, {"model", "local"},
                                  {"choices", json::array({{{"index", 0}, {"message", msg}, {"finish_reason", finish}}})},
                                  {"usage", usage_of(r)},
                                  {"timings", {{"prompt_ms", r.prefill_s * 1000}, {"predicted_ms", r.gen_s * 1000}, {"cache_n", r.reused_tokens}, {"fast_prefill", r.boosted}}}});
            return;
        }
        // "ws_job": "<id>" = this request is a resumable job (pause / resume / cancel through /api/jobs/<id>/..., survives a crash)
        std::string job_id = body.value("ws_job", std::string());
        if (job_id.size() > 80 || job_id.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") != std::string::npos) {
            job_id.clear();
        }
        const std::size_t skip_chars = static_cast<std::size_t>(std::max(0LL, body.value("ws_skip_chars", 0LL)));
        const double job_ckpt_s = body.value("ws_checkpoint_s", 60.0);
        std::shared_ptr<LiveText> live;
        if (tools && !job_id.empty()) {
            live = std::make_shared<LiveText>();
            std::lock_guard<std::mutex> lg(g_live_mx);
            g_live[job_id] = live;
        }
        res.set_chunked_content_provider("text/event-stream", [&engine, &jobs, body, sp, key, id, tools, build_message, usage_of, job_id, skip_chars, job_ckpt_s, live](size_t, httplib::DataSink& sink) {
            struct LiveGuard {  // the live text disappears with the request
                const std::string& id;
                bool on;
                ~LiveGuard() {
                    if (on) {
                        std::lock_guard<std::mutex> lg(g_live_mx);
                        g_live.erase(id);
                    }
                }
            } live_guard{job_id, live != nullptr};
            auto chunk = [&](const json& delta, const json& finish, const json& usage = nullptr) {
                json c = {{"id", id}, {"object", "chat.completion.chunk"}, {"model", "local"},
                          {"choices", json::array({{{"index", 0}, {"delta", delta}, {"finish_reason", finish}}})}};
                if (!usage.is_null()) {
                    c["usage"] = usage;
                }
                const std::string s = "data: " + c.dump() + "\n\n";
                return sink.write(s.data(), s.size());
            };
            GenResult r;
            std::string err;
            chunk({{"role", "assistant"}}, nullptr);
            // With tools the answer is parsed once complete (a tool call is only meaningful whole): meanwhile keep-alive comments
            // hold the connection open and reveal a client that went away.
            static const std::string ping = ": ws-working\n\n";
            auto on_piece = [&](const std::string& piece) {
                if (!tools) {
                    return chunk({{"content", piece}}, nullptr);
                }
                if (live) {
                    std::lock_guard<std::mutex> ll(live->m);
                    live->text += piece;
                    if (live->text.size() > 40000) {
                        live->text.erase(0, live->text.size() - 30000);
                    }
                }
                return sink.write(ping.data(), ping.size());
            };
            std::string outcome;
            const bool ok = job_id.empty() ? engine.generate(key, body["messages"], sp, on_piece, r, err)
                                           : jobs.serve_v1(job_id, key, body["messages"], sp, job_ckpt_s, on_piece, [&] { return sink.write(ping.data(), ping.size()); }, skip_chars, r, err, outcome);
            if (outcome == "detached") {  // the client is gone (or the engine stops): the job keeps its state, nothing more to write
                sink.done();
                return true;
            }
            if (!ok) {
                const std::string s = "data: " + json({{"error", {{"message", err}}}}).dump() + "\n\n";
                sink.write(s.data(), s.size());
            } else if (!tools) {
                chunk(json::object(), r.finish, usage_of(r));
            } else {
                std::string finish;
                const json msg = build_message(body["messages"], sp, r, finish);
                if (msg.contains("reasoning_content")) {
                    chunk({{"reasoning_content", msg["reasoning_content"]}}, nullptr);
                }
                if (msg["content"].is_string() && !msg["content"].get<std::string>().empty()) {
                    chunk({{"content", msg["content"]}}, nullptr);
                }
                if (msg.contains("tool_calls")) {
                    json calls = json::array();
                    int i = 0;
                    for (auto tc : msg["tool_calls"]) {
                        tc["index"] = i++;
                        calls.push_back(tc);
                    }
                    chunk({{"tool_calls", calls}}, nullptr);
                }
                chunk(json::object(), finish, usage_of(r));
            }
            const std::string done = "data: [DONE]\n\n";
            sink.write(done.data(), done.size());
            sink.done();
            return true;
        });
    });

    // ---- characters ----
    svr.Get("/api/characters", [&](const httplib::Request&, httplib::Response& res) {
        std::lock_guard<std::mutex> l(cast.mx);
        json arr = json::array();
        for (const auto& [n, c] : cast.chars_) {
            arr.push_back({{"name", n}, {"system", c.system}, {"notes", c.notes}, {"messages", c.history.size()}});
        }
        reply_json(res, 200, {{"characters", arr}});
    });
    const std::string name_re = R"(/api/characters/([^/]+))";
    svr.Get(name_re, [&](const httplib::Request& req, httplib::Response& res) {
        std::lock_guard<std::mutex> l(cast.mx);
        const auto it = cast.chars_.find(httplib::decode_uri_component(req.matches[1]));
        if (it == cast.chars_.end()) {
            return reply_err(res, 404, "unknown character");
        }
        reply_json(res, 200, {{"name", it->second.name}, {"system", it->second.system}, {"notes", it->second.notes}, {"history", it->second.history},
                              {"summary", it->second.summary}, {"summary_upto", it->second.summary_upto}});
    });
    svr.Put(name_re, [&](const httplib::Request& req, httplib::Response& res) {
        json b = json::parse(req.body, nullptr, false);
        if (!b.is_object()) {
            return reply_err(res, 400, "JSON body expected: {system, notes?}");
        }
        std::lock_guard<std::mutex> l(cast.mx);
        const std::string name = httplib::decode_uri_component(req.matches[1]);
        Character& c = cast.chars_[name];
        c.name = name;
        c.system = b.value("system", c.system);
        c.notes = b.value("notes", c.notes);
        if (b.contains("summary") && b["summary"].is_string()) {
            c.summary = b["summary"].get<std::string>();  // the summary can be corrected by hand
        }
        cast.save(c);
        reply_json(res, 200, {{"ok", true}});
    });
    svr.Delete(name_re, [&](const httplib::Request& req, httplib::Response& res) {
        const std::string name = httplib::decode_uri_component(req.matches[1]);
        {
            std::lock_guard<std::mutex> l(cast.mx);
            cast.remove(name);
        }
        std::lock_guard<std::mutex> l(engine.mx);
        engine.drop_thread_locked("char:" + name);
        reply_json(res, 200, {{"ok", true}});
    });
    // fold the older exchanges into the summary now (in the background; progress in /api/status "memory")
    svr.Post(R"(/api/characters/([^/]+)/summarize)", [&](const httplib::Request& req, httplib::Response& res) {
        const std::string name = httplib::decode_uri_component(req.matches[1]);
        {
            std::lock_guard<std::mutex> l(cast.mx);
            if (!cast.chars_.count(name)) {
                return reply_err(res, 404, "unknown character");
            }
        }
        summarizer.request(name, true);
        reply_json(res, 200, {{"queued", true}});
    });
    svr.Post(R"(/api/characters/([^/]+)/reset)", [&](const httplib::Request& req, httplib::Response& res) {
        const std::string name = httplib::decode_uri_component(req.matches[1]);
        {
            std::lock_guard<std::mutex> l(cast.mx);
            const auto it = cast.chars_.find(name);
            if (it == cast.chars_.end()) {
                return reply_err(res, 404, "unknown character");
            }
            it->second.history = json::array();
            it->second.summary.clear();
            it->second.summary_upto = 0;
            cast.save(it->second);
        }
        std::lock_guard<std::mutex> l(engine.mx);
        engine.drop_thread_locked("char:" + name);
        reply_json(res, 200, {{"ok", true}});
    });
    // One chat turn of a character. `on_text` receives the text as it is produced (return false to stop). Returns {status, body}.
    auto chat_run = [&](const std::string& name, const json& b, const std::function<bool(const std::string&)>& on_text) -> std::pair<int, json> {
        auto fail = [](int st, const std::string& msg) { return std::make_pair(st, json{{"error", {{"message", msg}}}, {"detail", msg}}); };
        std::lock_guard<std::mutex> chat_lock(chat_mx);
        Character c;
        {
            std::lock_guard<std::mutex> l(cast.mx);
            const auto it = cast.chars_.find(name);
            if (it == cast.chars_.end()) {
                return fail(404, "unknown character");
            }
            c = it->second;
        }
        Sampling sp = parse_sampling(b);
        if (sp.domain.empty()) {
            sp.domain = name;  // a character's expert usage is recorded under its own name
        }
        sp.reserve = std::min(1024, cfg.n_ctx / 4);  // old exchanges are dropped early enough to leave room for a real answer
        json hist = json::array();  // what the summary does not cover yet
        for (std::size_t i = std::min<std::size_t>(static_cast<std::size_t>(std::max(0, c.summary_upto)), c.history.size()); i < c.history.size(); ++i) {
            hist.push_back(c.history[i]);
        }
        hist.push_back({{"role", "user"}, {"content", b["message"]}});
        std::string sys_eff = c.system;
        if (!c.summary.empty()) {
            sys_eff += (sys_eff.empty() ? std::string() : std::string("\n\n")) + "[Résumé de la conversation précédente]\n" + c.summary;
        }
        bool trimmed = false;
        GenResult r;
        std::string err;
        for (;;) {  // an overlong history loses its oldest exchange until the prompt fits
            json msgs = json::array();
            if (!sys_eff.empty()) {
                msgs.push_back({{"role", "system"}, {"content", sys_eff}});
            }
            for (const auto& m : hist) {
                msgs.push_back(m);
            }
            r = GenResult();
            err.clear();
            if (engine.generate("char:" + name, msgs, sp, on_text, r, err)) {
                break;
            }
            if (r.overflow && hist.size() <= 1 && sp.reserve > 0) {
                sp.reserve = 0;  // even the last message alone does not leave the usual room: try with what there is
                continue;
            }
            if (!r.overflow || hist.size() <= 1) {
                return fail(r.overflow ? 400 : (r.memory_pause ? 503 : 500), err);
            }
            hist.erase(hist.begin(), hist.begin() + std::min<std::size_t>(2, hist.size() - 1));
            trimmed = true;
        }
        {
            std::lock_guard<std::mutex> l(cast.mx);
            Character& stored = cast.chars_[name];
            stored.history.push_back({{"role", "user"}, {"content", b["message"]}});
            stored.history.push_back({{"role", "assistant"}, {"content", r.text}});  // an interrupted answer is kept as far as it went
            cast.save(stored);
        }
        if (trimmed || (r.prompt_tokens + r.completion_tokens) * 10 > cfg.n_ctx * 7) {
            summarizer.request(name, false);  // the context is getting full: the oldest exchanges are folded into the summary
        }
        return {200, {{"reply", r.text}, {"finish_reason", r.finish},
                      {"tokens", {{"prompt", r.prompt_tokens}, {"reused", r.reused_tokens}, {"generated", r.completion_tokens}, {"context_shifts", r.shifts}}},
                      {"seconds", {{"prefill", r.prefill_s}, {"generation", r.gen_s}}}}};
    };
    // {character, draft} : the user is typing (see Engine::typing_warm). Sent every ~2 s while keys are pressed; returns at once.
    svr.Post("/api/typing", [&](const httplib::Request& req, httplib::Response& res) {
        json b = json::parse(req.body, nullptr, false);
        if (!b.is_object() || !b.contains("character") || !b["character"].is_string()) {
            return reply_err(res, 400, "JSON body expected: {character, draft?}");
        }
        if (!engine.typing_warm) {
            return reply_json(res, 200, json{{"ok", true}, {"warm", false}});
        }
        const std::string name = b["character"].get<std::string>();
        Character c;
        {
            std::lock_guard<std::mutex> l(cast.mx);
            const auto it = cast.chars_.find(name);
            if (it == cast.chars_.end()) {
                return reply_err(res, 404, "unknown character");
            }
            c = it->second;
        }
        const std::string draft = b.value("draft", std::string());
        Engine::TypingJob job;
        job.key = "char:" + name;
        job.sp = parse_sampling(b);
        job.sp.domain = name;
        job.sp.reserve = std::min(1024, engine.cfg.n_ctx / 4);
        job.draft = draft;
        std::string sys_eff = c.system;
        if (!c.summary.empty()) {
            sys_eff += (sys_eff.empty() ? std::string() : std::string("\n\n")) + "[Résumé de la conversation précédente]\n" + c.summary;
        }
        job.messages = json::array();
        if (!sys_eff.empty()) {
            job.messages.push_back({{"role", "system"}, {"content", sys_eff}});
        }
        for (std::size_t i = std::min<std::size_t>(static_cast<std::size_t>(std::max(0, c.summary_upto)), c.history.size()); i < c.history.size(); ++i) {
            job.messages.push_back(c.history[i]);
        }
        job.messages.push_back({{"role", "user"}, {"content", draft}});
        engine.typing_signal(std::move(job));
        reply_json(res, 200, json{{"ok", true}, {"warm", true}});
    });
    // "stream": true -> server-sent events {delta} ... then a last {done:true, status, reply, ...}; closing the connection stops the generation
    svr.Post(R"(/api/characters/([^/]+)/chat)", [&](const httplib::Request& req, httplib::Response& res) {
        if (phases && phases->auto_phase) {
            phases->request("speak");
            phases->wait_settled(60000);
        }
        json b = json::parse(req.body, nullptr, false);
        if (!b.is_object() || !b.contains("message") || !b["message"].is_string()) {
            return reply_err(res, 400, "JSON body expected: {message, stream?, max_tokens?, temperature?...}");
        }
        const std::string name = httplib::decode_uri_component(req.matches[1]);
        if (!b.value("stream", false)) {
            const auto out = chat_run(name, b, [](const std::string&) { return true; });
            return reply_json(res, out.first, out.second);
        }
        res.set_chunked_content_provider("text/event-stream", [&, name, b](size_t, httplib::DataSink& sink) {
            auto emit = [&](const json& j) {
                const std::string line = "data: " + j.dump() + "\n\n";
                return sink.write(line.data(), line.size());
            };
            auto out = chat_run(name, b, [&](const std::string& piece) { return emit({{"delta", piece}}); });
            out.second["status"] = out.first;
            out.second["done"] = true;
            emit(out.second);
            sink.done();
            return true;
        });
    });
    svr.Post("/api/stop", [&](const httplib::Request&, httplib::Response& res) {
        engine.stop_request = true;
        reply_json(res, 200, {{"ok", true}});
    });

    // ---- expert sheets ----
    svr.Get("/api/experts", [&](const httplib::Request& req, httplib::Response& res) {
        reply_json(res, 200, engine.experts_summary(req.get_param_value("domain")));
    });
    svr.Get("/api/experts/heatmap", [&](const httplib::Request& req, httplib::Response& res) {
        reply_json(res, 200, engine.experts_heatmap(req.get_param_value("domain")));
    });
    svr.Get("/api/experts/expert", [&](const httplib::Request& req, httplib::Response& res) {
        reply_json(res, 200, engine.expert_card(std::atoi(req.get_param_value("layer").c_str()), std::atoi(req.get_param_value("expert").c_str())));
    });
    svr.Post("/api/experts/save", [&](const httplib::Request&, httplib::Response& res) {
        engine.save_sheets();
        reply_json(res, 200, {{"ok", true}, {"file", engine.sheets_path()}});
    });

    // ---- resources ----
    // The engine mutex is held for a whole generation: do not make the page wait for it (the lists and menus would stay empty for minutes).
    // While a generation runs, answer with the last snapshot taken when the engine was free.
    svr.Get("/api/status", [&](const httplib::Request&, httplib::Response& res) {
        static std::mutex snap_mx;
        static json snap;
        std::unique_lock<std::mutex> l(engine.mx, std::defer_lock);
        for (int i = 0; i < 10 && !l.owns_lock(); ++i) {
            if (!l.try_lock()) {
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
            }
        }
        json st;
        if (l.owns_lock()) {
            st = engine.status_locked();
            l.unlock();
            std::lock_guard<std::mutex> sl(snap_mx);
            snap = st;
        } else {
            std::lock_guard<std::mutex> sl(snap_mx);
            st = snap.is_object() ? snap : json::object();
            st["busy"] = true;
            st["paliers"] = engine.paliers_json();  // live even while a generation holds the engine
        }
        st["memory"] = summarizer.status();
        if (phases) {
            st["phase"] = phases->status();
        }
        if (decider_p) {
            static std::mutex dm;
            static json dsnap;
            std::unique_lock<std::mutex> dl(decider_p->mx, std::try_to_lock);
            json o;
            if (dl.owns_lock()) {
                const json ds = decider_p->status_locked();
                dl.unlock();
                o = {{"model_file", ds.value("model_file", "")}, {"state", ds.value("state", "")}, {"resources", ds.value("resources", json::object())},
                     {"expert_cache", ds.value("expert_cache", json::object())}, {"process", ds.value("process", json::object())}};
                std::lock_guard<std::mutex> sl(dm);
                dsnap = o;
            } else {
                std::lock_guard<std::mutex> sl(dm);
                o = dsnap.is_object() ? dsnap : json::object();
                o["busy"] = true;
            }
            st["decider"] = o;
        }
        reply_json(res, 200, st);
    });
    svr.Post("/api/resources", [&](const httplib::Request& req, httplib::Response& res) {
        json b = json::parse(req.body, nullptr, false);
        if (!b.is_object()) {
            return reply_err(res, 400, "JSON body expected: {slots?, n_ctx?, cache_mib?, ws_ram_mib?}");
        }
        std::lock_guard<std::mutex> l(engine.mx);
        std::string err;
        if (!engine.apply_resources_locked(b, err)) {
            return reply_err(res, 500, err);
        }
        reply_json(res, 200, engine.status_locked());
    });
    // {path?, profile?} : change model and/or resource profile (reloads the model: ~10 s plus the pre-caches of the new model)
    svr.Post("/api/model", [&](const httplib::Request& req, httplib::Response& res) {
        json b = json::parse(req.body, nullptr, false);
        if (!b.is_object()) {
            return reply_err(res, 400, "JSON body expected: {path?, profile?}");
        }
        std::lock_guard<std::mutex> l(engine.mx);
        std::string err;
        if (!engine.switch_locked(b.value("path", std::string()), b.value("profile", std::string()), err)) {
            return reply_err(res, 500, err);
        }
        reply_json(res, 200, engine.status_locked());
    });
    // {phase: "decide" | "speak" | "image" | "flat", wait?: ms} : slides the RAM pool toward the model about to work (see PhaseMgr)
    svr.Post("/api/phase", [&](const httplib::Request& req, httplib::Response& res) {
        json b = json::parse(req.body, nullptr, false);
        const std::string ph = b.is_object() ? b.value("phase", std::string()) : std::string();
        if (!phases) {
            return reply_err(res, 400, "no decider model loaded (--decider-model)");
        }
        if (ph != "decide" && ph != "speak" && ph != "image" && ph != "flat") {
            return reply_err(res, 400, "phase must be decide, speak, image or flat");
        }
        phases->request(ph);
        if (b.value("wait", 0) > 0) {
            phases->wait_settled(b.value("wait", 0));
        }
        reply_json(res, 200, phases->status());
    });
    svr.Post("/api/suspend", [&](const httplib::Request& req, httplib::Response& res) {
        // {"keep_ram_mib": N}: free the GPU only, keep (at most N MiB of) the expert cache in RAM for the quick reload
        std::size_t keep_ram_mib = 0;
        if (!req.body.empty()) {
            const json kb = json::parse(req.body, nullptr, false);
            if (kb.is_object() && kb.contains("keep_ram_mib") && kb["keep_ram_mib"].is_number()) {
                keep_ram_mib = static_cast<std::size_t>(std::max<long long>(0, kb["keep_ram_mib"].get<long long>()));
            }
        }
        ++engine.suspend_waiting;  // background slices stop at once; the suspend only waits for the slice in flight
        std::lock_guard<std::mutex> l(engine.mx);
        --engine.suspend_waiting;
        engine.held_off = true;
        engine.suspend_locked(keep_ram_mib);
        if (decider_p) {
            std::lock_guard<std::mutex> dl(decider_p->mx);
            decider_p->suspend_locked();
        }
        reply_json(res, 200, engine.status_locked());
    });
    svr.Post("/api/resume", [&](const httplib::Request&, httplib::Response& res) {
        std::lock_guard<std::mutex> l(engine.mx);
        engine.held_off = false;
        if (!engine.ensure_running_locked()) {
            return reply_err(res, 500, engine.error);
        }
        if (decider_p) {
            std::lock_guard<std::mutex> dl(decider_p->mx);
            if (!decider_p->ensure_running_locked()) {
                return reply_err(res, 500, "decider: " + decider_p->error);
            }
        }
        reply_json(res, 200, engine.status_locked());
    });

    // ---- models and pre-caches ----
    svr.Get("/api/models", [&](const httplib::Request&, httplib::Response& res) {
        std::lock_guard<std::mutex> l(engine.mx);
        reply_json(res, 200, engine.models_json_locked());
    });
    // DELETE removes WeightStream's data for a model (expert sheets, thread states, pre-caches); the model file itself is never touched.
    // Without confirm=1 it only reports what would go.
    svr.Delete(R"(/api/models/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
        std::lock_guard<std::mutex> l(engine.mx);
        const std::string id = req.matches[1];
        for (const auto& m : engine.scan_models()) {
            if (m.id != id) {
                continue;
            }
            if (m.current) {
                return reply_err(res, 400, "cannot delete the data of the model in use");
            }
            if (!req.has_param("confirm")) {
                reply_json(res, 409, {{"confirm_required", true}, {"message", "Deleting this folder removes " + std::to_string(m.dir_bytes / 1048576) +
                                       " MB, including " + std::to_string(m.pre_bytes / 1048576) + " MB of pre-caches (they can be re-generated if you use this model again). Repeat with ?confirm=1."},
                                      {"would_delete", {{"dir", fs::absolute(m.dir).string()}, {"bytes", m.dir_bytes}, {"precaches", m.pre_files}}}});
                return;
            }
            std::error_code ec;
            fs::remove_all(m.dir, ec);
            return reply_json(res, 200, {{"ok", !ec}});
        }
        reply_err(res, 404, "unknown model folder");
    });
    svr.Put(R"(/api/models/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
        json b = json::parse(req.body, nullptr, false);
        std::lock_guard<std::mutex> l(engine.mx);
        for (const auto& m : engine.scan_models()) {
            if (m.id == req.matches[1]) {
                json meta = m.meta;
                if (b.is_object() && b.contains("pin") && b["pin"].is_boolean()) {
                    meta["pin"] = b["pin"].get<bool>();  // exempt from the idle rule and from replacement
                }
                Engine::write_model_json_to(m.dir, meta);
                return reply_json(res, 200, {{"ok", true}});
            }
        }
        reply_err(res, 404, "unknown model folder");
    });
    svr.Post(R"(/api/models/([^/]+)/clear-precaches)", [&](const httplib::Request& req, httplib::Response& res) {
        std::lock_guard<std::mutex> l(engine.mx);
        for (const auto& m : engine.scan_models()) {
            if (m.id == req.matches[1]) {
                engine.remove_precache_files(m);
                return reply_json(res, 200, {{"ok", true}, {"freed_bytes", m.pre_bytes}});
            }
        }
        reply_err(res, 404, "unknown model folder");
    });
    svr.Get("/api/settings", [&](const httplib::Request&, httplib::Response& res) {
        std::lock_guard<std::mutex> l(engine.mx);
        reply_json(res, 200, engine.settings_json());
    });
    svr.Post("/api/settings", [&](const httplib::Request& req, httplib::Response& res) {
        json b = json::parse(req.body, nullptr, false);
        std::lock_guard<std::mutex> l(engine.mx);
        if (b.is_object()) {
            engine.apply_settings(b);
            engine.save_settings();
        }
        reply_json(res, 200, engine.settings_json());
    });
    // the idle rule: without apply it only reports the plan
    svr.Post("/api/housekeeping", [&](const httplib::Request& req, httplib::Response& res) {
        json b = json::parse(req.body, nullptr, false);
        std::lock_guard<std::mutex> l(engine.mx);
        reply_json(res, 200, engine.housekeeping_locked(b.is_object() && b.value("apply", false)));
    });
    svr.Get("/api/precaches", [&](const httplib::Request&, httplib::Response& res) {
        std::lock_guard<std::mutex> l(engine.mx);
        reply_json(res, 200, engine.precaches_json_locked());
    });
    svr.Put(R"(/api/precaches/([A-Za-z0-9_.-]+))", [&](const httplib::Request& req, httplib::Response& res) {
        json b = json::parse(req.body, nullptr, false);
        std::string err;
        std::lock_guard<std::mutex> l(engine.mx);
        if (!engine.put_recipe_locked(req.matches[1], b, err)) {
            return reply_err(res, 400, err);
        }
        reply_json(res, 200, {{"ok", true}});
    });
    svr.Delete(R"(/api/precaches/([A-Za-z0-9_.-]+))", [&](const httplib::Request& req, httplib::Response& res) {
        std::lock_guard<std::mutex> l(engine.mx);
        const std::string name = req.matches[1];
        const auto it = engine.recipes.find(name);
        if (it == engine.recipes.end()) {
            return reply_err(res, 404, "unknown pre-cache");
        }
        engine.drop_thread_locked(engine.precache_key(it->second));
        engine.write_index_locked();
        engine.recipes.erase(it);
        std::error_code ec;
        fs::remove(engine.recipes_dir() / (name + ".json"), ec);
        reply_json(res, 200, {{"ok", true}});
    });
    // POST .../build : build now (loads the model if needed); POST .../clear : drop the state, keep the recipe
    svr.Post(R"(/api/precaches/([A-Za-z0-9_.-]+)/(build|clear))", [&](const httplib::Request& req, httplib::Response& res) {
        std::lock_guard<std::mutex> l(engine.mx);
        const std::string name = req.matches[1];
        const auto it = engine.recipes.find(name);
        if (it == engine.recipes.end()) {
            return reply_err(res, 404, "unknown pre-cache");
        }
        if (req.matches[2] == "clear") {
            engine.drop_thread_locked(engine.precache_key(it->second));
            engine.write_index_locked();
        } else {
            std::string err;
            json info = json::object();
            if (!engine.build_precache_locked(name, err, req.has_param("evict"), &info)) {
                if (err.rfind("cap_reached", 0) == 0) {
                    reply_json(res, 409, {{"error", {{"message", err}, {"type", "cap_reached"}}}, {"detail", err}, {"candidates", info.value("candidates", json::array())}});
                    return;
                }
                return reply_err(res, 500, err);
            }
        }
        reply_json(res, 200, engine.precaches_json_locked());
    });

    // ---- jobs: resumable background generations ----
    svr.Post("/api/jobs", [&](const httplib::Request& req, httplib::Response& res) {
        json b = json::parse(req.body, nullptr, false);
        if (!b.is_object() || !((b.contains("messages") && b["messages"].is_array() && !b["messages"].empty()) || b.contains("prompt"))) {
            return reply_err(res, 400, "messages or prompt missing");
        }
        reply_json(res, 200, {{"id", jobs.submit(b)}});
    });
    svr.Get("/api/jobs", [&](const httplib::Request&, httplib::Response& res) { reply_json(res, 200, jobs.list()); });
    svr.Get(R"(/api/jobs/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
        json j;
        if (!jobs.get(req.matches[1], j)) {
            return reply_err(res, 404, "unknown job");
        }
        reply_json(res, 200, j);
    });
    svr.Get(R"(/api/jobs/([^/]+)/live)", [&](const httplib::Request& req, httplib::Response& res) {
        std::shared_ptr<LiveText> lt;
        {
            std::lock_guard<std::mutex> lg(g_live_mx);
            const auto it = g_live.find(req.matches[1]);
            if (it != g_live.end()) {
                lt = it->second;
            }
        }
        if (!lt) {
            return reply_err(res, 404, "no live text for this job");
        }
        std::lock_guard<std::mutex> ll(lt->m);
        // a token piece may end in the middle of a UTF-8 character: invalid bytes are replaced rather than throwing
        res.set_content(json({{"text", lt->text}}).dump(-1, ' ', false, json::error_handler_t::replace), "application/json");
    });
    svr.Post(R"(/api/jobs/([^/]+)/(pause|resume|cancel))", [&](const httplib::Request& req, httplib::Response& res) {
        std::string err;
        if (!jobs.act(req.matches[1], req.matches[2], err)) {
            return reply_err(res, 400, err);
        }
        reply_json(res, 200, {{"ok", true}});
    });

    std::fprintf(stderr, "[ws_npc_server] http://%s:%d/  model %s | streaming %s | slots %d x %d tokens\n", cfg.host.c_str(), cfg.port,
                 fs::path(cfg.model).filename().string().c_str(), cfg.ws_ram_mib > 0 ? (cfg.cpu_stream ? "cpu" : "gpu-cache") : "off", cfg.slots, cfg.n_ctx);
    std::fprintf(stderr, "[ws_npc_server] the model loads at the first request (or POST /api/resume)\n");
    jobs.start(!no_resume_jobs);
    std::thread startup_precache([&] {  // pre-caches whose policy is "startup": the model loads now instead of at the first request
        std::lock_guard<std::mutex> l(engine.mx);
        for (const auto& [name, r] : engine.recipes) {
            if (r.value("load", "") == "startup") {
                engine.ensure_running_locked();  // builds the missing states of every non-manual pre-cache
                break;
            }
        }
    });
    const bool listened = svr.listen(cfg.host, cfg.port);
    if (startup_precache.joinable()) {
        startup_precache.join();
    }
    summarizer.shutdown();
    jobs.shutdown();  // a running job checkpoints, then the service goes down
    if (!listened) {
        std::cerr << "cannot listen on " << cfg.host << ":" << cfg.port << "\n";
        return 1;
    }
    {
        std::lock_guard<std::mutex> l(engine.mx);
        engine.suspend_locked();  // saves every awake thread
        engine.drop_volatile_precaches_locked();
    }
    return 0;
}
