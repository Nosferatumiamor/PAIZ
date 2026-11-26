#include "WeightStream/GGUFReader.h"

#include <algorithm>
#include <cstring>
#include <fstream>
#include <iostream>

namespace ws {
namespace {

constexpr std::uint32_t kGgufMagic = 0x46554747;  // "GGUF"

enum class GgufValueType : std::uint32_t {
    UINT8 = 0,
    INT8 = 1,
    UINT16 = 2,
    INT16 = 3,
    UINT32 = 4,
    INT32 = 5,
    FLOAT32 = 6,
    BOOL = 7,
    STRING = 8,
    ARRAY = 9,
    UINT64 = 10,
    INT64 = 11,
    FLOAT64 = 12,
};

struct BinaryReader {
    std::ifstream& file;
    std::string error;

    bool read(void* dst, std::size_t size) {
        file.read(reinterpret_cast<char*>(dst), static_cast<std::streamsize>(size));
        if (!file) {
            error = "unexpected end of file";
            return false;
        }
        return true;
    }

    bool read_u8(std::uint8_t& v) { return read(&v, sizeof(v)); }
    bool read_u16(std::uint16_t& v) { return read(&v, sizeof(v)); }
    bool read_u32(std::uint32_t& v) { return read(&v, sizeof(v)); }
    bool read_u64(std::uint64_t& v) { return read(&v, sizeof(v)); }
    bool read_i32(std::int32_t& v) { return read(&v, sizeof(v)); }
    bool read_f32(float& v) { return read(&v, sizeof(v)); }
    bool read_f64(double& v) { return read(&v, sizeof(v)); }

    bool read_string(std::string& out) {
        std::uint64_t len = 0;
        if (!read_u64(len)) {
            return false;
        }
        out.resize(static_cast<std::size_t>(len));
        if (len == 0) {
            return true;
        }
        return read(out.data(), static_cast<std::size_t>(len));
    }

    bool skip(std::size_t bytes) {
        file.seekg(static_cast<std::streamoff>(bytes), std::ios::cur);
        if (!file) {
            error = "seek failed";
            return false;
        }
        return true;
    }

    bool skip_value(GgufValueType type) {
        switch (type) {
            case GgufValueType::UINT8:
            case GgufValueType::INT8:
            case GgufValueType::BOOL:
                return skip(1);
            case GgufValueType::UINT16:
            case GgufValueType::INT16:
                return skip(2);
            case GgufValueType::UINT32:
            case GgufValueType::INT32:
            case GgufValueType::FLOAT32:
                return skip(4);
            case GgufValueType::UINT64:
            case GgufValueType::INT64:
            case GgufValueType::FLOAT64:
                return skip(8);
            case GgufValueType::STRING: {
                std::string tmp;
                return read_string(tmp);
            }
            case GgufValueType::ARRAY: {
                std::uint32_t arr_type = 0;
                std::uint64_t count = 0;
                if (!read_u32(arr_type) || !read_u64(count)) {
                    return false;
                }
                for (std::uint64_t i = 0; i < count; ++i) {
                    if (!skip_value(static_cast<GgufValueType>(arr_type))) {
                        return false;
                    }
                }
                return true;
            }
        }
        error = "unsupported GGUF value type";
        return false;
    }

    bool read_value_string(GgufValueType type, std::string& out) {
        if (type != GgufValueType::STRING) {
            return skip_value(type);
        }
        return read_string(out);
    }
};

}  // namespace

GGUFReader::GGUFReader(std::filesystem::path path) : path_(std::move(path)) {
    parse();
}

namespace {

struct BlockLayout {
    std::uint64_t elements = 0;  // elements per block (1 for plain types)
    std::uint64_t bytes = 0;     // bytes per block
};

// Matches ggml's type traits (ggml.c); 0 elements = unknown to WeightStream.
BlockLayout block_layout(TensorType type) {
    switch (type) {
        case TensorType::F32: return {1, 4};
        case TensorType::F16: return {1, 2};
        case TensorType::BF16: return {1, 2};
        case TensorType::F64: return {1, 8};
        case TensorType::I8: return {1, 1};
        case TensorType::I16: return {1, 2};
        case TensorType::I32: return {1, 4};
        case TensorType::I64: return {1, 8};
        case TensorType::Q4_0: return {32, 18};
        case TensorType::Q4_1: return {32, 20};
        case TensorType::Q5_0: return {32, 22};
        case TensorType::Q5_1: return {32, 24};
        case TensorType::Q8_0: return {32, 34};
        case TensorType::Q8_1: return {32, 36};
        case TensorType::IQ4_NL: return {32, 18};
        case TensorType::MXFP4: return {32, 17};
        case TensorType::Q2_K: return {256, 84};
        case TensorType::Q3_K: return {256, 110};
        case TensorType::Q4_K: return {256, 144};
        case TensorType::Q5_K: return {256, 176};
        case TensorType::Q6_K: return {256, 210};
        case TensorType::Q8_K: return {256, 292};
        case TensorType::IQ2_XXS: return {256, 66};
        case TensorType::IQ2_XS: return {256, 74};
        case TensorType::IQ3_XXS: return {256, 98};
        case TensorType::IQ1_S: return {256, 50};
        case TensorType::IQ3_S: return {256, 110};
        case TensorType::IQ2_S: return {256, 82};
        case TensorType::IQ4_XS: return {256, 136};
        case TensorType::IQ1_M: return {256, 56};
        case TensorType::TQ1_0: return {256, 54};
        case TensorType::TQ2_0: return {256, 66};
        default: return {};
    }
}

}  // namespace

std::uint64_t GGUFReader::element_size(TensorType type) {
    const BlockLayout layout = block_layout(type);
    return layout.elements == 1 ? layout.bytes : 0;
}

std::uint64_t GGUFReader::block_size(TensorType type) {
    const BlockLayout layout = block_layout(type);
    return layout.elements == 0 ? 1 : layout.elements;
}

std::uint64_t GGUFReader::compute_tensor_size(const std::vector<std::uint64_t>& dims, TensorType type) {
    std::uint64_t n_elements = 1;
    for (auto d : dims) {
        n_elements *= d;
    }

    const BlockLayout layout = block_layout(type);
    if (layout.elements == 0) {
        return 0;
    }
    return (n_elements + layout.elements - 1) / layout.elements * layout.bytes;
}

bool GGUFReader::parse() {
    if (!std::filesystem::exists(path_)) {
        error_ = "file does not exist: " + path_.string();
        return false;
    }

    std::ifstream file(path_, std::ios::binary);
    if (!file) {
        error_ = "failed to open file";
        return false;
    }

    if (!read_header(file) || !read_metadata(file) || !read_tensor_infos(file)) {
        return false;
    }

    valid_ = true;
    return true;
}

bool GGUFReader::read_header(std::ifstream& file) {
    BinaryReader reader{file};

    std::uint32_t magic = 0;
    std::uint64_t n_tensors = 0;
    std::uint64_t n_kv = 0;

    if (!reader.read_u32(magic) || magic != kGgufMagic) {
        error_ = "invalid GGUF magic";
        return false;
    }
    if (!reader.read_u32(version_)) {
        error_ = reader.error;
        return false;
    }
    if (!reader.read_u64(n_tensors) || !reader.read_u64(n_kv)) {
        error_ = reader.error;
        return false;
    }

    tensors_.reserve(static_cast<std::size_t>(n_tensors));

    for (std::uint64_t i = 0; i < n_kv; ++i) {
        std::string key;
        std::uint32_t value_type = 0;
        if (!reader.read_string(key) || !reader.read_u32(value_type)) {
            error_ = reader.error;
            return false;
        }

        if (key == "general.alignment") {
            std::uint32_t align32 = 0;
            if (static_cast<GgufValueType>(value_type) == GgufValueType::UINT32 && reader.read_u32(align32)) {
                alignment_ = align32;
            } else {
                if (!reader.skip_value(static_cast<GgufValueType>(value_type))) {
                    error_ = reader.error;
                    return false;
                }
            }
            continue;
        }

        std::string value;
        if (!reader.read_value_string(static_cast<GgufValueType>(value_type), value)) {
            error_ = reader.error.empty() ? "failed to read metadata value" : reader.error;
            return false;
        }
        metadata_strings_[key] = std::move(value);
    }

    return true;
}

bool GGUFReader::read_metadata(std::ifstream& file) {
    (void)file;
    return true;
}

bool GGUFReader::read_tensor_infos(std::ifstream& file) {
    BinaryReader reader{file};

    for (std::size_t i = 0; i < tensors_.capacity(); ++i) {
        TensorInfo info;
        std::uint32_t n_dims = 0;
        std::uint32_t raw_type = 0;

        if (!reader.read_string(info.name) || !reader.read_u32(n_dims)) {
            error_ = reader.error;
            return false;
        }

        info.dimensions.resize(n_dims);
        for (std::uint32_t d = 0; d < n_dims; ++d) {
            if (!reader.read_u64(info.dimensions[d])) {
                error_ = reader.error;
                return false;
            }
        }

        if (!reader.read_u32(raw_type) || !reader.read_u64(info.offset)) {
            error_ = reader.error;
            return false;
        }

        info.type = static_cast<TensorType>(raw_type);
        tensors_.push_back(std::move(info));
    }

    const auto pos = file.tellg();
    if (pos < 0) {
        error_ = "failed to determine data section offset";
        return false;
    }

    const auto aligned = (static_cast<std::uint64_t>(pos) + alignment_ - 1) / alignment_ * alignment_;
    file.seekg(static_cast<std::streamoff>(aligned));
    if (!file) {
        error_ = "failed to align to data section";
        return false;
    }

    data_offset_ = static_cast<std::uint64_t>(file.tellg());

    const auto file_size = std::filesystem::file_size(path_);
    if (file_size <= data_offset_) {
        error_ = "invalid GGUF data section";
        return false;
    }
    const std::uint64_t data_bytes = file_size - data_offset_;

    // Size from consecutive offsets — format-agnostic, works for all quant types.
    std::sort(tensors_.begin(), tensors_.end(),
              [](const TensorInfo& a, const TensorInfo& b) { return a.offset < b.offset; });

    for (std::size_t i = 0; i < tensors_.size(); ++i) {
        const std::uint64_t end = (i + 1 < tensors_.size()) ? tensors_[i + 1].offset : data_bytes;
        if (end < tensors_[i].offset) {
            error_ = "invalid tensor offsets in tensor #" + std::to_string(i);
            return false;
        }
        tensors_[i].size = end - tensors_[i].offset;
        if (tensors_[i].size == 0) {
            error_ = "zero-size tensor #" + std::to_string(i);
            return false;
        }
    }

    return true;
}

bool GGUFReader::read_tensor_bytes(const TensorInfo& tensor, std::vector<std::byte>& out) const {
    std::ifstream file(path_, std::ios::binary);
    if (!file) {
        return false;
    }

    out.resize(static_cast<std::size_t>(tensor.size));
    file.seekg(static_cast<std::streamoff>(data_offset_ + tensor.offset));
    if (!file) {
        return false;
    }

    file.read(reinterpret_cast<char*>(out.data()), static_cast<std::streamsize>(tensor.size));
    return static_cast<bool>(file);
}

}  // namespace ws
