#pragma once

#include "WeightStream/GGUFReader.h"

#include <cstddef>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <vector>

namespace ws {

/// Blocking SSD reader for tensor payloads.
class SSDReader {
public:
    explicit SSDReader(GGUFReader reader);

    const GGUFReader& gguf() const { return gguf_; }
    bool read_tensor(std::size_t tensor_index, std::vector<std::byte>& out);
    bool read_bytes(std::uint64_t file_offset, std::size_t size, std::vector<std::byte>& out);
    bool read_into(std::uint64_t file_offset, std::size_t size, void* dst);

private:
    GGUFReader gguf_;
    mutable std::ifstream file_;
    mutable std::mutex read_mutex_;
};

}  // namespace ws
