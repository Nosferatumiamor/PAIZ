#include "WeightStream/Config.h"
#include "WeightStream/VTMM.h"

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

struct RunResult {
    std::size_t vram_mib = 0;
    std::size_t ram_mib = 0;
    std::uint64_t ssd_mib = 0;
    std::uint64_t ssd_loads = 0;
    std::uint32_t violations = 0;
    double elapsed_s = 0.0;
    std::size_t peak_ram_mib = 0;
    std::size_t peak_vram_mib = 0;
    std::size_t peak_combined_mib = 0;
    std::size_t peak_pages = 0;
};

void print_usage() {
    std::cerr << "Usage: ws_degrade <model.gguf> [options]\n";
    std::cerr << "Options:\n";
    std::cerr << "  --ram-mib N          Fixed RAM (default 8192)\n";
    std::cerr << "  --vram-mib-list LIST Comma-separated VRAM sizes in MiB (default 12288,10240,8192,6144,4096)\n";
    std::cerr << "  --page-mib N         Page size (default 32)\n";
    std::cerr << "  --csv FILE           Output CSV path (default reports/vram_degradation_curve.csv)\n";
}

std::vector<std::size_t> parse_mib_list(const std::string& text) {
    std::vector<std::size_t> values;
    std::stringstream stream(text);
    std::string item;
    while (std::getline(stream, item, ',')) {
        if (!item.empty()) {
            values.push_back(static_cast<std::size_t>(std::stoull(item)));
        }
    }
    return values;
}

RunResult run_once(const std::filesystem::path& model_path, std::size_t vram_mib, std::size_t ram_mib, std::size_t page_mib) {
    ws::Config config;
    config.verbose = false;
    config.vram_capacity = vram_mib * 1024 * 1024;
    config.ram_capacity = ram_mib * 1024 * 1024;
    config.page_size = page_mib * 1024 * 1024;

    ws::VTMM manager(config);
    if (!manager.load_model(model_path)) {
        throw std::runtime_error(manager.last_error());
    }
    if (!manager.build_inference_profile()) {
        throw std::runtime_error(manager.last_error());
    }

    const auto sequence = manager.access_sequence();
    const auto t0 = std::chrono::steady_clock::now();
    for (const std::size_t chunk : sequence) {
        if (!manager.get_page_by_index(chunk).ready()) {
            throw std::runtime_error("chunk failed: " + manager.last_error());
        }
    }
    const auto t1 = std::chrono::steady_clock::now();

    RunResult result;
    result.vram_mib = vram_mib;
    result.ram_mib = ram_mib;
    result.ssd_mib = manager.metrics().ssd_bytes_read() / (1024 * 1024);
    result.elapsed_s = std::chrono::duration<double>(t1 - t0).count();

    std::uint32_t total_loads = 0;
    for (const auto& entry : manager.autopsy().entries()) {
        total_loads += entry.loads_from_ssd;
    }
    result.ssd_loads = total_loads;
    result.violations = static_cast<std::uint32_t>(manager.autopsy().ssd_invariant_violations().size());

    const auto& peaks = manager.metrics().working_set_peaks();
    result.peak_ram_mib = peaks.peak_ram_bytes / (1024 * 1024);
    result.peak_vram_mib = peaks.peak_vram_bytes / (1024 * 1024);
    result.peak_combined_mib = peaks.peak_combined_bytes / (1024 * 1024);
    result.peak_pages = peaks.peak_simultaneous_pages;

    return result;
}

void write_csv(const std::filesystem::path& path, const std::vector<RunResult>& results) {
    std::ofstream out(path);
    if (!out) {
        throw std::runtime_error("failed to write csv: " + path.string());
    }

    out << "vram_mib,ram_mib,ssd_mib,ssd_loads,violations,elapsed_s,"
           "peak_ram_mib,peak_vram_mib,peak_combined_mib,peak_simultaneous_pages\n";
    for (const auto& r : results) {
        out << r.vram_mib << ',' << r.ram_mib << ',' << r.ssd_mib << ',' << r.ssd_loads << ','
            << r.violations << ',' << r.elapsed_s << ',' << r.peak_ram_mib << ',' << r.peak_vram_mib
            << ',' << r.peak_combined_mib << ',' << r.peak_pages << '\n';
    }
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        print_usage();
        return 1;
    }

    const std::filesystem::path model_path = argv[1];
    std::size_t ram_mib = 8192;
    std::size_t page_mib = 32;
    std::string vram_list = "12288,10240,8192,6144,4096";
    std::filesystem::path csv_path = "reports/vram_degradation_curve.csv";

    for (int i = 2; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--ram-mib" && i + 1 < argc) {
            ram_mib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (arg == "--vram-mib-list" && i + 1 < argc) {
            vram_list = argv[++i];
        } else if (arg == "--page-mib" && i + 1 < argc) {
            page_mib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (arg == "--csv" && i + 1 < argc) {
            csv_path = argv[++i];
        }
    }

    const auto vram_sizes = parse_mib_list(vram_list);
    if (vram_sizes.empty()) {
        std::cerr << "Empty VRAM list\n";
        return 1;
    }

    std::vector<RunResult> results;
    results.reserve(vram_sizes.size());

    std::cerr << "VRAM degradation curve — RAM " << ram_mib << " MiB, model " << model_path.filename().string()
              << '\n';
    std::cerr << "VRAM(MiB)  SSD(MiB)  Loads  Viol  Time(s)  PeakRAM  PeakVRAM  PeakComb  PeakPages\n";

    for (const std::size_t vram_mib : vram_sizes) {
        std::cerr << "Running VRAM " << vram_mib << " MiB...\n";
        try {
            const auto result = run_once(model_path, vram_mib, ram_mib, page_mib);
            results.push_back(result);
            std::cerr << vram_mib << "          " << result.ssd_mib << "       " << result.ssd_loads << "    "
                      << result.violations << "     " << result.elapsed_s << "   " << result.peak_ram_mib << "       "
                      << result.peak_vram_mib << "        " << result.peak_combined_mib << "       "
                      << result.peak_pages << '\n';
        } catch (const std::exception& ex) {
            std::cerr << "FAILED VRAM " << vram_mib << " MiB: " << ex.what() << '\n';
            return 1;
        }
    }

    std::filesystem::create_directories(csv_path.parent_path());
    write_csv(csv_path, results);
    std::cerr << "\nCSV saved: " << csv_path << '\n';
    return 0;
}
