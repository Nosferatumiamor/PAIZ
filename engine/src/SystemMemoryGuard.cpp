#include "WeightStream/SystemMemoryGuard.h"

#include "WeightStream/Config.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <numeric>
#include <thread>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#elif defined(__linux__)
#include <sys/sysinfo.h>
#endif

namespace ws {

namespace {

double bytes_to_gib(std::size_t bytes) {
    return static_cast<double>(bytes) / (1024.0 * 1024.0 * 1024.0);
}

bool guard_active(const Config& config) {
    return config.system_memory_guard && config.system_memory_guard_mode != SystemMemoryGuardMode::Off;
}

bool burst_phase(const Config& config) {
    return config.system_memory_guard_phase == SystemMemoryGuardPhase::Burst;
}

bool infer_phase(const Config& config) {
    return config.system_memory_guard_phase == SystemMemoryGuardPhase::Infer;
}

}  // namespace

SystemMemoryInfo SystemMemoryGuard::query() {
    SystemMemoryInfo info{};

#if defined(_WIN32)
    MEMORYSTATUSEX status{};
    status.dwLength = sizeof(status);
    if (GlobalMemoryStatusEx(&status)) {
        info.total_bytes = static_cast<std::size_t>(status.ullTotalPhys);
        info.avail_bytes = static_cast<std::size_t>(status.ullAvailPhys);
    }
#elif defined(__linux__)
    sysinfo si{};
    if (sysinfo(&si) == 0) {
        info.total_bytes = static_cast<std::size_t>(si.totalram) * si.mem_unit;
        info.avail_bytes = static_cast<std::size_t>(si.freeram) * si.mem_unit;
    }
#else
    (void)info;
#endif

    return info;
}

double SystemMemoryGuard::effective_allowance(const Config& config, const SystemMemoryInfo& info,
                                              std::size_t ws_cache_used_bytes) {
    if (!guard_active(config)) {
        return 1.0;
    }

    if (config.system_memory_guard_mode == SystemMemoryGuardMode::Manual) {
        return std::clamp(config.system_memory_allowance, 0.05, 1.0);
    }

    // Auto in burst/infer: WS or GPU is actively working — don't tighten mid-flight.
    if (burst_phase(config) || infer_phase(config)) {
        return std::clamp(config.system_memory_allowance, 0.05, 1.0);
    }

    // Auto steady: start from user ceiling, tighten when other processes eat RAM.
    double allowance = std::clamp(config.system_memory_allowance, 0.05, 1.0);
    if (config.system_memory_baseline_avail > 0 && info.avail_bytes < config.system_memory_baseline_avail) {
        const std::size_t drop = config.system_memory_baseline_avail - info.avail_bytes;
        if (drop > ws_cache_used_bytes + (512ULL * 1024 * 1024)) {
            allowance *= 0.55;
        } else if (drop > ws_cache_used_bytes) {
            allowance *= 0.75;
        }
    }
    return std::max(0.05, allowance);
}

MemoryPressure SystemMemoryGuard::classify(const Config& config, const SystemMemoryInfo& info,
                                           std::size_t ws_cache_used_bytes) {
    if (!guard_active(config) || info.avail_bytes == 0) {
        return MemoryPressure::Normal;
    }

    const double allowance = effective_allowance(config, info, ws_cache_used_bytes);
    const auto scale = [allowance](std::size_t threshold) {
        return static_cast<std::size_t>(static_cast<double>(threshold) / std::max(0.2, allowance));
    };

    if (info.avail_bytes <= scale(config.system_critical_free_bytes)) {
        return MemoryPressure::Critical;
    }

    // Burst/infer: only brake near true OOM; soft/hard thresholds apply in steady phase.
    if (burst_phase(config) || infer_phase(config)) {
        return MemoryPressure::Normal;
    }

    if (info.avail_bytes <= scale(config.system_hard_min_free_bytes)) {
        return MemoryPressure::Hard;
    }
    if (info.avail_bytes <= scale(config.system_soft_min_free_bytes)) {
        return MemoryPressure::Soft;
    }
    return MemoryPressure::Normal;
}

void SystemMemoryGuard::throttle(const Config& config, MemoryPressure level) {
    if (level == MemoryPressure::Normal) {
        return;
    }

    std::uint32_t ms = config.system_throttle_ms;
    if (level == MemoryPressure::Hard) {
        ms *= 4;
    } else if (level == MemoryPressure::Critical) {
        ms *= 12;
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(ms));
    std::this_thread::yield();
}

std::size_t SystemMemoryGuard::cap_cache_budget(std::size_t requested_bytes, const Config& config) {
    if (!guard_active(config)) {
        return requested_bytes;
    }

    const auto info = query();
    if (info.total_bytes == 0) {
        return requested_bytes;
    }

    // Burst load: honor requested cache budget; only leave critical headroom for the OS.
    if (burst_phase(config)) {
        std::size_t cap = requested_bytes;
        if (config.system_max_host_fraction > 0.0) {
            const auto from_total = static_cast<std::size_t>(
                static_cast<double>(info.total_bytes) * config.system_max_host_fraction);
            cap = std::min(cap, from_total);
        } else if (info.total_bytes > config.system_critical_free_bytes) {
            cap = std::min(cap, info.total_bytes - config.system_critical_free_bytes);
        }
        return std::max<std::size_t>(cap, config.page_size > 0 ? config.page_size : 1);
    }

    const double allowance = effective_allowance(config, info, 0);
    std::size_t cap = requested_bytes;

    if (config.system_max_host_fraction > 0.0) {
        const auto from_total = static_cast<std::size_t>(
            static_cast<double>(info.total_bytes) * config.system_max_host_fraction);
        cap = std::min(cap, from_total);
    }

    std::size_t headroom = 0;
    if (info.avail_bytes > config.system_reserve_bytes) {
        headroom = info.avail_bytes - config.system_reserve_bytes;
    } else {
        headroom = info.avail_bytes / 4;
    }

    headroom = static_cast<std::size_t>(static_cast<double>(headroom) * allowance);
    cap = std::min(cap, headroom);

    return std::max<std::size_t>(cap, config.page_size > 0 ? config.page_size : 1);
}

void SystemMemoryGuard::wait_before_host_growth(const Config& config, std::size_t bytes_needed,
                                                std::size_t ws_cache_used_bytes, bool page_is_hot) {
    if (!guard_active(config)) {
        return;
    }

    // Burst + HOT, or Infer (generation): full speed unless OS is near OOM.
    if ((burst_phase(config) && page_is_hot) || infer_phase(config)) {
        const auto info = query();
        const auto pressure = classify(config, info, ws_cache_used_bytes);
        if (pressure != MemoryPressure::Critical) {
            return;
        }
        if (config.verbose) {
            static auto last_log = std::chrono::steady_clock::time_point{};
            const auto now = std::chrono::steady_clock::now();
            if (now - last_log > std::chrono::seconds(2)) {
                const char* tag = infer_phase(config) ? "infer" : "burst/hot";
                std::cerr << "[WeightStream] " << tag << " — brief pause (avail "
                          << (info.avail_bytes / (1024 * 1024)) << " MiB)\n";
                last_log = now;
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(config.system_throttle_ms));
        return;
    }

    // Burst + WARM: paced tail load — yield only when RAM is very tight.
    if (burst_phase(config) && !page_is_hot) {
        const auto info = query();
        const std::size_t warm_pace_below = std::max<std::size_t>(
            config.system_critical_free_bytes / 2, 256ULL * 1024 * 1024);
        if (info.avail_bytes > warm_pace_below) {
            return;
        }
        if (config.verbose) {
            static auto last_log = std::chrono::steady_clock::time_point{};
            const auto now = std::chrono::steady_clock::now();
            if (now - last_log > std::chrono::seconds(3)) {
                std::cerr << "[WeightStream] burst/warm — light pacing (avail "
                          << (info.avail_bytes / (1024 * 1024)) << " MiB)\n";
                last_log = now;
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(config.system_throttle_ms));
        return;
    }

    constexpr int k_max_attempts = 48;
    bool logged = false;

    for (int attempt = 0; attempt < k_max_attempts; ++attempt) {
        const auto info_loop = query();
        const double allowance = effective_allowance(config, info_loop, ws_cache_used_bytes);
        const std::size_t need =
            config.system_reserve_bytes + static_cast<std::size_t>(static_cast<double>(bytes_needed) / allowance);
        const auto pressure_loop = classify(config, info_loop, ws_cache_used_bytes);

        if (pressure_loop == MemoryPressure::Normal && info_loop.avail_bytes >= need) {
            return;
        }

        if (!logged && config.verbose && pressure_loop != MemoryPressure::Normal) {
            std::cerr << "[WeightStream] steady — memory pressure, throttling (avail "
                      << (info_loop.avail_bytes / (1024 * 1024)) << " MiB, allowance "
                      << static_cast<int>(allowance * 100) << "%)\n";
            logged = true;
        }

        throttle(config, pressure_loop);
    }
}

MemoryGuardStatus SystemMemoryGuard::status(const Config& config, std::size_t ws_cache_used_bytes,
                                            std::size_t ws_cache_capacity_bytes) {
    MemoryGuardStatus s{};
    s.system = query();
    s.ws_cache_used_bytes = ws_cache_used_bytes;
    s.ws_cache_capacity_bytes = ws_cache_capacity_bytes;
    s.allowance = effective_allowance(config, s.system, ws_cache_used_bytes);
    s.mode = config.system_memory_guard_mode;
    s.phase = config.system_memory_guard_phase;
    s.pressure = classify(config, s.system, ws_cache_used_bytes);

    if (s.system.total_bytes > 0) {
        const std::size_t used = s.system.total_bytes - s.system.avail_bytes;
        s.ram_used_pct = 100.0 * static_cast<double>(used) / static_cast<double>(s.system.total_bytes);
    }
    s.headroom_gib = bytes_to_gib(s.system.avail_bytes > config.system_reserve_bytes
                                      ? s.system.avail_bytes - config.system_reserve_bytes
                                      : s.system.avail_bytes / 4);
    return s;
}

std::string SystemMemoryGuard::status_json(const MemoryGuardStatus& status) {
    const char* pressure = "normal";
    switch (status.pressure) {
        case MemoryPressure::Soft:
            pressure = "soft";
            break;
        case MemoryPressure::Hard:
            pressure = "hard";
            break;
        case MemoryPressure::Critical:
            pressure = "critical";
            break;
        default:
            break;
    }

    const char* mode = "auto";
    if (status.mode == SystemMemoryGuardMode::Off) {
        mode = "off";
    } else if (status.mode == SystemMemoryGuardMode::Manual) {
        mode = "manual";
    }

    const char* phase = status.phase == SystemMemoryGuardPhase::Burst    ? "burst"
                        : status.phase == SystemMemoryGuardPhase::Infer ? "infer"
                                                                        : "steady";

    char buf[512];
    std::snprintf(buf,
                  sizeof(buf),
                  R"({"ram_total_gib":%.2f,"ram_avail_gib":%.2f,"ram_used_pct":%.1f,"headroom_gib":%.2f,"ws_cache_used_mib":%.1f,"ws_cache_cap_mib":%.1f,"allowance":%.2f,"pressure":"%s","mode":"%s","phase":"%s"})",
                  bytes_to_gib(status.system.total_bytes),
                  bytes_to_gib(status.system.avail_bytes),
                  status.ram_used_pct,
                  status.headroom_gib,
                  bytes_to_gib(status.ws_cache_used_bytes) * 1024.0,
                  bytes_to_gib(status.ws_cache_capacity_bytes) * 1024.0,
                  status.allowance,
                  pressure,
                  mode,
                  phase);
    return buf;
}

void SystemMemoryGuard::enter_burst_phase(Config& config) {
    config.system_memory_guard_phase = SystemMemoryGuardPhase::Burst;
    if (config.system_memory_baseline_avail == 0) {
        config.system_memory_baseline_avail = query().avail_bytes;
    }
    if (config.verbose) {
        std::cerr << "[WeightStream] memory guard: burst phase (load at full speed)\n";
    }
}

void SystemMemoryGuard::enter_infer_burst_phase(Config& config) {
    config.system_memory_guard_phase = SystemMemoryGuardPhase::Infer;
    if (config.verbose) {
        std::cerr << "[WeightStream] memory guard: infer burst (GPU priority)\n";
    }
}

void SystemMemoryGuard::enter_steady_phase(Config& config) {
    config.system_memory_guard_phase = SystemMemoryGuardPhase::Steady;
    config.system_memory_baseline_avail = query().avail_bytes;
    if (config.verbose) {
        std::cerr << "[WeightStream] memory guard: steady phase (runtime protection on)\n";
    }
}

}  // namespace ws
