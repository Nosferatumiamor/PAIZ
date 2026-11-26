#include "WeightStream/VTMM.h"

#include "WeightStream/SafeMemcpy.h"
#include "WeightStream/SystemMemoryGuard.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <iostream>

namespace ws {

namespace {

MemoryKind vram_memory_kind(const Config& config) {
#ifdef WEIGHTSTREAM_HAS_CUDA
    if (config.cuda_vram) {
        return MemoryKind::Device;
    }
#else
    (void)config;
#endif
    return MemoryKind::Host;
}

}  // namespace

VTMM::VTMM(Config config)
    : config_(std::move(config)),
      ram_cache_(config_.ram_capacity, MemoryKind::Host),
      vram_cache_(config_.vram_capacity, vram_memory_kind(config_)) {}

VTMM::~VTMM() {
    shutdown();
}

bool VTMM::load_model(const std::filesystem::path& gguf_path) {
    std::lock_guard lock(mutex_);

    shutdown();

    model_path_ = gguf_path;
    reader_ = std::make_unique<GGUFReader>(gguf_path);
    if (!reader_->valid()) {
        last_error_ = reader_->error();
        return false;
    }

    index_.build_from_gguf(*reader_);

    const auto file_size = std::filesystem::file_size(gguf_path);
    file_size_ = file_size;
    const auto data_offset = reader_->data_offset();
    const auto data_size = file_size - data_offset;

    if (config_.paged_mode()) {
        vtas_.build_pages(data_offset, data_size, config_.page_size);
    } else {
        vtas_.register_tensors(index_, data_offset);
    }

    linear_sequence_.resize(chunk_count());
    for (std::size_t i = 0; i < linear_sequence_.size(); ++i) {
        linear_sequence_[i] = i;
    }

    profile_step_ = 0;
    recorder_.reset();
    profile_.reset();

    if (config_.profile_mode == ProfileMode::Record) {
        recorder_.reset();
    }

    ram_cache_.clear();
    vram_cache_.clear();

    if (config_.system_memory_guard) {
        if (config_.system_memory_guard_mode == SystemMemoryGuardMode::Off) {
            config_.system_memory_guard_mode = SystemMemoryGuardMode::Auto;
        }
        if (config_.system_memory_baseline_avail == 0) {
            config_.system_memory_baseline_avail = SystemMemoryGuard::query().avail_bytes;
        }
        const auto capped = SystemMemoryGuard::cap_cache_budget(config_.ram_capacity, config_);
        if (capped < ram_cache_.capacity()) {
            ram_cache_.set_capacity(capped);
            if (config_.verbose) {
                std::cerr << "[WeightStream] RAM cache capped to " << (capped / (1024 * 1024))
                          << " MiB (system memory guard)\n";
            }
        }
    }
    ram_cache_.set_memory_guard_config(&config_);

    autopsy_.reset(vtas_.chunk_count());

    ssd_ = std::make_unique<SSDReader>(GGUFReader(gguf_path));
    metrics_.reset();
    scheduler_ = std::make_unique<Scheduler>(config_, vtas_, ram_cache_, vram_cache_, *ssd_, metrics_);
    scheduler_->set_sync_mutex(&mutex_);
    scheduler_->set_autopsy(&autopsy_);
    scheduler_->set_profile_guidance(
        profile_.has_value() ? &*profile_ : nullptr, profile_step_);
    ram_cache_.set_invariants_enabled(config_.invariant_checks());
    vram_cache_.set_invariants_enabled(config_.invariant_checks());
    if (config_.paranoid_checks() && config_.verbose) {
        std::cerr << "[WeightStream] DEBUG_PARANOID: full page-lifecycle checks after each operation\n";
    }
    if (config_.background_scheduler) {
        scheduler_->start();
    }
    setup_cache_policies();

    load_priority_ = LoadPriorityPlan{};
    if (config_.paged_mode() && config_.load_priority_ngl > 0) {
        load_priority_ = LoadPriorityPlan::build(index_, config_.load_priority_ngl, config_.page_size);
        scheduler_->set_load_priority(&load_priority_);
        ram_cache_.set_page_hot_fn([this](std::uint64_t key) {
            if (!load_priority_.enabled()) {
                return true;
            }
            const auto idx = vtas_.index_of(VirtualPageAddress{key});
            return idx.has_value() && load_priority_.is_hot(*idx);
        });
        if (config_.verbose && load_priority_.enabled()) {
            std::cerr << "[WeightStream] Load priority: " << load_priority_.hot_page_count() << " hot / "
                      << chunk_count() << " pages (-ngl " << config_.load_priority_ngl << ")\n";
        }
    }

    loaded_ = true;
    last_error_.clear();

    if (config_.verbose) {
        const char* mode = config_.paged_mode() ? "pages" : "tensors";
        std::cerr << "[WeightStream] Loaded " << chunk_count() << ' ' << mode << ", payload "
                  << (data_size / (1024 * 1024)) << " MiB\n";
        if (config_.paged_mode()) {
            std::cerr << "[WeightStream] Page size: " << (config_.page_size / (1024 * 1024)) << " MiB\n";
        }
        std::cerr << "[WeightStream] RAM cache: " << (config_.ram_capacity / (1024 * 1024)) << " MiB, VRAM cache: "
                  << (config_.vram_capacity / (1024 * 1024)) << " MiB"
                  << (vram_cache_.is_device() ? " (CUDA device)" : " (host simulated)")
                  << ", prefetch window: "
                  << config_.prefetch_window << '\n';
    }

    return true;
}

void VTMM::shutdown() {
    if (scheduler_) {
        scheduler_->stop();
        scheduler_.reset();
    }
    reader_.reset();
    ssd_.reset();
    loaded_ = false;
}

bool VTMM::read_at(std::uint64_t file_offset, void* dst, std::size_t size) {
    if (!loaded_ || !ssd_ || dst == nullptr || size == 0) {
        return false;
    }

    std::lock_guard lock(mutex_);

    if (file_offset + size > file_size_) {
        last_error_ = "read_at out of range";
        return false;
    }

    const bool use_pages =
        config_.read_at_page_cache && config_.paged_mode() && scheduler_ != nullptr;

    if (!use_pages) {
        const auto wall_t0 = std::chrono::steady_clock::now();
        std::vector<std::byte> payload;
        if (!ssd_->read_bytes(file_offset, size, payload)) {
            last_error_ = "read_at direct SSD failed at " + std::to_string(file_offset);
            return false;
        }
        safe_memcpy(dst, size, payload.data(), payload.size(), size, "VTMM::read_at:ssd");
        const double wall_seconds =
            std::chrono::duration<double>(std::chrono::steady_clock::now() - wall_t0).count();
        metrics_.record_ssd_read(size, wall_seconds);
        metrics_.record_read_at(size, wall_seconds, 0.0, false);
        record_working_set_snapshot();
        return true;
    }

    const auto wall_t0 = std::chrono::steady_clock::now();
    auto* out = static_cast<std::byte*>(dst);
    std::size_t remaining = size;
    std::uint64_t pos = file_offset;
    double memcpy_seconds = 0.0;
    bool all_page_hits = true;

    const auto data_offset = reader_->data_offset();

    while (remaining > 0) {
        if (pos < data_offset) {
            const std::size_t until_data =
                (pos < data_offset) ? static_cast<std::size_t>(data_offset - pos) : remaining;
            const std::size_t chunk = std::min(remaining, until_data);
            all_page_hits = false;

            std::vector<std::byte> payload;
            const auto io_t0 = std::chrono::steady_clock::now();
            if (!ssd_->read_bytes(pos, chunk, payload)) {
                last_error_ = "read_at direct SSD failed at " + std::to_string(pos);
                return false;
            }
            metrics_.record_ssd_read(chunk,
                                     std::chrono::duration<double>(std::chrono::steady_clock::now() - io_t0).count());

            const auto cp_t0 = std::chrono::steady_clock::now();
            safe_memcpy(out, remaining, payload.data(), payload.size(), chunk, "VTMM::read_at:header");
            memcpy_seconds += std::chrono::duration<double>(std::chrono::steady_clock::now() - cp_t0).count();

            out += chunk;
            pos += chunk;
            remaining -= chunk;
            continue;
        }

        const auto rel = pos - data_offset;
        const auto page_idx = static_cast<std::size_t>(rel / config_.page_size);
        const auto in_page = static_cast<std::size_t>(rel % config_.page_size);

        VirtualPageAddress address{};
        std::size_t page_bytes = 0;
        bool page_hit = false;
        {
            const auto addr = vtas_.address_at_index(page_idx);
            const auto* chunk = addr ? vtas_.chunk(*addr) : nullptr;
            if (!addr || chunk == nullptr) {
                last_error_ = "read_at invalid page index " + std::to_string(page_idx);
                return false;
            }
            address = *addr;
            page_bytes = static_cast<std::size_t>(chunk->size);
            if (in_page >= page_bytes) {
                last_error_ = "read_at in-page offset past chunk end";
                return false;
            }
            page_hit = ram_cache_.contains(address.value);
            if (!page_hit) {
                all_page_hits = false;
            }
        }

        if (!scheduler_->ensure_ram_ready(address)) {
            last_error_ = "read_at ensure_ram_ready failed for page " + std::to_string(page_idx);
            return false;
        }

        const std::size_t chunk_len = std::min(remaining, page_bytes - in_page);
        {
            const auto cp_t0 = std::chrono::steady_clock::now();
            if (!ram_cache_.copy_from_key(address.value, in_page, out, chunk_len)) {
                last_error_ = "read_at missing RAM for page " + std::to_string(page_idx);
                return false;
            }
            memcpy_seconds += std::chrono::duration<double>(std::chrono::steady_clock::now() - cp_t0).count();
        }

        out += chunk_len;
        pos += chunk_len;
        remaining -= chunk_len;
        (void)page_hit;

        if (config_.paranoid_checks() && scheduler_) {
            scheduler_->validate_checkpoint("read_at:page");
        }
    }

    const double wall_seconds =
        std::chrono::duration<double>(std::chrono::steady_clock::now() - wall_t0).count();
    metrics_.record_read_at(size, wall_seconds, memcpy_seconds, all_page_hits);

    record_working_set_snapshot();
    if (config_.paranoid_checks() && scheduler_) {
        scheduler_->validate_checkpoint("read_at");
    }
    return true;
}

std::size_t VTMM::chunk_count() const {
    return vtas_.chunk_count();
}

bool VTMM::warm_priority_pages() {
    if (!loaded_ || !scheduler_ || !load_priority_.enabled()) {
        return true;
    }

    std::lock_guard lock(mutex_);
    const auto& pages = load_priority_.hot_chunks_in_order();
    if (config_.verbose) {
        std::cerr << "[WeightStream] Warming " << pages.size() << " priority pages…\n";
    }

    for (const std::size_t page_idx : pages) {
        const auto addr = vtas_.address_at_index(page_idx);
        if (!addr) {
            last_error_ = "warm_priority_pages: invalid page index";
            return false;
        }
        if (!scheduler_->ensure_ram_ready(*addr)) {
            last_error_ = "warm_priority_pages failed at page " + std::to_string(page_idx);
            return false;
        }
    }

    if (config_.verbose) {
        std::cerr << "[WeightStream] Priority pages ready in RAM\n";
    }
    return true;
}

void VTMM::reset_forward_pass() {
    std::lock_guard lock(mutex_);
    profile_step_ = 0;
    if (scheduler_) {
        scheduler_->set_profile_guidance(profile_.has_value() ? &*profile_ : nullptr, profile_step_);
    }
    setup_cache_policies();
}

std::vector<std::size_t> VTMM::access_sequence() const {
    if (profile_.has_value() && config_.profile_mode == ProfileMode::Replay &&
        !profile_->forward_order.empty()) {
        return profile_->forward_order;
    }
    return linear_sequence_;
}

bool VTMM::build_inference_profile() {
    std::lock_guard lock(mutex_);
    if (!reader_ || !config_.paged_mode()) {
        last_error_ = "inference profile requires paged mode";
        return false;
    }

    const auto file_size = std::filesystem::file_size(model_path_);
    const auto data_size = file_size - reader_->data_offset();

    WSProfile profile;
    profile.model_name = model_path_.filename().string();
    profile.page_size = config_.page_size;
    profile.chunk_count = chunk_count();
    profile.passes_recorded = 1;
    profile.forward_order = InferenceOrder::build_forward_pages(
        index_, reader_->data_offset(), data_size, config_.page_size);
    profile.chunk_stats.resize(chunk_count());
    profile.analyze(static_cast<std::uint32_t>(profile.forward_order.size()));

    profile_ = std::move(profile);
    config_.profile_mode = ProfileMode::Replay;
    profile_step_ = 0;
    planner_.set_profile(&*profile_);
    update_pin_policy();
    if (scheduler_) {
        scheduler_->set_profile_guidance(&*profile_, profile_step_);
    }

    if (config_.verbose) {
        std::cerr << "[WeightStream] Inference profile: " << profile_->forward_order.size()
                  << " steps (" << planner_.execution_order().size() << " unique pages)\n";
    }

    if (!profile_->forward_order.empty()) {
        last_error_.clear();
    } else {
        last_error_ = "inference profile produced empty forward order";
    }

    return !profile_->forward_order.empty();
}

bool VTMM::finalize_profile(const std::filesystem::path& save_path) {
    std::lock_guard lock(mutex_);
    if (config_.profile_mode != ProfileMode::Record) {
        last_error_ = "not in record mode";
        return false;
    }

    profile_ = recorder_.build_profile(model_path_.filename().string(), config_.page_size, chunk_count());

    if (!save_path.empty()) {
        if (!profile_->save(save_path)) {
            last_error_ = "failed to save profile";
            return false;
        }
        if (config_.verbose) {
            std::cerr << "[WeightStream] Profile saved: " << save_path << '\n';
        }
    }

    return true;
}

bool VTMM::load_profile(const std::filesystem::path& path) {
    std::lock_guard lock(mutex_);
    WSProfile profile;
    if (!profile.load(path)) {
        last_error_ = "failed to load profile: " + path.string();
        return false;
    }

    if (profile.chunk_count != chunk_count()) {
        last_error_ = "profile chunk_count mismatch";
        return false;
    }

    profile_ = std::move(profile);
    config_.profile_mode = ProfileMode::Replay;
    profile_step_ = 0;
    planner_.set_profile(&*profile_);
    update_pin_policy();

    if (config_.verbose) {
        std::cerr << "[WeightStream] Loaded profile: " << path << " ("
                  << planner_.execution_order().size() << " unique pages, "
                  << profile_->forward_order.size() << " raw steps)\n";
    }

    return true;
}

PageHandle VTMM::get_page(VirtualPageAddress address) {
    std::lock_guard lock(mutex_);
    const auto index = vtas_.index_of(address);
    if (!index) {
        return {};
    }
    return get_page_locked(address, *index);
}

PageHandle VTMM::get_page_by_index(std::size_t index) {
    std::lock_guard lock(mutex_);
    const auto address = vtas_.address_at_index(index);
    if (!address) {
        return {};
    }
    return get_page_locked(*address, index);
}

PageHandle VTMM::get_page_locked(VirtualPageAddress address, std::size_t chunk_index) {
    if (!loaded_ || !scheduler_) {
        return {};
    }

    update_pin_policy();
    scheduler_->set_profile_guidance(
        profile_.has_value() ? &*profile_ : nullptr, profile_step_);

    const bool vram_hit = vram_cache_.contains(address.value);

    if (config_.profile_mode == ProfileMode::Record) {
        recorder_.record(chunk_index);
    }

    autopsy_.on_access(chunk_index, profile_step_, vram_hit);

    if (!scheduler_->ensure_gpu_ready(address)) {
        last_error_ = "failed to load chunk at address 0x" + std::to_string(address.value);
        return {};
    }

    if (profile_.has_value() && config_.profile_mode == ProfileMode::Replay) {
        scheduler_->prefetch_profile(planner_.prefetch_order(), profile_step_);
    } else {
        scheduler_->prefetch_ahead(address);
    }

    const auto handle = make_page_handle(address);

    if (profile_.has_value() && config_.profile_mode == ProfileMode::Replay && config_.profile_immediate_evict) {
        evict_completed_profile_steps(profile_step_);
    }

    if (profile_.has_value() && config_.profile_mode == ProfileMode::Replay) {
        ++profile_step_;
        if (scheduler_) {
            scheduler_->set_profile_guidance(&*profile_, profile_step_);
        }
    }

    record_working_set_snapshot();

    return handle;
}

void VTMM::record_working_set_snapshot() {
    metrics_.record_working_set(ram_cache_.used(),
                                 vram_cache_.used(),
                                 ram_cache_.entry_count(),
                                 vram_cache_.entry_count());
}

void VTMM::setup_cache_policies() {
    if (config_.single_copy_hierarchy && scheduler_) {
        vram_cache_.set_demotion_handler([this](std::uint64_t key, const std::byte* data, std::size_t size) {
            scheduler_->demote_vram_to_ram(key, data, size);
        });
        vram_cache_.set_evict_notify([this](std::uint64_t key) {
            scheduler_->on_tier_evicted(key, TensorState::RamReady);
        });
        ram_cache_.set_demotion_handler(nullptr);
        ram_cache_.set_evict_notify([this](std::uint64_t key) {
            scheduler_->on_tier_evicted(key, TensorState::SsdOnly);
        });
    } else {
        vram_cache_.set_demotion_handler(nullptr);
        vram_cache_.set_evict_notify(nullptr);
        ram_cache_.set_evict_notify(nullptr);
    }

    if (profile_.has_value() && config_.profile_mode == ProfileMode::Replay) {
        const std::size_t step = profile_step_;
        auto priority_fn = [this, step](std::uint64_t key) -> std::uint64_t {
            const VirtualTensorAddress addr{key};
            const auto idx = vtas_.index_of(addr);
            if (!idx) {
                return 0;
            }
            return planner_.next_access_after(*idx, step);
        };
        auto profile_pin_fn = [this, step](std::uint64_t key) -> bool {
            const VirtualTensorAddress addr{key};
            const auto idx = vtas_.index_of(addr);
            if (!idx || !profile_) {
                return false;
            }
            if (*idx >= profile_->last_forward_step.size()) {
                return false;
            }
            return profile_->last_forward_step[*idx] >= step;
        };

        ram_cache_.set_eviction_priority(priority_fn);
        ram_cache_.set_pin_predicate([this, profile_pin_fn](std::uint64_t key) -> bool {
            const VirtualTensorAddress addr{key};
            const auto st = vtas_.state(addr);
            if (st == TensorState::LoadingRam || st == TensorState::UploadingGpu ||
                st == TensorState::Evicting || st == TensorState::InUse) {
                return true;
            }
            if (!config_.profile_pin_future_pages) {
                return false;
            }
            return profile_pin_fn(key);
        });
    } else {
        ram_cache_.set_eviction_priority(nullptr);
        ram_cache_.set_pin_predicate([this](std::uint64_t key) -> bool {
            const VirtualTensorAddress addr{key};
            const auto st = vtas_.state(addr);
            return st == TensorState::LoadingRam || st == TensorState::UploadingGpu ||
                   st == TensorState::Evicting || st == TensorState::InUse;
        });
    }

    vram_cache_.set_pin_predicate(nullptr);
    vram_cache_.set_eviction_priority(nullptr);
}

void VTMM::update_pin_policy() {
    setup_cache_policies();
}

bool VTMM::write_autopsy_reports(const std::filesystem::path& output_prefix) const {
    const auto txt = output_prefix.string() + ".txt";
    const auto html = output_prefix.string() + ".html";
    return autopsy_.write_text_report(txt) && autopsy_.write_html_report(html);
}

void VTMM::evict_completed_profile_steps(std::size_t step) {
    if (!profile_.has_value()) {
        return;
    }

    const auto& order = profile_->forward_order;
    const auto& last_step = profile_->last_forward_step;

    for (std::size_t chunk = 0; chunk < last_step.size(); ++chunk) {
        if (chunk < profile_->chunk_stats.size() &&
            profile_->chunk_stats[chunk].first_use > step) {
            continue;
        }

        if (last_step[chunk] > step) {
            continue;
        }

        // Keep pages reused later in the forward pass.
        bool needed_again = false;
        for (std::size_t future = step + 1; future < order.size(); ++future) {
            if (order[future] == chunk) {
                needed_again = true;
                break;
            }
        }
        if (needed_again) {
            continue;
        }

        const auto addr = vtas_.address_at_index(chunk);
        if (!addr) {
            continue;
        }

        const std::uint64_t key = addr->value;
        if (!vram_cache_.contains(key) && !ram_cache_.contains(key)) {
            continue;
        }

        vram_cache_.release(key);
        ram_cache_.release(key);
        autopsy_.on_eviction(chunk);
        vtas_.set_vram_offset(*addr, std::nullopt);
        vtas_.set_ram_offset(*addr, std::nullopt);
        vtas_.set_state(*addr, TensorState::SsdOnly);
    }
}

TensorHandle VTMM::get_tensor(VirtualTensorAddress address) {
    if (layout_mode() != LayoutMode::Tensors) {
        last_error_ = "get_tensor() requires tensor mode (page_size=0)";
        return {};
    }
    const auto page = get_page(address);
    return make_tensor_handle(page.address);
}

TensorHandle VTMM::get_tensor_by_index(std::size_t index) {
    if (layout_mode() != LayoutMode::Tensors) {
        last_error_ = "get_tensor_by_index() requires tensor mode (page_size=0)";
        return {};
    }
    const auto page = get_page_by_index(index);
    return make_tensor_handle(page.address);
}

TensorHandle VTMM::get_tensor_by_name(const std::string& name) {
    if (layout_mode() != LayoutMode::Tensors) {
        last_error_ = "get_tensor_by_name() requires tensor mode (page_size=0)";
        return {};
    }
    const auto idx = index_.index_of(name);
    if (!idx) {
        return {};
    }
    return get_tensor_by_index(*idx);
}

void VTMM::prefetch(VirtualPageAddress address) {
    std::lock_guard lock(mutex_);
    if (!scheduler_) {
        return;
    }
    if (profile_.has_value() && config_.profile_mode == ProfileMode::Replay) {
        scheduler_->prefetch_profile(planner_.prefetch_order(), profile_step_);
    } else {
        scheduler_->prefetch_ahead(address);
    }
}

void VTMM::release(VirtualPageAddress address) {
    std::lock_guard lock(mutex_);
    const std::uint64_t key = address.value;
    vram_cache_.release(key);
    ram_cache_.release(key);
    vtas_.set_vram_offset(address, std::nullopt);
    vtas_.set_ram_offset(address, std::nullopt);
    vtas_.set_state(address, TensorState::SsdOnly);
}

PageHandle VTMM::make_page_handle(VirtualPageAddress address) {
    PageHandle handle;
    handle.address = address;
    handle.state = vtas_.state(address);

    const auto* chunk = vtas_.chunk(address);
    if (!chunk) {
        return handle;
    }

    handle.size = static_cast<std::size_t>(chunk->size);
    handle.data = vram_cache_.data_for_key(address.value);
    if (handle.data != nullptr) {
        handle.state = TensorState::GpuReady;
    }

    return handle;
}

TensorHandle VTMM::make_tensor_handle(VirtualPageAddress address) {
    const auto page = make_page_handle(address);
    TensorHandle handle;
    handle.address = page.address;
    handle.data = page.data;
    handle.size = page.size;
    handle.state = page.state;
    return handle;
}

}  // namespace ws
