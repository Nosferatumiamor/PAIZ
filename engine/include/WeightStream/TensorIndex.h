#pragma once

#include "WeightStream/GGUFReader.h"
#include "WeightStream/Types.h"

#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace ws {

/// Lightweight tensor database built from a GGUF index.
class TensorIndex {
public:
    void build_from_gguf(const GGUFReader& reader);

    std::size_t size() const { return tensors_.size(); }
    const std::vector<TensorInfo>& tensors() const { return tensors_; }

    const TensorInfo* find_by_name(const std::string& name) const;
    const TensorInfo* find_by_index(std::size_t index) const;

    std::optional<std::size_t> index_of(const std::string& name) const;
    std::uint64_t total_size() const { return total_size_; }

private:
    std::vector<TensorInfo> tensors_;
    std::unordered_map<std::string, std::size_t> name_to_index_;
    std::uint64_t total_size_ = 0;
};

}  // namespace ws
