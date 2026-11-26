#pragma once

#include "WeightStream/Config.h"
#include "WeightStream/Metrics.h"
#include "WeightStream/PageAutopsy.h"
#include "WeightStream/Profile.h"
#include "WeightStream/Profile.h"
#include "WeightStream/SSDReader.h"
#include "WeightStream/TierCache.h"
#include "WeightStream/VTAS.h"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <queue>
#include <thread>
#include <vector>

namespace ws {

/// MVP scheduler: FIFO order with a fixed prefetch window.
class Scheduler {
public:
    Scheduler(const Config& config,
              VTAS& vtas,
              TierCache& ram_cache,
              TierCache& vram_cache,
              SSDReader& ssd,
              Metrics& metrics);
    ~Scheduler();

    Scheduler(const Scheduler&) = delete;
    Scheduler& operator=(const Scheduler&) = delete;

    void start();
    void stop();

    void set_sync_mutex(std::mutex* mutex) { sync_mutex_ = mutex; }
    void set_autopsy(PageAutopsyCollector* autopsy) { autopsy_ = autopsy; }

    /// Profile-guided SSD load gating (replay mode).
    void set_profile_guidance(const WSProfile* profile, std::size_t step);

    /// HOT/WARM classification during model load.
    void set_load_priority(const LoadPriorityPlan* plan) { load_priority_ = plan; }

    /// Ensure chunk is in VRAM tier. Blocks until ready or failure.
    bool ensure_gpu_ready(VirtualTensorAddress address);

    /// Ensure chunk is in RAM tier (SSD load + coalesce). For read_at() during model load.
    bool ensure_ram_ready(VirtualTensorAddress address);

    /// Queue upcoming chunks for background prefetch (FIFO window).
    void prefetch_ahead(VirtualTensorAddress current);

    /// Prefetch using profile forward order at the given step.
    void prefetch_profile(const std::vector<std::size_t>& forward_order, std::size_t step);

    /// Legacy hook (no-op in backing-store mode).
    void demote_vram_to_ram(std::uint64_t key, const std::byte* data, std::size_t size);

    /// Sync VTAS when a tier drops a page entirely.
    void on_tier_evicted(std::uint64_t key, TensorState fallback_state);

    /// Run standard and/or paranoid invariant checks (no-op when disabled in config).
    void validate_checkpoint(const char* where) const;

private:
    enum class JobKind { LoadRam, UploadGpu };

    struct Job {
        VirtualTensorAddress address;
        JobKind kind;
    };

    void worker_loop();
    bool process_load_ram(VirtualTensorAddress address);
    bool process_upload_gpu(VirtualTensorAddress address);
    void enqueue_unique(Job job);
    void drain_redundant_load_jobs();
    std::uint64_t key_for(VirtualTensorAddress address) const;

    bool page_resident(std::uint64_t key) const;
    bool demote_vram_page(VirtualTensorAddress address);
    void check_ssd_invariant(std::size_t chunk_index) const;
    void debug_assert_single_copy(std::uint64_t key) const;
    bool allow_ssd_load(std::size_t chunk_index) const;

    void check_cache_invariants(const char* where) const;
    void assert_ram_page_ready(VirtualTensorAddress address, const char* where) const;
    void assert_page_not_in_cache(std::uint64_t key, const char* where) const;

    const Config& config_;
    VTAS& vtas_;
    TierCache& ram_cache_;
    TierCache& vram_cache_;
    SSDReader& ssd_;
    Metrics& metrics_;

    std::thread worker_;
    std::mutex mutex_;
    std::mutex load_mutex_;
    std::condition_variable cv_;
    std::queue<Job> jobs_;
    std::atomic<bool> running_{false};
    std::atomic<bool> stop_requested_{false};
    std::mutex* sync_mutex_ = nullptr;
    PageAutopsyCollector* autopsy_ = nullptr;
    const WSProfile* profile_ = nullptr;
    const LoadPriorityPlan* load_priority_ = nullptr;
    std::size_t profile_step_ = 0;
    std::vector<std::byte> load_staging_;
};

}  // namespace ws
