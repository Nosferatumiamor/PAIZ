#include "WeightStream/Scheduler.h"

#include "WeightStream/CacheInvariants.h"
#include "WeightStream/CudaTransfer.h"
#include "WeightStream/SafeMemcpy.h"
#include "WeightStream/SystemMemoryGuard.h"

#include <algorithm>
#include <cassert>
#include <chrono>
#include <cstring>
#include <iostream>
#include <vector>

namespace ws {

Scheduler::Scheduler(const Config& config,
                     VTAS& vtas,
                     TierCache& ram_cache,
                     TierCache& vram_cache,
                     SSDReader& ssd,
                     Metrics& metrics)
    : config_(config),
      vtas_(vtas),
      ram_cache_(ram_cache),
      vram_cache_(vram_cache),
      ssd_(ssd),
      metrics_(metrics) {}

Scheduler::~Scheduler() {
    stop();
}

void Scheduler::start() {
    if (running_.exchange(true)) {
        return;
    }
    stop_requested_ = false;
    worker_ = std::thread([this] { worker_loop(); });
}

void Scheduler::stop() {
    if (!running_.exchange(false)) {
        return;
    }
    stop_requested_ = true;
    cv_.notify_all();
    if (worker_.joinable()) {
        worker_.join();
    }
}

std::uint64_t Scheduler::key_for(VirtualTensorAddress address) const {
    return address.value;
}

bool Scheduler::page_resident(std::uint64_t key) const {
    return ram_cache_.contains(key) || vram_cache_.contains(key);
}

void Scheduler::check_ssd_invariant(std::size_t chunk_index) const {
    if (!config_.debug_ssd_invariant || !autopsy_) {
        return;
    }

    const auto& entries = autopsy_->entries();
    if (chunk_index >= entries.size()) {
        return;
    }

    if (entries[chunk_index].loads_from_ssd <= 1) {
        return;
    }

    std::cerr << "[WeightStream] SSD invariant violated: page " << chunk_index << " loaded "
              << entries[chunk_index].loads_from_ssd << " times from SSD\n";
    assert(false && "SSD invariant violated");
}

void Scheduler::debug_assert_single_copy(std::uint64_t key) const {
    if (!config_.single_copy_hierarchy) {
        return;
    }

    if (ram_cache_.contains(key) && vram_cache_.contains(key)) {
        std::cerr << "[WeightStream] Single-copy violated: page 0x" << std::hex << key << std::dec
                  << " in both RAM and VRAM\n";
        assert(false && "Single-copy invariant violated");
    }
}

void Scheduler::set_profile_guidance(const WSProfile* profile, std::size_t step) {
    profile_ = profile;
    profile_step_ = step;
}

bool Scheduler::allow_ssd_load(std::size_t chunk_index) const {
    if (!profile_ || chunk_index >= profile_->chunk_stats.size()) {
        return true;
    }
    if (!config_.profile_immediate_evict) {
        return true;
    }
    return profile_->chunk_stats[chunk_index].first_use == profile_step_;
}

void Scheduler::on_tier_evicted(std::uint64_t key, TensorState fallback_state) {
    const VirtualTensorAddress address{key};
    const auto idx = vtas_.index_of(address);

    // Use VTAS offsets instead of cache.contains() — this callback runs inside
    // the evicting cache's locked section, so re-entering any cache mutex would
    // be undefined behavior on a non-recursive std::mutex.
    const bool in_ram = vtas_.ram_offset(address).has_value();
    const bool in_vram = vtas_.vram_offset(address).has_value();

    if (fallback_state == TensorState::RamReady) {
        // Page left VRAM — check if a RAM copy survives (set by demotion handler).
        vtas_.set_vram_offset(address, std::nullopt);
        if (in_ram) {
            vtas_.set_state(address, TensorState::RamReady);
        } else {
            vtas_.set_ram_offset(address, std::nullopt);
            vtas_.set_state(address, TensorState::SsdOnly);
        }
    } else {
        // Page left RAM — check if a VRAM copy survives.
        vtas_.set_ram_offset(address, std::nullopt);
        if (in_vram) {
            vtas_.set_state(address, TensorState::GpuReady);
        } else {
            vtas_.set_vram_offset(address, std::nullopt);
            vtas_.set_state(address, TensorState::SsdOnly);
        }
    }

    const bool resident = in_ram || in_vram;
    if (autopsy_ && idx && !resident) {
        autopsy_->on_eviction(*idx);
    }

    // Skip check_cache_invariants — it locks cache mutexes which are already held
    // by the caller (evict_one runs inside the cache's locked section).
}

void Scheduler::check_cache_invariants(const char* where) const {
    if (!config_.invariant_checks()) {
        return;
    }

    validate_tier_cache(ram_cache_, true, where);
    validate_tier_cache(vram_cache_, true, where);
    validate_residency_sync(vtas_, ram_cache_, vram_cache_, true, where);

    if (config_.paranoid_checks()) {
        validate_paranoid_system(vtas_, ram_cache_, vram_cache_, true, where);
    }
}

void Scheduler::validate_checkpoint(const char* where) const {
    check_cache_invariants(where);
}

void Scheduler::assert_ram_page_ready(VirtualTensorAddress address, const char* where) const {
    validate_page_ram_ready(vtas_, ram_cache_, key_for(address), config_.invariant_checks(), where);
}

void Scheduler::assert_page_not_in_cache(std::uint64_t key, const char* where) const {
    if (!config_.invariant_checks()) {
        return;
    }

    check_invariant(true, !ram_cache_.contains(key), where,
                    "page 0x" + std::to_string(key) + " unexpectedly in RAM cache before SSD load");
    check_invariant(true, !vram_cache_.contains(key), where,
                    "page 0x" + std::to_string(key) + " unexpectedly in VRAM cache before SSD load");
}

void Scheduler::enqueue_unique(Job job) {
    std::lock_guard lock(mutex_);
    jobs_.push(std::move(job));
    cv_.notify_one();
}

void Scheduler::drain_redundant_load_jobs() {
    std::lock_guard lock(mutex_);
    while (!jobs_.empty()) {
        const Job& front = jobs_.front();
        if (front.kind != JobKind::LoadRam) {
            break;
        }
        if (page_resident(key_for(front.address))) {
            jobs_.pop();
            continue;
        }
        break;
    }
}

bool Scheduler::demote_vram_page(VirtualTensorAddress address) {
    const std::uint64_t key = key_for(address);
    if (!vram_cache_.contains(key)) {
        return ram_cache_.contains(key);
    }

    if (ram_cache_.contains(key)) {
        debug_assert_single_copy(key);
        return false;
    }

    const std::size_t size = vram_cache_.size_of(key);
    const std::byte* data = vram_cache_.data_for_key(key);
    if (data == nullptr || size == 0) {
        return false;
    }

    demote_vram_to_ram(key, data, size);
    if (!ram_cache_.contains(key)) {
        return false;
    }

    vram_cache_.release(key);
    vtas_.set_vram_offset(address, std::nullopt);
    vtas_.set_state(address, TensorState::RamReady);
    debug_assert_single_copy(key);
    return true;
}

void Scheduler::demote_vram_to_ram(std::uint64_t key, const std::byte* data, std::size_t size) {
    if (data == nullptr || size == 0 || ram_cache_.contains(key)) {
        return;
    }

    const VirtualTensorAddress address{key};
    const auto idx = vtas_.index_of(address);

    if (!ram_cache_.ensure_free_space(size)) {
        return;
    }

    const auto slot = ram_cache_.allocate(key, size);
    if (!slot) {
        return;
    }

    std::vector<std::byte> staging(size);
    copy_tier_to_host(staging.data(), vram_cache_, data, size);
    std::byte* ram_dst = ram_cache_.data_for_key(key);
    const std::size_t ram_cap = ram_cache_.size_of(key);
    safe_memcpy(ram_dst, ram_cap, staging.data(), staging.size(), size, "Scheduler::demote_vram_to_ram");
    vtas_.set_ram_offset(address, slot);
    vtas_.set_state(address, TensorState::RamReady);

    if (autopsy_ && idx) {
        autopsy_->on_vram_leave(*idx);
        autopsy_->on_ram_enter(*idx);
    }

    if (config_.invariant_checks()) {
        check_cache_invariants("demote_vram_to_ram");
    }
}

bool Scheduler::process_load_ram(VirtualTensorAddress address) {
    std::lock_guard load_lock(load_mutex_);

    const auto* chunk = vtas_.chunk(address);
    if (!chunk) {
        return false;
    }

    const std::uint64_t key = key_for(address);

    const auto chunk_index = vtas_.index_of(address);
    if (chunk_index && !allow_ssd_load(*chunk_index) && !page_resident(key)) {
        return false;
    }

    if (ram_cache_.contains(key)) {
        vtas_.set_state(address, TensorState::RamReady);
        return true;
    }

    if (config_.single_copy_hierarchy && vram_cache_.contains(key)) {
        return demote_vram_page(address);
    }

    if (config_.single_copy_hierarchy && config_.debug_ssd_invariant) {
        assert(!page_resident(key) && "SSD load while page still resident");
    }

    const auto start_index = vtas_.index_of(address);
    if (!start_index) {
        return false;
    }

    // One page per load for stability; coalesce re-enabled once batch staging is safe.
    std::vector<std::size_t> run = {*start_index};
    if (run.empty()) {
        return false;
    }

    std::vector<std::size_t> to_load;
    to_load.reserve(run.size());
    for (const std::size_t index : run) {
        const auto addr = vtas_.address_at_index(index);
        if (!addr) {
            continue;
        }

        const std::uint64_t part_key = key_for(*addr);
        if (ram_cache_.contains(part_key)) {
            continue;
        }
        if (config_.single_copy_hierarchy && vram_cache_.contains(part_key)) {
            if (!demote_vram_page(*addr)) {
                return false;
            }
            continue;
        }
        if (config_.debug_ssd_invariant) {
            assert(!page_resident(part_key));
        }
        if (config_.invariant_checks()) {
            assert_page_not_in_cache(part_key, "process_load_ram:before_ssd");
        }
        if (!allow_ssd_load(index)) {
            continue;
        }
        to_load.push_back(index);
    }

    if (to_load.empty()) {
        vtas_.set_state(address, TensorState::RamReady);
        return true;
    }

    for (const std::size_t index : to_load) {
        const auto addr = vtas_.address_at_index(index);
        if (addr) {
            vtas_.set_state(*addr, TensorState::LoadingRam);
            if (config_.invariant_checks()) {
                check_invariant(true, !ram_cache_.contains(key_for(*addr)), "process_load_ram:LoadingRam",
                                "page entering LoadingRam while already in RAM cache");
            }
        }
    }

    const auto t0 = std::chrono::steady_clock::now();
    std::size_t bytes_read = 0;

    for (const std::size_t index : to_load) {
        const auto addr = vtas_.address_at_index(index);
        if (!addr) {
            return false;
        }
        const auto* part = vtas_.chunk(*addr);
        if (!part) {
            return false;
        }

        const std::uint64_t part_key = key_for(*addr);
        const std::size_t part_size = static_cast<std::size_t>(part->size);

        if (config_.system_memory_guard) {
            const bool hot = !load_priority_ || load_priority_->is_hot(index);
            SystemMemoryGuard::wait_before_host_growth(config_, part_size, ram_cache_.used(), hot);
        }

        if (!ram_cache_.ensure_free_space(part_size)) {
            vtas_.set_state(*addr, TensorState::Error);
            return false;
        }

        const auto slot = ram_cache_.allocate(part_key, part_size);
        if (!slot) {
            vtas_.set_state(*addr, TensorState::Error);
            return false;
        }

        if (load_staging_.size() < part_size) {
            load_staging_.resize(part_size);
        }

        if (!ssd_.read_into(part->file_offset, part_size, load_staging_.data())) {
            vtas_.set_state(*addr, TensorState::Error);
            return false;
        }

        if (!ram_cache_.store_into_key(part_key, 0, load_staging_.data(), part_size)) {
            vtas_.set_state(*addr, TensorState::Error);
            return false;
        }

        bytes_read += part_size;
        vtas_.set_ram_offset(*addr, slot);
        vtas_.set_state(*addr, TensorState::RamReady);
        debug_assert_single_copy(part_key);
        assert_ram_page_ready(*addr, "process_load_ram:after_store");
    }

    const auto t1 = std::chrono::steady_clock::now();
    metrics_.record_ssd_read(bytes_read, std::chrono::duration<double>(t1 - t0).count());
    metrics_.record_coalesced_read(static_cast<std::uint32_t>(to_load.size()));

    if (autopsy_) {
        for (const std::size_t index : to_load) {
            autopsy_->on_ssd_load(index);
            check_ssd_invariant(index);
            autopsy_->on_ram_enter(index);
        }
    }

    check_cache_invariants("process_load_ram");

    return true;
}

bool Scheduler::process_upload_gpu(VirtualTensorAddress address) {
    const auto* chunk = vtas_.chunk(address);
    if (!chunk) {
        return false;
    }

    const std::uint64_t key = key_for(address);
    if (vram_cache_.contains(key)) {
        vtas_.set_vram_offset(address, vram_cache_.offset_of(key));
        vtas_.set_state(address, TensorState::GpuReady);
        metrics_.record_cache_hit();
        debug_assert_single_copy(key);
        return true;
    }

    metrics_.record_cache_miss();

    if (!ram_cache_.contains(key)) {
        if (!process_load_ram(address)) {
            return false;
        }
    }

    if (!ram_cache_.contains(key)) {
        return false;
    }

    vtas_.set_state(address, TensorState::UploadingGpu);

    const auto t0 = std::chrono::steady_clock::now();
    const std::size_t size = static_cast<std::size_t>(chunk->size);
    const auto vram_slot = vram_cache_.allocate(key, size);
    if (!vram_slot) {
        vtas_.set_state(address, TensorState::Error);
        return false;
    }

    copy_host_to_tier(vram_cache_, vram_cache_.data_for_key(key), ram_cache_.data_for_key(key), size);

    if (config_.single_copy_hierarchy) {
        if (autopsy_) {
            const auto idx = vtas_.index_of(address);
            if (idx) {
                autopsy_->on_ram_leave(*idx);
            }
        }
        ram_cache_.release(key);
        vtas_.set_ram_offset(address, std::nullopt);
    }

    vtas_.set_vram_offset(address, vram_slot);
    vtas_.set_state(address, TensorState::GpuReady);

    if (autopsy_) {
        const auto idx = vtas_.index_of(address);
        if (idx) {
            autopsy_->on_vram_enter(*idx);
        }
    }

    debug_assert_single_copy(key);

    const auto t1 = std::chrono::steady_clock::now();
    metrics_.record_ram_to_vram(size, std::chrono::duration<double>(t1 - t0).count());
    check_cache_invariants("process_upload_gpu");
    return true;
}

bool Scheduler::ensure_ram_ready(VirtualTensorAddress address) {
    return process_load_ram(address);
}

bool Scheduler::ensure_gpu_ready(VirtualTensorAddress address) {
    const auto t0 = std::chrono::steady_clock::now();

    const std::uint64_t key = key_for(address);
    if (vram_cache_.contains(key)) {
        vtas_.set_vram_offset(address, vram_cache_.offset_of(key));
        vtas_.set_state(address, TensorState::GpuReady);
        metrics_.record_cache_hit();
        return true;
    }

    if (!process_upload_gpu(address)) {
        return false;
    }

    const auto t1 = std::chrono::steady_clock::now();
    metrics_.record_gpu_wait(std::chrono::duration<double>(t1 - t0).count());
    return true;
}

void Scheduler::prefetch_ahead(VirtualTensorAddress current) {
    const auto current_index = vtas_.index_of(current);
    if (!current_index) {
        return;
    }

    for (std::uint32_t step = 1; step <= config_.prefetch_window; ++step) {
        const std::size_t next = *current_index + step;
        const auto addr = vtas_.address_at_index(next);
        if (!addr) {
            break;
        }

        const std::uint64_t key = key_for(*addr);
        if (vram_cache_.contains(key)) {
            continue;
        }
        if (!page_resident(key)) {
            enqueue_unique(Job{*addr, JobKind::LoadRam});
        }
        enqueue_unique(Job{*addr, JobKind::UploadGpu});
    }
}

void Scheduler::prefetch_profile(const std::vector<std::size_t>& forward_order, std::size_t step) {
    for (std::uint32_t ahead = 1; ahead <= config_.prefetch_window; ++ahead) {
        const std::size_t next_step = step + ahead;
        if (next_step >= forward_order.size()) {
            break;
        }

        const std::size_t chunk_index = forward_order[next_step];
        const auto addr = vtas_.address_at_index(chunk_index);
        if (!addr) {
            continue;
        }

        const std::uint64_t key = key_for(*addr);
        if (vram_cache_.contains(key)) {
            continue;
        }
        if (!page_resident(key)) {
            enqueue_unique(Job{*addr, JobKind::LoadRam});
        }
        enqueue_unique(Job{*addr, JobKind::UploadGpu});
    }
}

void Scheduler::worker_loop() {
    while (!stop_requested_) {
        Job job;
        {
            std::unique_lock lock(mutex_);
            cv_.wait(lock, [this] { return stop_requested_ || !jobs_.empty(); });
            if (stop_requested_ && jobs_.empty()) {
                break;
            }
            if (jobs_.empty()) {
                continue;
            }
            job = jobs_.front();
            jobs_.pop();
        }

        std::unique_lock<std::mutex> sync_lock;
        if (sync_mutex_) {
            sync_lock = std::unique_lock<std::mutex>(*sync_mutex_);
        }

        if (job.kind == JobKind::LoadRam) {
            process_load_ram(job.address);
            drain_redundant_load_jobs();
        } else {
            process_upload_gpu(job.address);
        }
    }
}

}  // namespace ws
