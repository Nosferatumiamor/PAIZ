#include "WeightStream/Config.h"
#include "WeightStream/VTMM.h"

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <iostream>

namespace {

void print_usage() {
    std::cerr << "Usage: ws_report <command> <model.gguf> [options]\n";
    std::cerr << "Commands:\n";
    std::cerr << "  infer  <model> --report-prefix path   Run inference-order stream + autopsy\n";
    std::cerr << "  replay <model> --profile f.wsprofile --report-prefix path\n";
    std::cerr << "Options: --vram-mib N --ram-mib N --page-mib N --window N --rounds N\n";
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

void print_autopsy_summary(const ws::PageAutopsyCollector& autopsy) {
    std::uint32_t redundant_pages = 0;
    std::uint32_t hot_pages = 0;
    std::uint32_t total_ssd_loads = 0;

    for (const auto& e : autopsy.entries()) {
        total_ssd_loads += e.loads_from_ssd;
        if (e.loads_from_ssd > 1) {
            ++redundant_pages;
        } else if (e.loads_from_ssd == 1 && e.accesses >= 4) {
            ++hot_pages;
        }
    }

    std::cerr << "\n--- Autopsy summary ---\n";
    std::cerr << "Total SSD loads (all pages): " << total_ssd_loads << '\n';
    std::cerr << "Pages with redundant SSD reads: " << redundant_pages << '\n';
    std::cerr << "HOT candidates (1 load, 4+ acc): " << hot_pages << '\n';

    const auto violations = autopsy.ssd_invariant_violations();
    if (!violations.empty()) {
        std::cerr << "SSD invariant violations (loads > 1): " << violations.size() << " pages\n";
    } else {
        std::cerr << "SSD invariant OK: all pages have loads_from_ssd <= 1\n";
    }
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

    const auto& peaks = m.working_set_peaks();
    std::cerr << "\n--- Peak Working Set ---\n";
    std::cerr << "Peak RAM residency:      " << peaks.peak_ram_bytes / (1024 * 1024) << " MiB\n";
    std::cerr << "Peak VRAM residency:     " << peaks.peak_vram_bytes / (1024 * 1024) << " MiB\n";
    std::cerr << "Peak combined residency:   " << peaks.peak_combined_bytes / (1024 * 1024) << " MiB\n";
    std::cerr << "Peak simultaneous pages:   " << peaks.peak_simultaneous_pages << '\n';

    print_autopsy_summary(manager.autopsy());

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

    std::filesystem::path profile_in;
    std::filesystem::path report_prefix;
    std::uint32_t rounds = 1;

    for (int i = 3; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--profile" && i + 1 < argc) {
            profile_in = argv[++i];
        } else if (arg == "--report-prefix" && i + 1 < argc) {
            report_prefix = argv[++i];
        } else if (arg == "--rounds" && i + 1 < argc) {
            rounds = static_cast<std::uint32_t>(std::stoul(argv[++i]));
        }
    }

    ws::Config config = parse_config(argc, argv, 3);

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
