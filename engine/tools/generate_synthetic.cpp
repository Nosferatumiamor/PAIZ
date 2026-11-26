#include "WeightStream/GGUFReader.h"
#include "WeightStream/Types.h"

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

constexpr std::uint32_t kGgufMagic = 0x46554747;

enum class GgufValueType : std::uint32_t {
    UINT32 = 4,
    STRING = 8,
};

void write_u32(std::ofstream& out, std::uint32_t v) {
    out.write(reinterpret_cast<const char*>(&v), sizeof(v));
}

void write_u64(std::ofstream& out, std::uint64_t v) {
    out.write(reinterpret_cast<const char*>(&v), sizeof(v));
}

void write_string(std::ofstream& out, const std::string& s) {
    write_u64(out, s.size());
    out.write(s.data(), static_cast<std::streamsize>(s.size()));
}

void write_kv_u32(std::ofstream& out, const std::string& key, std::uint32_t value) {
    write_string(out, key);
    write_u32(out, static_cast<std::uint32_t>(GgufValueType::UINT32));
    write_u32(out, value);
}

void write_kv_string(std::ofstream& out, const std::string& key, const std::string& value) {
    write_string(out, key);
    write_u32(out, static_cast<std::uint32_t>(GgufValueType::STRING));
    write_string(out, value);
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 4) {
        std::cerr << "Usage: ws_generate_synthetic <output.gguf> <tensor_count> <tensor_size_kb>\n";
        std::cerr << "Example: ws_generate_synthetic synthetic.gguf 80 512\n";
        return 1;
    }

    const std::filesystem::path output = argv[1];
    const std::size_t tensor_count = static_cast<std::size_t>(std::stoull(argv[2]));
    const std::size_t tensor_size = static_cast<std::size_t>(std::stoull(argv[3])) * 1024;
    const std::uint32_t alignment = 32;

    std::ofstream out(output, std::ios::binary);
    if (!out) {
        std::cerr << "Failed to open output file\n";
        return 1;
    }

    write_u32(out, kGgufMagic);
    write_u32(out, 3);
    write_u64(out, tensor_count);
    write_u64(out, 2);
    write_kv_u32(out, "general.alignment", alignment);
    write_kv_string(out, "general.name", "WeightStream synthetic model");

    std::uint64_t running_offset = 0;
    for (std::size_t i = 0; i < tensor_count; ++i) {
        const std::string name = "blk." + std::to_string(i) + ".weight";
        write_string(out, name);
        write_u32(out, 1);
        const std::uint64_t elems = tensor_size / sizeof(float);
        write_u64(out, elems);
        write_u32(out, static_cast<std::uint32_t>(ws::TensorType::F32));
        write_u64(out, running_offset);
        running_offset += tensor_size;
    }

    const auto pos = out.tellp();
    const auto aligned = (static_cast<std::uint64_t>(pos) + alignment - 1) / alignment * alignment;
    out.seekp(static_cast<std::streamoff>(aligned));

    std::vector<char> pattern(4096);
    for (std::size_t i = 0; i < pattern.size(); ++i) {
        pattern[i] = static_cast<char>(i & 0xFF);
    }

    std::size_t remaining = tensor_count * tensor_size;
    while (remaining > 0) {
        const std::size_t chunk = std::min(remaining, pattern.size());
        out.write(pattern.data(), static_cast<std::streamsize>(chunk));
        remaining -= chunk;
    }

    out.close();

    const double total_gib = static_cast<double>(tensor_count * tensor_size) / (1024.0 * 1024.0 * 1024.0);
    std::cerr << "Wrote " << output << " — " << tensor_count << " tensors x " << (tensor_size / 1024)
              << " KiB (" << total_gib << " GiB total)\n";
    return 0;
}
