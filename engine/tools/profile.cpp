#include "WeightStream/Config.h"
#include "WeightStream/VTMM.h"

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <iostream>

namespace {

void print_usage() {
    std::cerr << "Usage: ws_profile <command> <model.gguf> [options]\n";
    std::cerr << "Commands:\n";
    std::cerr << "  record <model> --out profile.wsprofile   Record linear access trace\n";
    std::cerr << "  infer  <model> --out profile.wsprofile   Build layer-order profile (no run)\n";
    std::cerr << "  replay <model> --profile file.wsprofile  Replay learned order\n";
    std::cerr << "Options: --vram-mib N --ram-mib N --page-mib N --window N --rounds N --report-prefix path\n";
}

ws::Config parse_config(int argc, char** argv, int start_index) {
    ws::Config config;
    config.verbose = true;

    for (int i = start_index; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--vram-mib" && i + 1 < argc) {
            config.vram_capacity = static_cast<std::size_t>(std::stoull(argv[++i])) * 1024 * 1024;
        } else if (arg == "--ram-mib" && i + 1 < argc) {
            config.ram_capacity = static_cast<std::size_t>(std::stoull(argv[++i])) * 1024 * 1024;
        } else if (arg == "--page-mib" && i + 1 < argc) {
            config.page_size = static_cast<std::size_t>(std::stoull(argv[++i])) * 1024 * 1024;
        } else if (arg == "--window" && i + 1 < argc) {
            config.prefetch_window = static_cast<std::uint32_t>(std::stoul(argv[++i]));
        } else if (arg == "--no-evict") {
            config.profile_immediate_evict = false;
        }
    }

    return config;
}

int run_stream(ws::VTMM& manager, std::uint32_t rounds, const std::filesystem::path& report_prefix) {
    const auto sequence = manager.access_sequence();
    if (sequence.empty()) {
        std::cerr << "Empty access sequence\n";
        return 1;
    }

    std::cerr << "Streaming " << sequence.size() << " steps x " << rounds << " round(s)\n";

    const auto t0 = std::chrono::steady_clock::now();

    for (std::uint32_t round = 0; round < rounds; ++round) {
        for (const std::size_t chunk : sequence) {
            const auto handle = manager.get_page_by_index(chunk);
            if (!handle.ready()) {
                std::cerr << "Chunk #" << chunk << " failed: " << manager.last_error() << '\n';
                return 1;
            }
        }
    }

    const auto t1 = std::chrono::steady_clock::now();
    const auto& m = manager.metrics();

    std::cerr << "\n--- Metrics ---\n";
    std::cerr << "Steps:               " << sequence.size() * rounds << '\n';
    std::cerr << "SSD bytes read:      " << m.ssd_bytes_read() / (1024 * 1024) << " MiB\n";
    std::cerr << "SSD read ops:        " << m.ssd_read_ops() << '\n';
    std::cerr << "Coalesced pages:     " << m.coalesced_pages() << '\n';
    std::cerr << "Cache hits:          " << m.cache_hits() << '\n';
    std::cerr << "Cache misses:        " << m.cache_misses() << '\n';
    std::cerr << "GPU wait (s):        " << m.total_gpu_wait_seconds() << '\n';
    std::cerr << "Elapsed (s):         " << std::chrono::duration<double>(t1 - t0).count() << '\n';

    if (!report_prefix.empty()) {
        if (manager.write_autopsy_reports(report_prefix)) {
            std::cerr << "Autopsy reports: " << report_prefix.string() << ".{txt,html}\n";
        } else {
            std::cerr << "Failed to write autopsy reports\n";
            return 1;
        }
    }

    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        print_usage();
        return 1;
    }

    const std::string command = argv[1];
    const std::filesystem::path model_path = argv[2];

    std::filesystem::path profile_out;
    std::filesystem::path profile_in;
    std::filesystem::path report_prefix;
    std::uint32_t rounds = 1;

    for (int i = 3; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--out" && i + 1 < argc) {
            profile_out = argv[++i];
        } else if (arg == "--profile" && i + 1 < argc) {
            profile_in = argv[++i];
        } else if (arg == "--report-prefix" && i + 1 < argc) {
            report_prefix = argv[++i];
        } else if (arg == "--rounds" && i + 1 < argc) {
            rounds = static_cast<std::uint32_t>(std::stoul(argv[++i]));
        }
    }

    ws::Config config = parse_config(argc, argv, 3);

    if (command == "record") {
        config.profile_mode = ws::ProfileMode::Record;
        ws::VTMM manager(config);
        if (!manager.load_model(model_path)) {
            std::cerr << manager.last_error() << '\n';
            return 1;
        }

        for (std::size_t i = 0; i < manager.chunk_count(); ++i) {
            if (!manager.get_page_by_index(i).ready()) {
                std::cerr << "Record failed at chunk " << i << '\n';
                return 1;
            }
        }

        if (!manager.finalize_profile(profile_out)) {
            std::cerr << manager.last_error() << '\n';
            return 1;
        }
        std::cerr << "Recorded profile: " << profile_out << '\n';
        return 0;
    }

    if (command == "infer") {
        ws::VTMM manager(config);
        if (!manager.load_model(model_path)) {
            std::cerr << manager.last_error() << '\n';
            return 1;
        }
        if (!manager.build_inference_profile()) {
            std::cerr << manager.last_error() << '\n';
            return 1;
        }

        if (const auto* profile = manager.profile()) {
            if (!profile_out.empty()) {
                profile->save(profile_out);
                std::cerr << "Inference profile saved: " << profile_out << " ("
                          << profile->forward_order.size() << " steps)\n";
            }
        }

        config.profile_mode = ws::ProfileMode::Replay;
        return run_stream(manager, rounds, report_prefix);
    }

    if (command == "replay") {
        if (profile_in.empty()) {
            std::cerr << "replay requires --profile\n";
            return 1;
        }

        config.profile_mode = ws::ProfileMode::Replay;
        ws::VTMM manager(config);
        if (!manager.load_model(model_path)) {
            std::cerr << manager.last_error() << '\n';
            return 1;
        }
        if (!manager.load_profile(profile_in)) {
            std::cerr << manager.last_error() << '\n';
            return 1;
        }

        return run_stream(manager, rounds, report_prefix);
    }

    print_usage();
    return 1;
}
