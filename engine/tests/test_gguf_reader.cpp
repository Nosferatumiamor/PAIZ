#include "WeightStream/GGUFReader.h"
#include "WeightStream/TensorIndex.h"
#include "WeightStream/VTAS.h"

#include <cassert>
#include <filesystem>
#include <fstream>
#include <iostream>

int main() {
    const std::filesystem::path model = std::filesystem::temp_directory_path() / "ws_test_tiny.gguf";

    // Generate a tiny model via external tool is heavy; write inline minimal GGUF.
    {
        std::ofstream out(model, std::ios::binary);
        auto w32 = [&](std::uint32_t v) { out.write(reinterpret_cast<char*>(&v), 4); };
        auto w64 = [&](std::uint64_t v) { out.write(reinterpret_cast<char*>(&v), 8); };
        auto ws = [&](const std::string& s) {
            w64(s.size());
            out.write(s.data(), static_cast<std::streamsize>(s.size()));
        };

        w32(0x46554747);
        w32(3);
        w64(1);
        w64(1);
        ws("general.alignment");
        w32(4);
        w32(32);

        ws("tensor_a");
        w32(1);
        w64(256);
        w32(0);
        w64(0);

        std::vector<float> data(256, 1.0f);
        out.seekp(32);
        out.write(reinterpret_cast<char*>(data.data()), static_cast<std::streamsize>(data.size() * sizeof(float)));
    }

    ws::GGUFReader reader(model);
    if (!reader.valid()) {
        std::cerr << "GGUFReader failed: " << reader.error() << '\n';
        return 1;
    }

    assert(reader.tensor_count() == 1);

    ws::TensorIndex index;
    index.build_from_gguf(reader);
    assert(index.size() == 1);

    ws::VTAS vtas;
    vtas.register_tensors(index, reader.data_offset());
    assert(vtas.chunk_count() == 1);

    const auto addr = vtas.address_at_index(0);
    assert(addr && addr->value == 1);

    std::vector<std::byte> payload;
    assert(reader.read_tensor_bytes(reader.tensors()[0], payload));
    assert(payload.size() == 256 * 4);

    std::cerr << "All GGUF/VTAS smoke tests passed.\n";
    return 0;
}
