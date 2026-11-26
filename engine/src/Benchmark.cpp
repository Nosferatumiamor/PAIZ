#include "WeightStream/Benchmark.h"
#include "WeightStream/VTMM.h"

#include <chrono>

namespace ws {

BenchmarkResult run_stream_benchmark(const std::filesystem::path& gguf_path,
                                     Config config,
                                     std::uint32_t rounds) {
    BenchmarkResult result;
    result.page_size = config.page_size;
    result.prefetch_window = config.prefetch_window;
    result.ram_capacity = config.ram_capacity;
    result.vram_capacity = config.vram_capacity;
    result.rounds = rounds;
    config.verbose = false;

    VTMM manager(config);
    if (!manager.load_model(gguf_path)) {
        result.error = manager.last_error();
        return result;
    }

    result.chunk_count = manager.chunk_count();
    const auto sequence = manager.access_sequence();
    result.access_steps = sequence.size() * rounds;

    const auto t0 = std::chrono::steady_clock::now();

    for (std::uint32_t round = 0; round < rounds; ++round) {
        for (const std::size_t chunk_index : sequence) {
            const auto handle = manager.get_page_by_index(chunk_index);
            if (!handle.ready()) {
                result.error = "chunk #" + std::to_string(chunk_index) + " failed on round " + std::to_string(round);
                if (!manager.last_error().empty()) {
                    result.error += ": " + manager.last_error();
                }
                manager.shutdown();
                return result;
            }
        }
    }

    const auto t1 = std::chrono::steady_clock::now();
    const auto& metrics = manager.metrics();

    result.elapsed_seconds = std::chrono::duration<double>(t1 - t0).count();
    result.gpu_wait_seconds = metrics.total_gpu_wait_seconds();
    result.ssd_bytes_read = metrics.ssd_bytes_read();
    result.ssd_read_ops = metrics.ssd_read_ops();
    result.coalesced_pages = metrics.coalesced_pages();
    result.vram_bytes_uploaded = metrics.vram_bytes_uploaded();
    result.cache_hits = metrics.cache_hits();
    result.cache_misses = metrics.cache_misses();
    result.success = true;

    manager.shutdown();
    return result;
}

}  // namespace ws
