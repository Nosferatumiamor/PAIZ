#pragma once

#include "WeightStream/TensorIndex.h"
#include "WeightStream/Types.h"

#include <cstdint>
#include <mutex>
#include <optional>
#include <unordered_map>
#include <vector>

namespace ws {

/// Virtual Tensor Address Space — maps stable virtual addresses to chunks (tensors or pages).
class VTAS {
public:
    void register_tensors(const TensorIndex& index, std::uint64_t data_section_offset);
    void build_pages(std::uint64_t data_section_offset, std::uint64_t data_section_size, std::size_t page_size);

    LayoutMode layout_mode() const { return mode_; }
    std::size_t chunk_count() const;
    std::size_t tensor_count() const { return chunk_count(); }

    const ChunkDescriptor* chunk(VirtualTensorAddress address) const;
    const TensorDescriptor* descriptor(VirtualTensorAddress address) const;

    std::optional<VirtualTensorAddress> address_at_index(std::size_t index) const;
    std::optional<std::size_t> index_of(VirtualTensorAddress address) const;

    TensorState state(VirtualTensorAddress address) const;
    void set_state(VirtualTensorAddress address, TensorState state);

    std::optional<std::size_t> ram_offset(VirtualTensorAddress address) const;
    void set_ram_offset(VirtualTensorAddress address, std::optional<std::size_t> offset);

    std::optional<std::size_t> vram_offset(VirtualTensorAddress address) const;
    void set_vram_offset(VirtualTensorAddress address, std::optional<std::size_t> offset);

    const std::vector<VirtualTensorAddress>& addresses_in_order() const { return order_; }

    /// Disk-contiguous chunk indices starting at `start_index`, total size <= max_bytes.
    std::vector<std::size_t> coalesce_run_from(std::size_t start_index, std::size_t max_bytes) const;

private:
    struct Entry {
        ChunkDescriptor descriptor;
        TensorState state = TensorState::SsdOnly;
        std::optional<std::size_t> ram_offset;
        std::optional<std::size_t> vram_offset;
        std::size_t chunk_index = 0;
    };

    void clear_locked();

    mutable std::mutex mutex_;
    LayoutMode mode_ = LayoutMode::Tensors;
    std::unordered_map<VirtualTensorAddress, Entry> entries_;
    std::vector<VirtualTensorAddress> order_;
    std::uint64_t next_address_ = 1;
};

}  // namespace ws
