#pragma once

#include "WeightStream/Config.h"

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace ws {

/// Per-chunk statistics derived from an access trace (PGO-style).
struct ChunkUsage {
    std::size_t chunk_index = 0;
    std::uint32_t first_use = 0;  // step in trace
    std::uint32_t last_use = 0;
    std::uint32_t access_count = 0;
    bool reused_within_pass = false;
};

/// WeightStream profile (.wsprofile) — learned access pattern for a model.
struct WSProfile {
    static constexpr const char* kMagic = "wsprofile/1.0";

    std::string model_name;
    std::size_t page_size = 0;
    std::size_t chunk_count = 0;
    std::uint32_t passes_recorded = 0;

    /// Raw trace: chunk index at each GetPage() call.
    std::vector<std::size_t> access_trace;

    /// Aggregated stats per chunk (size = chunk_count).
    std::vector<ChunkUsage> chunk_stats;

    /// Deduplicated order for one forward pass (inference or first pass).
    std::vector<std::size_t> forward_order;

    /// Last step in forward_order where each chunk appears.
    std::vector<std::size_t> last_forward_step;

    bool save(const std::filesystem::path& path) const;
    bool load(const std::filesystem::path& path);

    /// Build stats + forward_order from access_trace.
    void analyze(std::uint32_t pass_length = 0);
};

/// Records GetPage() accesses during execution.
class ProfileRecorder {
public:
    void reset();
    void record(std::size_t chunk_index);

    const std::vector<std::size_t>& trace() const { return trace_; }
    std::uint32_t step() const { return static_cast<std::uint32_t>(trace_.size()); }

    WSProfile build_profile(const std::string& model_name,
                            std::size_t page_size,
                            std::size_t chunk_count) const;

private:
    std::vector<std::size_t> trace_;
};

/// Build a layer-by-layer forward pass page order from GGUF tensor names.
class InferenceOrder {
public:
    /// Map tensors to page indices and return ordered unique page list.
    static std::vector<std::size_t> build_forward_pages(const class TensorIndex& index,
                                                        std::uint64_t data_section_offset,
                                                        std::uint64_t data_section_size,
                                                        std::size_t page_size);
};

/// HOT/WARM page classification for staged model load (embed + GPU layers + output first).
class LoadPriorityPlan {
public:
    static LoadPriorityPlan build(const TensorIndex& index, int n_gpu_layers, std::size_t page_size);

    bool enabled() const { return enabled_; }
    bool is_hot(std::size_t chunk_index) const;
    std::size_t hot_page_count() const;
    const std::vector<std::size_t>& hot_chunks_in_order() const { return hot_order_; }

private:
    bool enabled_ = false;
    std::vector<bool> hot_;
    std::vector<std::size_t> hot_order_;
};

}  // namespace ws
