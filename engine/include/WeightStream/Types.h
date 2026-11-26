#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace ws {

/// Stable 64-bit virtual address. Never changes for a chunk (tensor or page).
struct VirtualTensorAddress {
    std::uint64_t value = 0;

    bool valid() const { return value != 0; }
    bool operator==(const VirtualTensorAddress& other) const { return value == other.value; }
    bool operator!=(const VirtualTensorAddress& other) const { return value != other.value; }
};

}  // namespace ws

namespace std {

template <>
struct hash<ws::VirtualTensorAddress> {
    std::size_t operator()(const ws::VirtualTensorAddress& address) const noexcept {
        return std::hash<std::uint64_t>{}(address.value);
    }
};

}  // namespace std

namespace ws {

using VirtualPageAddress = VirtualTensorAddress;

/// Layout granularity managed by VTAS.
enum class LayoutMode {
    Tensors,
    Pages,
};

/// GGUF tensor element type (subset used by the reader).
enum class TensorType : std::uint32_t {
    F32 = 0,
    F16 = 1,
    Q4_0 = 2,
    Q4_1 = 3,
    Q5_0 = 6,
    Q5_1 = 7,
    Q8_0 = 8,
    Q8_1 = 9,
    Q2_K = 10,
    Q3_K = 11,
    Q4_K = 12,
    Q5_K = 13,
    Q6_K = 14,
    Q8_K = 15,
    IQ2_XXS = 16,
    IQ2_XS = 17,
    IQ3_XXS = 18,
    IQ1_S = 19,
    IQ4_NL = 20,
    IQ3_S = 21,
    IQ2_S = 22,
    IQ4_XS = 23,
    I8 = 24,
    I16 = 25,
    I32 = 26,
    I64 = 27,
    F64 = 28,
    IQ1_M = 29,
    BF16 = 30,
    TQ1_0 = 34,
    TQ2_0 = 35,
    MXFP4 = 39,
    Unknown = 0xFFFFFFFF,
};

/// Descriptor for a transfer chunk (whole tensor or fixed-size page).
struct ChunkDescriptor {
    VirtualTensorAddress address;
    std::string name;
    std::uint64_t size = 0;
    std::uint64_t file_offset = 0;  // absolute byte offset in the GGUF file
    TensorType type = TensorType::Unknown;
};

using PageDescriptor = ChunkDescriptor;

/// Permanent descriptor for a tensor in the virtual address space (legacy alias).
struct TensorDescriptor {
    VirtualTensorAddress address;
    std::string name;
    std::uint64_t size = 0;
    TensorType type = TensorType::Unknown;
    std::uint32_t alignment = 32;
    std::uint64_t physical_offset = 0;
};

/// Logical residency state of a tensor (RFC-0002 / RFC-0003).
enum class TensorState {
    NotPresent,
    SsdOnly,
    LoadingRam,
    RamReady,
    UploadingGpu,
    GpuReady,
    InUse,
    Evicting,
    Error,
};

/// Opaque handle returned to callers of GetTensor().
struct TensorHandle {
    VirtualTensorAddress address;
    const void* data = nullptr;
    std::size_t size = 0;
    TensorState state = TensorState::NotPresent;

    bool ready() const { return data != nullptr && state == TensorState::GpuReady; }
};

/// Handle returned by GetPage().
struct PageHandle {
    VirtualPageAddress address;
    const void* data = nullptr;
    std::size_t size = 0;
    TensorState state = TensorState::NotPresent;

    bool ready() const { return data != nullptr && state == TensorState::GpuReady; }
};

/// Raw tensor info as read from a GGUF file before VTAS registration.
struct TensorInfo {
    std::string name;
    std::vector<std::uint64_t> dimensions;
    TensorType type = TensorType::Unknown;
    std::uint64_t offset = 0;
    std::uint64_t size = 0;
};

}  // namespace ws
