#pragma once

#include "WeightStream/Config.h"

#include <cstddef>
#include <cstdint>
#include <string>

namespace ws {

/// Snapshot of host physical memory (best-effort; 0 if unavailable).
struct SystemMemoryInfo {
    std::size_t total_bytes = 0;
    std::size_t avail_bytes = 0;
};

enum class MemoryPressure {
    Normal,
    Soft,
    Hard,
    Critical,
};

/// Live status for UI meters.
struct MemoryGuardStatus {
    SystemMemoryInfo system{};
    MemoryPressure pressure = MemoryPressure::Normal;
    std::size_t ws_cache_used_bytes = 0;
    std::size_t ws_cache_capacity_bytes = 0;
    double allowance = 1.0;
    SystemMemoryGuardMode mode{};
    SystemMemoryGuardPhase phase = SystemMemoryGuardPhase::Burst;
    double ram_used_pct = 0.0;
    double headroom_gib = 0.0;
};

/// Host RAM protection: cap cache budget and throttle before large allocations.
class SystemMemoryGuard {
public:
    static SystemMemoryInfo query();

    static MemoryPressure classify(const Config& config, const SystemMemoryInfo& info,
                                   std::size_t ws_cache_used_bytes = 0);

    static std::size_t cap_cache_budget(std::size_t requested_bytes, const Config& config);

    static void wait_before_host_growth(const Config& config, std::size_t bytes_needed,
                                        std::size_t ws_cache_used_bytes = 0,
                                        bool page_is_hot = true);

    static MemoryGuardStatus status(const Config& config, std::size_t ws_cache_used_bytes,
                                    std::size_t ws_cache_capacity_bytes);

    static std::string status_json(const MemoryGuardStatus& status);

    /// Model load: full speed, only brake near OS OOM.
    static void enter_burst_phase(Config& config);

    /// During token generation: prioritize GPU / weight fetch, minimal throttle.
    static void enter_infer_burst_phase(Config& config);

    /// After load / UI open: protect desktop from sustained saturation.
    static void enter_steady_phase(Config& config);

private:
    static void throttle(const Config& config, MemoryPressure level);
    static double effective_allowance(const Config& config, const SystemMemoryInfo& info,
                                      std::size_t ws_cache_used_bytes);
};

}  // namespace ws
