#pragma once

#include "WeightStream/ByteStore.h"
#include "WeightStream/Config.h"
#include "WeightStream/GGUFReader.h"
#include "WeightStream/Metrics.h"
#include "WeightStream/PageAutopsy.h"
#include "WeightStream/Profile.h"
#include "WeightStream/Scheduler.h"
#include "WeightStream/SSDReader.h"
#include "WeightStream/TensorIndex.h"
#include "WeightStream/TierCache.h"
#include "WeightStream/Types.h"
#include "WeightStream/VTAS.h"

#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

namespace ws {

/// Virtual Tensor Memory Manager — public façade.
class VTMM : public ByteStore {
public:
    explicit VTMM(Config config = {});
    ~VTMM();

    VTMM(const VTMM&) = delete;
    VTMM& operator=(const VTMM&) = delete;

    bool load_model(const std::filesystem::path& gguf_path);
    void shutdown();

    /// Absolute file offset read for external loaders (llama.cpp I/O hook).
    bool read_at(std::uint64_t file_offset, void* dst, std::size_t size) override;

    PageHandle get_page(VirtualPageAddress address);
    PageHandle get_page_by_index(std::size_t index);

    TensorHandle get_tensor(VirtualTensorAddress address);
    TensorHandle get_tensor_by_index(std::size_t index);
    TensorHandle get_tensor_by_name(const std::string& name);

    void prefetch(VirtualPageAddress address);
    void release(VirtualPageAddress address);

    std::size_t chunk_count() const;
    LayoutMode layout_mode() const { return vtas_.layout_mode(); }

    /// Sequence to iterate in replay/profile mode, else linear 0..N-1.
    std::vector<std::size_t> access_sequence() const;

    /// Build forward_order from tensor layer names (no execution needed).
    bool build_inference_profile();

    /// Finalize recording, analyze, optionally save .wsprofile.
    bool finalize_profile(const std::filesystem::path& save_path = {});

    bool load_profile(const std::filesystem::path& path);
    bool write_autopsy_reports(const std::filesystem::path& output_prefix) const;

    const WSProfile* profile() const { return profile_.has_value() ? &*profile_ : nullptr; }
    const ProfileRecorder& recorder() const { return recorder_; }
    const PageAutopsyCollector& autopsy() const { return autopsy_; }

    const VTAS& vtas() const { return vtas_; }
    const TensorIndex& tensor_index() const { return index_; }
    std::uint64_t model_data_offset() const { return reader_ ? reader_->data_offset() : 0; }
    const Metrics& metrics() const { return metrics_; }
    const Config& config() const { return config_; }
    Config& mutable_config() { return config_; }

    std::size_t ram_cache_used() const { return ram_cache_.used(); }
    std::size_t ram_cache_capacity() const { return ram_cache_.capacity(); }

    /// Pre-load priority pages (embed, GPU layers, output) into RAM before llama load.
    bool warm_priority_pages();

    /// Reset profile replay step for another synthetic forward pass (multi-token smoke).
    void reset_forward_pass();

    bool loaded() const { return loaded_; }
    const std::string& last_error() const { return last_error_; }

private:
    PageHandle get_page_locked(VirtualPageAddress address, std::size_t chunk_index);
    PageHandle make_page_handle(VirtualPageAddress address);
    TensorHandle make_tensor_handle(VirtualPageAddress address);
    void evict_completed_profile_steps(std::size_t step);
    void update_pin_policy();
    void setup_cache_policies();
    void record_working_set_snapshot();

    Config config_;
    bool loaded_ = false;
    std::string last_error_;
    std::filesystem::path model_path_;
    std::uint64_t file_size_ = 0;

    TensorIndex index_;
    VTAS vtas_;
    std::unique_ptr<GGUFReader> reader_;
    std::unique_ptr<SSDReader> ssd_;
    TierCache ram_cache_;
    TierCache vram_cache_;
    Metrics metrics_;
    std::unique_ptr<Scheduler> scheduler_;
    std::mutex mutex_;

    ProfileRecorder recorder_;
    Planner planner_;
    PageAutopsyCollector autopsy_;
    std::optional<WSProfile> profile_;
    std::size_t profile_step_ = 0;
    std::vector<std::size_t> linear_sequence_;
    LoadPriorityPlan load_priority_;
};

}  // namespace ws
