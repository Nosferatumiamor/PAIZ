#pragma once

#include <cstddef>
#include <cstdint>

namespace ws {

/// Low-level byte source for external loaders (e.g. llama.cpp GGUF reads).
/// WeightStream provides bytes at absolute file offsets — not tensors.
class ByteStore {
public:
    virtual ~ByteStore() = default;

    /// Read `size` bytes from the model file at `file_offset` into `dst`.
    virtual bool read_at(std::uint64_t file_offset, void* dst, std::size_t size) = 0;
};

}  // namespace ws
