#include "WeightStream/SSDReader.h"
#include "WeightStream/VTMM.h"

#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <optional>
#include <random>
#include <string>
#include <vector>

namespace {

void usage(const char* prog) {
    std::cerr << "Usage: " << prog << " <model.gguf> [--samples N] [--seed S] [--ram-gib N] [--paranoid]\n"
              << "  Verifies VTMM::read_at() (page cache) == direct SSD for random reads.\n"
              << "  Default RAM cache: 32 GiB (realistic RTX 3060 + 32 GB host).\n";
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        usage(argv[0]);
        return 1;
    }

    std::string model_path = argv[1];
    std::size_t sample_count = 5000;
    std::uint64_t seed = 42;
    std::optional<std::size_t> only_sample;
    std::size_t warmup_count = 0;
    bool paranoid = false;
    std::size_t ram_gib = 32;

    for (int i = 2; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--samples" && i + 1 < argc) {
            sample_count = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (arg == "--seed" && i + 1 < argc) {
            seed = static_cast<std::uint64_t>(std::stoull(argv[++i]));
        } else if (arg == "--ram-gib" && i + 1 < argc) {
            ram_gib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (arg == "--only" && i + 1 < argc) {
            only_sample = static_cast<std::size_t>(std::stoull(argv[++i]));
            sample_count = *only_sample + 1;
        } else if (arg == "--warmup" && i + 1 < argc) {
            warmup_count = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (arg == "--paranoid") {
            paranoid = true;
        } else {
            usage(argv[0]);
            return 1;
        }
    }

    ws::Config cfg;
    cfg.verbose = false;
    cfg.cuda_vram = false;
    cfg.debug_ssd_invariant = false;
    cfg.background_scheduler = false;
    cfg.debug_cache_invariants = false;
    cfg.debug_paranoid = paranoid;
    cfg.coalesce_max_bytes = 0;
    cfg.ram_capacity = ram_gib * 1024ULL * 1024 * 1024;

    std::cerr << "[ws_read_equiv] RAM cache " << ram_gib << " GiB, samples=" << sample_count << " seed=" << seed
              << '\n';

    ws::VTMM vtmm(cfg);
    if (!vtmm.load_model(model_path)) {
        std::cerr << "load_model failed: " << vtmm.last_error() << '\n';
        return 1;
    }

    ws::GGUFReader gguf(model_path);
    ws::SSDReader direct(std::move(gguf));
    const auto file_size = std::filesystem::file_size(model_path);
    if (file_size == 0) {
        std::cerr << "empty file\n";
        return 1;
    }

    std::mt19937_64 rng(seed);
    std::uniform_int_distribution<std::uint64_t> offset_dist(0, file_size - 1);
    std::uniform_int_distribution<std::uint64_t> size_dist(1, 4 * 1024 * 1024);

    std::vector<std::byte> direct_buf;
    std::vector<std::byte> vtmm_buf;

    for (std::size_t i = 0; i < sample_count; ++i) {
        if (i % 500 == 0 && i > 0) {
            std::cerr << "sample " << i << '/' << sample_count << '\n';
        }

        std::size_t len = static_cast<std::size_t>(size_dist(rng));
        if (len > file_size) {
            len = static_cast<std::size_t>(file_size);
        }

        std::uint64_t offset = offset_dist(rng);
        if (offset + len > file_size) {
            offset = file_size - len;
        }

        if (only_sample && i != *only_sample) {
            continue;
        }

        const bool verify = !warmup_count || i >= warmup_count;

        if (!direct.read_bytes(offset, len, direct_buf)) {
            std::cerr << "direct read failed at offset " << offset << " len " << len << '\n';
            return 1;
        }

        if (!verify) {
            vtmm_buf.resize(len);
            if (!vtmm.read_at(offset, vtmm_buf.data(), len)) {
                std::cerr << "warmup read_at failed at sample " << i << '\n';
                return 1;
            }
            continue;
        }

        vtmm_buf.resize(len);
        if (!vtmm.read_at(offset, vtmm_buf.data(), len)) {
            std::cerr << "read_at failed at sample " << i << " offset " << offset << " len " << len << ": "
                      << vtmm.last_error() << '\n';
            return 1;
        }

        if (direct_buf != vtmm_buf) {
            std::cerr << "MISMATCH at sample " << i << " offset " << offset << " len " << len << '\n';
            for (std::size_t b = 0; b < len; ++b) {
                if (direct_buf[b] != vtmm_buf[b]) {
                    std::cerr << "  first diff byte " << b << " direct=" << static_cast<int>(direct_buf[b])
                              << " vtmm=" << static_cast<int>(vtmm_buf[b]) << '\n';
                    break;
                }
            }
            return 1;
        }
    }

    const auto& m = vtmm.metrics();
    std::cerr << "PASS: " << (only_sample ? 1 : sample_count) << " random reads identical (seed=" << seed << ")\n";
    std::cerr << "  read_at ops: " << m.byte_read_ops() << '\n';
    std::cerr << "  page hits/misses: " << m.read_at_page_hits() << " / " << m.read_at_page_misses() << '\n';
    std::cerr << "  SSD loader ops: " << m.ssd_read_ops() << " (coalesced batches)\n";
    std::cerr << "  SSD bytes: " << (m.ssd_bytes_read() / (1024.0 * 1024.0)) << " MiB\n";
    return 0;
}
