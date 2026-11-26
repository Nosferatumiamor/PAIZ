#include "WeightStream/VTAS.h"

#include <algorithm>

namespace ws {

void VTAS::clear_locked() {
    entries_.clear();
    order_.clear();
    next_address_ = 1;
}

void VTAS::register_tensors(const TensorIndex& index, std::uint64_t data_section_offset) {
    std::lock_guard lock(mutex_);
    clear_locked();
    mode_ = LayoutMode::Tensors;

    for (std::size_t i = 0; i < index.size(); ++i) {
        const TensorInfo* info = index.find_by_index(i);
        if (!info) {
            continue;
        }

        VirtualTensorAddress address{next_address_++};
        Entry entry;
        entry.descriptor.address = address;
        entry.descriptor.name = info->name;
        entry.descriptor.size = info->size;
        entry.descriptor.type = info->type;
        entry.descriptor.file_offset = data_section_offset + info->offset;
        entry.state = TensorState::SsdOnly;
        entry.chunk_index = i;

        entries_.emplace(address, std::move(entry));
        order_.push_back(address);
    }
}

void VTAS::build_pages(std::uint64_t data_section_offset,
                        std::uint64_t data_section_size,
                        std::size_t page_size) {
    std::lock_guard lock(mutex_);
    clear_locked();
    mode_ = LayoutMode::Pages;

    if (page_size == 0 || data_section_size == 0) {
        return;
    }

    const std::size_t page_count =
        static_cast<std::size_t>((data_section_size + page_size - 1) / page_size);

    for (std::size_t i = 0; i < page_count; ++i) {
        const std::uint64_t rel = static_cast<std::uint64_t>(i) * page_size;
        const std::uint64_t chunk_size = std::min(page_size, data_section_size - rel);

        VirtualTensorAddress address{next_address_++};
        Entry entry;
        entry.descriptor.address = address;
        entry.descriptor.name = "page." + std::to_string(i);
        entry.descriptor.size = chunk_size;
        entry.descriptor.file_offset = data_section_offset + rel;
        entry.state = TensorState::SsdOnly;
        entry.chunk_index = i;

        entries_.emplace(address, std::move(entry));
        order_.push_back(address);
    }
}

std::size_t VTAS::chunk_count() const {
    std::lock_guard lock(mutex_);
    return entries_.size();
}

const ChunkDescriptor* VTAS::chunk(VirtualTensorAddress address) const {
    std::lock_guard lock(mutex_);
    auto it = entries_.find(address);
    if (it == entries_.end()) {
        return nullptr;
    }
    return &it->second.descriptor;
}

const TensorDescriptor* VTAS::descriptor(VirtualTensorAddress address) const {
    (void)address;
    return nullptr;
}

std::optional<VirtualTensorAddress> VTAS::address_at_index(std::size_t index) const {
    std::lock_guard lock(mutex_);
    if (index >= order_.size()) {
        return std::nullopt;
    }
    return order_[index];
}

std::optional<std::size_t> VTAS::index_of(VirtualTensorAddress address) const {
    std::lock_guard lock(mutex_);
    auto it = entries_.find(address);
    if (it == entries_.end()) {
        return std::nullopt;
    }
    return it->second.chunk_index;
}

TensorState VTAS::state(VirtualTensorAddress address) const {
    std::lock_guard lock(mutex_);
    auto it = entries_.find(address);
    if (it == entries_.end()) {
        return TensorState::NotPresent;
    }
    return it->second.state;
}

void VTAS::set_state(VirtualTensorAddress address, TensorState state) {
    std::lock_guard lock(mutex_);
    auto it = entries_.find(address);
    if (it != entries_.end()) {
        it->second.state = state;
    }
}

std::optional<std::size_t> VTAS::ram_offset(VirtualTensorAddress address) const {
    std::lock_guard lock(mutex_);
    auto it = entries_.find(address);
    if (it == entries_.end() || !it->second.ram_offset) {
        return std::nullopt;
    }
    return *it->second.ram_offset;
}

void VTAS::set_ram_offset(VirtualTensorAddress address, std::optional<std::size_t> offset) {
    std::lock_guard lock(mutex_);
    auto it = entries_.find(address);
    if (it != entries_.end()) {
        it->second.ram_offset = offset;
    }
}

std::optional<std::size_t> VTAS::vram_offset(VirtualTensorAddress address) const {
    std::lock_guard lock(mutex_);
    auto it = entries_.find(address);
    if (it == entries_.end() || !it->second.vram_offset) {
        return std::nullopt;
    }
    return *it->second.vram_offset;
}

void VTAS::set_vram_offset(VirtualTensorAddress address, std::optional<std::size_t> offset) {
    std::lock_guard lock(mutex_);
    auto it = entries_.find(address);
    if (it != entries_.end()) {
        it->second.vram_offset = offset;
    }
}

std::vector<std::size_t> VTAS::coalesce_run_from(std::size_t start_index, std::size_t max_bytes) const {
    std::lock_guard lock(mutex_);
    std::vector<std::size_t> run;

    if (start_index >= order_.size() || max_bytes == 0) {
        return run;
    }

    std::size_t total = 0;
    const ChunkDescriptor* previous = nullptr;

    for (std::size_t i = start_index; i < order_.size(); ++i) {
        const auto it = entries_.find(order_[i]);
        if (it == entries_.end()) {
            break;
        }

        const ChunkDescriptor& current = it->second.descriptor;
        if (previous != nullptr) {
            if (previous->file_offset + previous->size != current.file_offset) {
                break;
            }
        }

        if (total + current.size > max_bytes) {
            if (run.empty()) {
                run.push_back(i);
            }
            break;
        }

        run.push_back(i);
        total += static_cast<std::size_t>(current.size);
        previous = &current;
    }

    return run;
}

}  // namespace ws
