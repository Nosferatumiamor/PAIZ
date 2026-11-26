#include "WeightStream/VTMM.h"

#include <cuda_runtime.h>

#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

namespace {

void die(const std::string& msg) {
    std::cerr << "ws_gpu_smoke: " << msg << '\n';
    std::exit(1);
}

void check_cuda(cudaError_t err, const char* what) {
    if (err != cudaSuccess) {
        die(std::string(what) + ": " + cudaGetErrorString(err));
    }
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: ws_gpu_smoke <model.gguf> [page_index]\n";
        return 1;
    }

    cudaDeviceProp prop{};
    check_cuda(cudaGetDeviceProperties(&prop, 0), "cudaGetDeviceProperties");
    std::cerr << "GPU: " << prop.name << " (" << (prop.totalGlobalMem / (1024 * 1024)) << " MiB)\n";

    ws::Config config;
    config.verbose = true;
    config.cuda_vram = true;
    config.single_copy_hierarchy = true;
    config.profile_mode = ws::ProfileMode::Off;

    ws::VTMM vtmm(config);
    if (!vtmm.load_model(argv[1])) {
        die(vtmm.last_error());
    }

    const std::size_t page_index = (argc >= 3) ? static_cast<std::size_t>(std::stoull(argv[2])) : 0;
    if (page_index >= vtmm.chunk_count()) {
        die("page_index out of range");
    }

    const auto address = vtmm.vtas().address_at_index(page_index);
    if (!address) {
        die("missing page address");
    }

    const auto* chunk = vtmm.vtas().chunk(*address);
    if (!chunk) {
        die("missing chunk descriptor");
    }

    std::cerr << "Loading page " << page_index << " (" << chunk->name << ", "
              << (chunk->size / (1024 * 1024)) << " MiB) to CUDA VRAM...\n";

    const auto handle = vtmm.get_page_by_index(page_index);
    if (!handle.ready()) {
        die("page not GPU-ready: " + vtmm.last_error());
    }

    std::cerr << "GPU pointer: " << handle.data << '\n';

    const std::size_t sample = static_cast<std::size_t>(std::min<std::uint64_t>(chunk->size, 64));
    std::vector<std::byte> host_sample(sample);
    check_cuda(cudaMemcpy(host_sample.data(), handle.data, sample, cudaMemcpyDeviceToHost),
               "cudaMemcpy D2H verify");

    std::cerr << "First " << sample << " bytes on GPU (hex): ";
    for (std::size_t i = 0; i < sample; ++i) {
        const auto b = static_cast<unsigned>(host_sample[i]);
        fprintf(stderr, "%02x", b);
    }
    std::cerr << '\n';

    const auto& m = vtmm.metrics();
    std::cerr << "SSD read: " << (m.ssd_bytes_read() / (1024.0 * 1024.0)) << " MiB\n";
    std::cerr << "RAM->VRAM: " << (m.vram_bytes_uploaded() / (1024.0 * 1024.0)) << " MiB\n";
    std::cerr << "VRAM entries: " << vtmm.vtas().chunk_count() << " chunks total\n";
    std::cerr << "OK — page resident on CUDA device.\n";
    return 0;
}
