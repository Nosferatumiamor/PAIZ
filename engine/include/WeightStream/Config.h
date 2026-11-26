#pragma once

#include <cstddef>
#include <cstdint>

namespace ws {

enum class ProfileMode {
    Off,
    Record,
    Replay,
};

/// Where compute runs (Phase 2 API; only GpuOnly/HybridStatic wired today).
enum class ExecutionPolicy {
    GpuOnly,
    CpuOnly,
    HybridStatic,
    HybridDynamic,  // reserved — scheduler decides at runtime (Phase 3)
};

/// How the host memory guard applies limits.
enum class SystemMemoryGuardMode {
    Off,
    Manual,  /// user allowance slider (0–100 % of free headroom)
    Auto,    /// adapt throttle to non-WeightStream RAM pressure
};

/// Burst = model load. Infer = brief generation burst. Steady = idle protection.
enum class SystemMemoryGuardPhase {
    Burst,
    Infer,
    Steady,
};

/// Runtime configuration for the streaming engine.
struct Config {
    /// Simulated VRAM budget (bytes). Default: 12 GiB (RTX 3060).
    std::size_t vram_capacity = 12ULL * 1024 * 1024 * 1024;

    /// Host RAM cache budget (bytes). Default: 32 GiB (target: RTX 3060 + 32 GB system RAM).
    std::size_t ram_capacity = 32ULL * 1024 * 1024 * 1024;

    /// Fixed page size (bytes). 0 = one chunk per tensor (legacy mode).
    std::size_t page_size = 32ULL * 1024 * 1024;

    /// Number of chunks to prefetch ahead in FIFO order.
    std::uint32_t prefetch_window = 4;

    /// I/O buffer size for SSD reads.
    std::size_t io_block_size = 4 * 1024 * 1024;

    /// Max bytes per coalesced SSD read (0 = disabled). Default off until eviction path is stable.
    std::size_t coalesce_max_bytes = 0;

    /// Profile-guided optimization mode.
    ProfileMode profile_mode = ProfileMode::Off;

    /// Evict from VRAM immediately after last use in profile (replay mode).
    bool profile_immediate_evict = true;

    /// Pin all pages still referenced later in the profile (needs huge RAM if disabled evict).
    bool profile_pin_future_pages = true;

    /// Enable verbose logging to stderr.
    bool verbose = false;

    /// RAM xor VRAM residency (move semantics). RAM is backing store, VRAM is cache overlay.
    bool single_copy_hierarchy = true;

    /// Assert ssd_reads(page) <= 1 while page remains resident (debug builds).
    bool debug_ssd_invariant = true;

    /// Assert cache/LRU/VTAS residency invariants (abort on first violation).
    bool debug_cache_invariants = false;

    /// Exhaustive page-lifecycle checks after every cache/scheduler/read operation (very slow).
    bool debug_paranoid = false;

    /// Use CUDA device memory for the VRAM tier (requires WEIGHTSTREAM_HAS_CUDA build).
    bool cuda_vram = true;

    /// Background worker for prefetch/upload jobs.
    bool background_scheduler = true;

    /// Route data-section reads through the RAM page cache (disable to force direct SSD).
    bool read_at_page_cache = true;

    /// Cap host cache and throttle I/O when system RAM is low (prefer slow over OS freeze).
    bool system_memory_guard = true;

    SystemMemoryGuardMode system_memory_guard_mode = SystemMemoryGuardMode::Auto;

    /// Burst during load; switch to Steady once the model/UI is ready.
    SystemMemoryGuardPhase system_memory_guard_phase = SystemMemoryGuardPhase::Burst;

    /// Manual mode: fraction of (avail − reserve) WeightStream may use (0.0–1.0).
    double system_memory_allowance = 0.85;

    /// Auto mode: avail RAM at session start (0 = set on first guard call).
    std::size_t system_memory_baseline_avail = 0;

    /// Bytes left for OS / desktop / llama outside WeightStream cache.
    std::size_t system_reserve_bytes = 2ULL * 1024 * 1024 * 1024;

    /// Start throttling when avail physical RAM drops below this.
    std::size_t system_soft_min_free_bytes = 4ULL * 1024 * 1024 * 1024;

    /// Aggressive throttling below this.
    std::size_t system_hard_min_free_bytes = 2ULL * 1024 * 1024 * 1024;

    /// Long waits before growing host footprint below this.
    std::size_t system_critical_free_bytes = 1ULL * 1024 * 1024 * 1024;

    /// Max fraction of physical RAM for host cache cap at load (0 = use avail-reserve only).
    double system_max_host_fraction = 0.0;

    /// Base sleep when throttling (ms); scaled up under Hard/Critical pressure.
    std::uint32_t system_throttle_ms = 25;

    /// GPU layers for load-time page priority (0 = disabled). Matches llama `-ngl`.
    int load_priority_ngl = 0;

    /// Compute placement policy (see Docs/ROADMAP.md Phase 2).
    ExecutionPolicy execution_policy = ExecutionPolicy::HybridStatic;

    bool paged_mode() const { return page_size > 0; }
    bool coalesce_enabled() const { return coalesce_max_bytes > 0; }

    bool invariant_checks() const { return debug_cache_invariants || debug_paranoid; }
    bool paranoid_checks() const { return debug_paranoid; }
};

}  // namespace ws
