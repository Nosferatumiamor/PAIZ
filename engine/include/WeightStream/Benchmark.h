#pragma once

#include "WeightStream/Config.h"

#include <cstdint>
#include <filesystem>
#include <string>

namespace ws {

struct BenchmarkResult {
    std::size_t page_size = 0;
    std::uint32_t prefetch_window = 0;
    std::size_t ram_capacity = 0;
    std::size_t vram_capacity = 0;
    std::size_t chunk_count = 0;
    std::uint32_t rounds = 0;

    double elapsed_seconds = 0.0;
    double gpu_wait_seconds = 0.0;
    std::uint64_t ssd_bytes_read = 0;
    std::uint64_t ssd_read_ops = 0;
    std::uint64_t coalesced_pages = 0;
    std::uint64_t vram_bytes_uploaded = 0;
    std::uint64_t cache_hits = 0;
    std::uint64_t cache_misses = 0;
    std::size_t access_steps = 0;

    bool success = false;
    std::string error;
};

/// Stream all chunks for `rounds` passes and collect metrics.
BenchmarkResult run_stream_benchmark(const std::filesystem::path& gguf_path,
                                     Config config,
                                     std::uint32_t rounds = 2);

}  // namespace ws
