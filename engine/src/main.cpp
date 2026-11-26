#include "WeightStream/Config.h"
#include "WeightStream/VTMM.h"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>

namespace {

void print_usage() {
    std::cerr << "Usage: weightstream_demo <model.gguf> [options]\n";
    std::cerr << "  --vram-mib N       VRAM budget (default 12288)\n";
    std::cerr << "  --ram-mib N        RAM cache (default 8192)\n";
    std::cerr << "  --window N         Prefetch window (default 4)\n";
    std::cerr << "  --page-mib N       Page size (default 32, 0=tensor mode)\n";
    std::cerr << "  --coalesce-mib N   Max coalesced read (default 256, 0=off)\n";
    std::cerr << "  --tensor-mode      Same as --page-mib 0\n";
    std::cerr << "  --sequential       Verbose per-chunk output\n";
    std::cerr << "  --rounds N         Pass count (default 2)\n";
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        print_usage();
        return 1;
    }

    ws::Config config;
    config.verbose = true;

    std::string model_path;
    bool sequential = false;
    std::uint32_t rounds = 2;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--sequential") {
            sequential = true;
        } else if (arg == "--tensor-mode") {
            config.page_size = 0;
        } else if (arg == "--vram-mib" && i + 1 < argc) {
            config.vram_capacity = static_cast<std::size_t>(std::stoull(argv[++i])) * 1024 * 1024;
        } else if (arg == "--ram-mib" && i + 1 < argc) {
            config.ram_capacity = static_cast<std::size_t>(std::stoull(argv[++i])) * 1024 * 1024;
        } else if (arg == "--window" && i + 1 < argc) {
            config.prefetch_window = static_cast<std::uint32_t>(std::stoul(argv[++i]));
        } else if (arg == "--page-mib" && i + 1 < argc) {
            config.page_size = static_cast<std::size_t>(std::stoull(argv[++i])) * 1024 * 1024;
        } else if (arg == "--coalesce-mib" && i + 1 < argc) {
            config.coalesce_max_bytes = static_cast<std::size_t>(std::stoull(argv[++i])) * 1024 * 1024;
        } else if (arg == "--rounds" && i + 1 < argc) {
            rounds = static_cast<std::uint32_t>(std::stoul(argv[++i]));
        } else if (arg.rfind('-', 0) == 0) {
            std::cerr << "Unknown option: " << arg << '\n';
            print_usage();
            return 1;
        } else {
            model_path = arg;
        }
    }

    if (model_path.empty()) {
        print_usage();
        return 1;
    }

    ws::VTMM manager(config);
    if (!manager.load_model(model_path)) {
        std::cerr << "Failed to load model: " << manager.last_error() << '\n';
        return 1;
    }

    const auto& vtas = manager.vtas();
    const std::size_t count = manager.chunk_count();
    const char* unit = config.paged_mode() ? "pages" : "tensors";

    std::cerr << "\nStreaming " << count << ' ' << unit << " through SSD -> RAM -> VRAM...\n\n";

    const auto t0 = std::chrono::steady_clock::now();

    for (std::uint32_t round = 0; round < rounds; ++round) {
        for (std::size_t i = 0; i < count; ++i) {
            const auto handle = manager.get_page_by_index(i);
            if (!handle.ready()) {
                const auto* chunk = vtas.chunk(handle.address);
                std::cerr << "Chunk #" << i << " failed on round " << round;
                if (chunk) {
                    std::cerr << " (" << chunk->name << ", " << (chunk->size / (1024 * 1024)) << " MiB)";
                }
                std::cerr << " — " << manager.last_error() << '\n';
                return 1;
            }

            if (sequential) {
                const auto* chunk = vtas.chunk(handle.address);
                std::cerr << "  [" << i << "] " << (chunk ? chunk->name : "?") << " — "
                          << (handle.size / 1024) << " KiB in VRAM\n";
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
        }
    }

    const auto t1 = std::chrono::steady_clock::now();
    const auto& m = manager.metrics();

    std::cerr << "\n--- Metrics ---\n";
    std::cerr << "SSD bytes read:      " << m.ssd_bytes_read() / (1024 * 1024) << " MiB\n";
    std::cerr << "SSD read ops:        " << m.ssd_read_ops() << '\n';
    std::cerr << "Coalesced pages:     " << m.coalesced_pages() << '\n';
    std::cerr << "VRAM bytes uploaded: " << m.vram_bytes_uploaded() / (1024 * 1024) << " MiB\n";
    std::cerr << "Cache hits:          " << m.cache_hits() << '\n';
    std::cerr << "Cache misses:        " << m.cache_misses() << '\n';
    std::cerr << "GPU wait (s):        " << m.total_gpu_wait_seconds() << '\n';
    std::cerr << "Elapsed (s):         " << std::chrono::duration<double>(t1 - t0).count() << '\n';

    std::cerr << "\nPipeline OK — GetPage() streams weights through all tiers.\n";
    return 0;
}
