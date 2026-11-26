#pragma once

#include "WeightStream/Types.h"

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace ws {

/// Metadata extracted from a GGUF file header. Does not load tensor payloads.
class GGUFReader {
public:
    explicit GGUFReader(std::filesystem::path path);

    bool valid() const { return valid_; }
    const std::string& error() const { return error_; }

    std::uint32_t version() const { return version_; }
    std::uint64_t tensor_count() const { return tensors_.size(); }
    std::uint64_t data_offset() const { return data_offset_; }
    std::uint32_t alignment() const { return alignment_; }
    const std::filesystem::path& path() const { return path_; }

    const std::vector<TensorInfo>& tensors() const { return tensors_; }
    const std::unordered_map<std::string, std::string>& metadata_strings() const { return metadata_strings_; }

    /// Read raw tensor bytes from disk into `out`. Thread-safe for distinct tensors.
    bool read_tensor_bytes(const TensorInfo& tensor, std::vector<std::byte>& out) const;

private:
    bool parse();
    bool read_header(std::ifstream& file);
    bool read_metadata(std::ifstream& file);
    bool read_tensor_infos(std::ifstream& file);

    static std::uint64_t element_size(TensorType type);
    static std::uint64_t block_size(TensorType type);
    static std::uint64_t compute_tensor_size(const std::vector<std::uint64_t>& dims, TensorType type);

    std::filesystem::path path_;
    bool valid_ = false;
    std::string error_;

    std::uint32_t version_ = 0;
    std::uint64_t data_offset_ = 0;
    std::uint32_t alignment_ = 32;
    std::vector<TensorInfo> tensors_;
    std::unordered_map<std::string, std::string> metadata_strings_;
};

}  // namespace ws
