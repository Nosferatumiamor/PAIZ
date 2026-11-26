#include "WeightStream/TensorIndex.h"

namespace ws {

void TensorIndex::build_from_gguf(const GGUFReader& reader) {
    tensors_.clear();
    name_to_index_.clear();
    total_size_ = 0;

    tensors_ = reader.tensors();
    for (std::size_t i = 0; i < tensors_.size(); ++i) {
        name_to_index_[tensors_[i].name] = i;
        total_size_ += tensors_[i].size;
    }
}

const TensorInfo* TensorIndex::find_by_name(const std::string& name) const {
    auto it = name_to_index_.find(name);
    if (it == name_to_index_.end()) {
        return nullptr;
    }
    return &tensors_[it->second];
}

const TensorInfo* TensorIndex::find_by_index(std::size_t index) const {
    if (index >= tensors_.size()) {
        return nullptr;
    }
    return &tensors_[index];
}

std::optional<std::size_t> TensorIndex::index_of(const std::string& name) const {
    auto it = name_to_index_.find(name);
    if (it == name_to_index_.end()) {
        return std::nullopt;
    }
    return it->second;
}

}  // namespace ws
