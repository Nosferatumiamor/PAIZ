#include "WeightStream/Benchmark.h"

#include <cstdio>
#include <iostream>
#include <string>
#include <vector>

namespace {

struct BenchCase {
    const char* label;
    std::size_t page_size;
    std::uint32_t window;
    std::size_t ram_mib;
};

void print_csv_header() {
    std::printf("label,page_size_mib,prefetch_window,ram_mib,vram_mib,chunks,rounds,"
                "elapsed_s,gpu_wait_s,ssd_read_mib,ssd_read_ops,coalesced_pages,"
                "vram_upload_mib,cache_hits,cache_misses,success\n");
}

void print_csv_row(const BenchCase& bench, const ws::BenchmarkResult& r, std::size_t vram_mib) {
    const double page_mib = bench.page_size == 0 ? 0.0 : static_cast<double>(bench.page_size) / (1024.0 * 1024.0);
    std::printf("%s,%.0f,%u,%zu,%zu,%zu,%u,%.2f,%.2f,%llu,%llu,%llu,%llu,%s\n",
                bench.label,
                page_mib,
                bench.window,
                bench.ram_mib,
                vram_mib,
                static_cast<std::size_t>(r.chunk_count),
                r.rounds,
                r.elapsed_seconds,
                r.gpu_wait_seconds,
                static_cast<unsigned long long>(r.ssd_bytes_read / (1024 * 1024)),
                static_cast<unsigned long long>(r.vram_bytes_uploaded / (1024 * 1024)),
                static_cast<unsigned long long>(r.cache_hits),
                static_cast<unsigned long long>(r.cache_misses),
                r.success ? "yes" : "no");
}

void print_usage() {
    std::cerr << "Usage: ws_benchmark <model.gguf> [--vram-mib N] [--rounds N] [--quick] [--csv FILE]\n";
    std::cerr << "  Default: full matrix from ChatGPT proposal (7 runs, may take hours)\n";
    std::cerr << "  --quick: single 32 MiB page run only\n";
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        print_usage();
        return 1;
    }

    std::string model_path;
    std::size_t vram_mib = 12288;
    std::uint32_t rounds = 2;
    bool quick = false;
    std::string csv_path;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--quick") {
            quick = true;
        } else if (arg == "--vram-mib" && i + 1 < argc) {
            vram_mib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (arg == "--rounds" && i + 1 < argc) {
            rounds = static_cast<std::uint32_t>(std::stoul(argv[++i]));
        } else if (arg == "--csv" && i + 1 < argc) {
            csv_path = argv[++i];
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

    const std::size_t mib = 1024 * 1024;
    std::vector<BenchCase> cases;

    if (quick) {
        cases.push_back({"32M_w4_r8", 32 * mib, 4, 8192});
    } else {
        cases = {
            {"tensor_w4_r8", 0, 4, 8192},
            {"64M_w4_r8", 64 * mib, 4, 8192},
            {"32M_w4_r8", 32 * mib, 4, 8192},
            {"16M_w4_r8", 16 * mib, 4, 8192},
            {"32M_w8_r8", 32 * mib, 8, 8192},
            {"32M_w16_r8", 32 * mib, 16, 8192},
            {"32M_w8_r16", 32 * mib, 8, 16384},
        };
    }

    FILE* csv = stdout;
    FILE* csv_file = nullptr;
    if (!csv_path.empty()) {
        csv_file = std::fopen(csv_path.c_str(), "w");
        if (!csv_file) {
            std::perror("fopen csv");
            return 1;
        }
        csv = csv_file;
    }

    auto emit_header = [&]() {
        if (csv == stdout) {
            print_csv_header();
        } else {
            std::fprintf(csv, "label,page_size_mib,prefetch_window,ram_mib,vram_mib,chunks,rounds,"
                               "elapsed_s,gpu_wait_s,ssd_read_mib,ssd_read_ops,coalesced_pages,"
                               "vram_upload_mib,cache_hits,cache_misses,success\n");
        }
    };

    emit_header();

    int failures = 0;
    for (const auto& bench : cases) {
        std::cerr << "[benchmark] " << bench.label << " ...\n";
        std::cerr.flush();

        ws::Config config;
        config.page_size = bench.page_size;
        config.prefetch_window = bench.window;
        config.ram_capacity = bench.ram_mib * mib;
        config.vram_capacity = vram_mib * mib;
        config.verbose = false;

        const auto result = ws::run_stream_benchmark(model_path, config, rounds);

        if (!result.success) {
            std::cerr << "  FAILED: " << result.error << '\n';
            ++failures;
        } else {
            std::cerr << "  OK — " << result.elapsed_seconds << " s, SSD "
                      << (result.ssd_bytes_read / (1024 * 1024)) << " MiB, "
                      << result.ssd_read_ops << " read ops\n";
        }

        const double page_mib =
            bench.page_size == 0 ? 0.0 : static_cast<double>(bench.page_size) / (1024.0 * 1024.0);
        std::fprintf(csv,
                     "%s,%.0f,%u,%zu,%zu,%zu,%u,%.2f,%.2f,%llu,%llu,%llu,%llu,%llu,%llu,%s\n",
                     bench.label,
                     page_mib,
                     bench.window,
                     bench.ram_mib,
                     vram_mib,
                     static_cast<std::size_t>(result.chunk_count),
                     result.rounds,
                     result.elapsed_seconds,
                     result.gpu_wait_seconds,
                     static_cast<unsigned long long>(result.ssd_bytes_read / (1024 * 1024)),
                     static_cast<unsigned long long>(result.ssd_read_ops),
                     static_cast<unsigned long long>(result.coalesced_pages),
                     static_cast<unsigned long long>(result.vram_bytes_uploaded / (1024 * 1024)),
                     static_cast<unsigned long long>(result.cache_hits),
                     static_cast<unsigned long long>(result.cache_misses),
                     result.success ? "yes" : "no");
        std::fflush(csv);
    }

    if (csv_file) {
        std::fclose(csv_file);
        std::cerr << "CSV written to " << csv_path << '\n';
    }

    return failures > 0 ? 1 : 0;
}
