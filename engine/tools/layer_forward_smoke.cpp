#include "WeightStream/Config.h"
#include "WeightStream/GpuTouch.h"
#include "WeightStream/PageAutopsy.h"
#include "WeightStream/TensorIndex.h"
#include "WeightStream/VTMM.h"

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <regex>
#include <set>
#include <string>
#include <thread>
#include <typeinfo>
#include <vector>

namespace {

struct TokenResult {
    double io_s = 0.0;
    double compute_s = 0.0;
    double total_s = 0.0;
    std::uint64_t ssd_bytes = 0;
    std::uint64_t ssd_ops = 0;
    std::size_t ram_used_mib = 0;
    std::size_t peak_ram_mib = 0;
    std::size_t peak_combined_mib = 0;
    std::uint64_t vram_uploaded_mib = 0;
    std::uint32_t violations = 0;
};

struct RunOptions {
    std::uint32_t compute_ms = 0;
    bool use_gpu_touch = false;
    int gpu_passes = 6;
    bool verbose_layers = false;
};

int layer_number(const std::string& name) {
    static const std::regex pattern(R"(blk\.(\d+)\.)");
    std::smatch match;
    if (std::regex_search(name, match, pattern) && match.size() > 1) {
        return std::stoi(match[1].str());
    }
    if (name.find("token_embd") != std::string::npos) {
        return -1;
    }
    if (name.find("output") != std::string::npos) {
        return 9999;
    }
    return -2;
}

std::vector<int> build_page_layer_map(const ws::TensorIndex& index, std::size_t page_size, std::size_t page_count) {
    std::vector<int> layers(page_count, -2);
    for (std::size_t i = 0; i < index.size(); ++i) {
        const ws::TensorInfo* info = index.find_by_index(i);
        if (!info || info->size == 0 || page_size == 0) {
            continue;
        }
        const int layer = layer_number(info->name);
        const std::size_t first = static_cast<std::size_t>(info->offset / page_size);
        const std::size_t last = static_cast<std::size_t>((info->offset + info->size - 1) / page_size);
        for (std::size_t page = first; page <= last && page < page_count; ++page) {
            layers[page] = layer;
        }
    }
    return layers;
}

std::string label_for_layer(int layer) {
    if (layer == -1) {
        return "embed";
    }
    if (layer == 9999) {
        return "output";
    }
    if (layer >= 0) {
        return "blk." + std::to_string(layer);
    }
    return "misc";
}

void gpu_touch_layer_pages(ws::VTMM& vtmm, const std::vector<std::size_t>& pages, int passes, double& compute_s) {
    std::set<std::size_t> unique(pages.begin(), pages.end());
    const auto t0 = std::chrono::steady_clock::now();
    for (const std::size_t page : unique) {
        const auto handle = vtmm.get_page_by_index(page);
        if (!handle.ready() || handle.data == nullptr) {
            continue;
        }
        ws::gpu_touch_device(handle.data, handle.size, passes);
    }
    const auto t1 = std::chrono::steady_clock::now();
    compute_s += std::chrono::duration<double>(t1 - t0).count();
}

void print_usage() {
    std::cerr << "Usage: ws_layer_smoke <model.gguf> [options]\n";
    std::cerr << "1 token = forward profil inference (pages). Pas re-lecture intra-token.\n";
    std::cerr << "\nOptions:\n";
    std::cerr << "  --ram-mib N         Cache RAM (default 768)\n";
    std::cerr << "  --vram-mib N        Cache VRAM (default 512)\n";
    std::cerr << "  --page-mib N        Page size (default 32)\n";
    std::cerr << "  --window N          Prefetch (default 4)\n";
    std::cerr << "  --rounds N          Tokens (default 2)\n";
    std::cerr << "  --keep-hot          Garde pages en RAM/VRAM entre tokens (pas d'evict profil)\n";
    std::cerr << "  --ngl N             Pin embed + N layers GPU + output (comme llama)\n";
    std::cerr << "  --gpu               VRAM CUDA + touch D2D reel par couche\n";
    std::cerr << "  --gpu-passes N      Passes D2D par page/couche (default 6)\n";
    std::cerr << "  --compute-ms N      Sleep simule (ignore si --gpu)\n";
    std::cerr << "  --verbose-layers    Detail par couche (token 1)\n";
    std::cerr << "  --warm-hot          Pre-chauffe toutes les pages -ngl (si ca tient en RAM)\n";
    std::cerr << "  --preset chat       keep-hot, gpu, ngl=35, ram=8192, vram=11500\n";
    std::cerr << "  --preset oversized  ram=768 vram=384 evict agressif\n";
}

TokenResult run_token(ws::VTMM& vtmm,
                      const std::vector<std::size_t>& sequence,
                      const std::vector<int>& page_layer,
                      const RunOptions& opts) {
    const std::uint64_t ssd_before = vtmm.metrics().ssd_bytes_read();
    const std::uint64_t ops_before = vtmm.metrics().ssd_read_ops();
    const std::uint64_t vram_before = vtmm.metrics().vram_bytes_uploaded();

    vtmm.reset_forward_pass();

    const auto t0 = std::chrono::steady_clock::now();
    double compute_s = 0.0;

    int current_layer = -9999;
    std::size_t layer_page_count = 0;
    std::vector<std::size_t> layer_pages;
    auto layer_t0 = t0;

    auto finish_layer = [&](int layer) {
        if (layer_page_count == 0) {
            return;
        }
        const auto layer_t1 = std::chrono::steady_clock::now();
        const double layer_io_s = std::chrono::duration<double>(layer_t1 - layer_t0).count();

        if (opts.use_gpu_touch) {
            gpu_touch_layer_pages(vtmm, layer_pages, opts.gpu_passes, compute_s);
        } else if (opts.compute_ms > 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(opts.compute_ms));
            compute_s += opts.compute_ms / 1000.0;
        }

        if (opts.verbose_layers) {
            std::cerr << "  " << label_for_layer(layer) << "  page_steps=" << layer_page_count << "  io_ms="
                      << static_cast<int>(layer_io_s * 1000.0) << '\n';
        }

        layer_pages.clear();
        layer_page_count = 0;
    };

    for (const std::size_t page : sequence) {
        const int layer_id = page < page_layer.size() ? page_layer[page] : -2;

        if (layer_id != current_layer) {
            finish_layer(current_layer);
            current_layer = layer_id;
            layer_t0 = std::chrono::steady_clock::now();
        }

        try {
            if (!vtmm.get_page_by_index(page).ready()) {
                throw std::runtime_error("step page " + std::to_string(page) + ": " + vtmm.last_error());
            }
        } catch (const std::system_error& ex) {
            throw std::system_error(ex.code(),
                                    "get_page page=" + std::to_string(page) + ": " + ex.what());
        }
        layer_pages.push_back(page);
        ++layer_page_count;
    }
    finish_layer(current_layer);

    const auto t1 = std::chrono::steady_clock::now();
    TokenResult result;
    result.total_s = std::chrono::duration<double>(t1 - t0).count();
    result.compute_s = compute_s;
    result.io_s = std::max(0.0, result.total_s - compute_s);
    result.ssd_bytes = vtmm.metrics().ssd_bytes_read() - ssd_before;
    result.ssd_ops = vtmm.metrics().ssd_read_ops() - ops_before;
    result.vram_uploaded_mib = (vtmm.metrics().vram_bytes_uploaded() - vram_before) / (1024 * 1024);
    result.violations = static_cast<std::uint32_t>(vtmm.autopsy().ssd_invariant_violations().size());
    result.ram_used_mib = vtmm.ram_cache_used() / (1024 * 1024);
    const auto& peaks = vtmm.metrics().working_set_peaks();
    result.peak_ram_mib = peaks.peak_ram_bytes / (1024 * 1024);
    result.peak_combined_mib = peaks.peak_combined_bytes / (1024 * 1024);
    return result;
}

const char* verdict(double tok_s) {
    if (tok_s >= 0.5) {
        return "OK (chatable)";
    }
    if (tok_s >= 0.15) {
        return "limite";
    }
    return "trop lent";
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        print_usage();
        return 1;
    }

    const std::filesystem::path model_path = argv[1];
    enum class Preset { None, Oversized, Chat };
    Preset preset = Preset::Oversized;

    std::size_t ram_mib = 768;
    std::size_t vram_mib = 512;
    std::size_t page_mib = 32;
    std::uint32_t window = 4;
    std::uint32_t rounds = 2;
    std::uint32_t compute_ms = 0;
    bool keep_hot = false;
    bool use_gpu = false;
    int ngl = 0;
    int gpu_passes = 6;
    bool verbose_layers = false;
    bool warm_hot = false;

    for (int i = 2; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--ram-mib" && i + 1 < argc) {
            preset = Preset::None;
            ram_mib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (arg == "--vram-mib" && i + 1 < argc) {
            preset = Preset::None;
            vram_mib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (arg == "--page-mib" && i + 1 < argc) {
            page_mib = static_cast<std::size_t>(std::stoull(argv[++i]));
        } else if (arg == "--window" && i + 1 < argc) {
            window = static_cast<std::uint32_t>(std::stoul(argv[++i]));
        } else if (arg == "--rounds" && i + 1 < argc) {
            rounds = static_cast<std::uint32_t>(std::stoul(argv[++i]));
        } else if (arg == "--compute-ms" && i + 1 < argc) {
            compute_ms = static_cast<std::uint32_t>(std::stoul(argv[++i]));
        } else if (arg == "--keep-hot") {
            keep_hot = true;
        } else if (arg == "--ngl" && i + 1 < argc) {
            ngl = std::stoi(argv[++i]);
        } else if (arg == "--gpu") {
            use_gpu = true;
        } else if (arg == "--gpu-passes" && i + 1 < argc) {
            gpu_passes = std::stoi(argv[++i]);
        } else if (arg == "--verbose-layers") {
            verbose_layers = true;
        } else if (arg == "--warm-hot") {
            warm_hot = true;
        } else if (arg == "--preset" && i + 1 < argc) {
            const std::string p = argv[++i];
            if (p == "oversized") {
                preset = Preset::Oversized;
            } else if (p == "chat") {
                preset = Preset::Chat;
            }
        } else if (arg == "--help") {
            print_usage();
            return 0;
        }
    }

    if (preset == Preset::Oversized) {
        ram_mib = 768;
        vram_mib = 384;
        keep_hot = false;
        use_gpu = false;
        compute_ms = 35;
        ngl = 0;
    } else if (preset == Preset::Chat) {
        ram_mib = 8192;
        vram_mib = 11500;
        keep_hot = true;
        use_gpu = true;
        compute_ms = 0;
        ngl = 35;
    }

    if (use_gpu && !ws::gpu_touch_available()) {
        std::cerr << "CUDA indisponible — rebuild avec WEIGHTSTREAM_CUDA=ON\n";
        return 1;
    }

    if (!std::filesystem::exists(model_path)) {
        std::cerr << "Model not found: " << model_path << '\n';
        return 1;
    }

    const auto model_gib =
        static_cast<double>(std::filesystem::file_size(model_path)) / (1024.0 * 1024 * 1024);

    ws::Config config;
    config.verbose = true;
    config.ram_capacity = ram_mib * 1024 * 1024;
    config.vram_capacity = vram_mib * 1024 * 1024;
    config.page_size = page_mib * 1024 * 1024;
    config.prefetch_window = window;
    config.background_scheduler = true;
    config.profile_immediate_evict = !keep_hot;
    config.profile_pin_future_pages = !keep_hot;
    config.read_at_page_cache = true;
    config.cuda_vram = use_gpu;
    config.debug_ssd_invariant = !keep_hot;
    config.system_memory_guard = true;
    config.system_memory_guard_mode = ws::SystemMemoryGuardMode::Auto;
    config.load_priority_ngl = ngl;

    std::cerr << "\n=== ws_layer_smoke — forward layer-by-layer ===\n";
    std::cerr << "Model: " << model_path.filename().string() << " (~" << model_gib << " GiB)\n";
    std::cerr << "RAM " << ram_mib << " MiB | VRAM " << vram_mib << " MiB | prefetch " << window;
    if (keep_hot) {
        std::cerr << " | keep-hot (pages restent entre tokens)";
    } else {
        std::cerr << " | evict agressif apres chaque page";
    }
    if (ngl > 0) {
        std::cerr << " | -ngl " << ngl;
    }
    std::cerr << '\n';
    if (use_gpu) {
        std::cerr << "GPU: VRAM CUDA + touch D2D x" << gpu_passes << " par couche\n";
    } else if (compute_ms > 0) {
        std::cerr << "Compute: sleep " << compute_ms << " ms/couche (simule)\n";
    } else {
        std::cerr << "Compute: aucun\n";
    }
    std::cerr << '\n';

    ws::VTMM vtmm(config);
    if (!vtmm.load_model(model_path)) {
        std::cerr << "load_model failed: " << vtmm.last_error() << '\n';
        return 1;
    }
    if (!vtmm.build_inference_profile()) {
        std::cerr << "build_inference_profile failed: " << vtmm.last_error() << '\n';
        return 1;
    }
    if (ngl > 0 && warm_hot) {
        std::cerr << "[ws_layer_smoke] Pre-chauffage pages hot (-ngl)…\n";
        if (!vtmm.warm_priority_pages()) {
            std::cerr << "warm_priority_pages failed: " << vtmm.last_error() << '\n';
            return 1;
        }
    } else if (ngl > 0) {
        std::cerr << "[ws_layer_smoke] -ngl " << ngl << " actif (pin hot pendant forward, pas de warm massif)\n";
    }

    const auto raw_sequence = vtmm.access_sequence();
    std::vector<std::size_t> sequence =
        keep_hot ? ws::Planner::dedupe_first_access(raw_sequence) : raw_sequence;
    const auto page_layers = build_page_layer_map(vtmm.tensor_index(), config.page_size, vtmm.chunk_count());

    std::cerr << "Forward: " << sequence.size() << " page-steps";
    if (keep_hot && sequence.size() != raw_sequence.size()) {
        std::cerr << " (dedupe keep-hot, etait " << raw_sequence.size() << ")";
    }
    std::cerr << ", " << vtmm.chunk_count() << " pages\n\n";

    RunOptions run_opts;
    run_opts.compute_ms = compute_ms;
    run_opts.use_gpu_touch = use_gpu;
    run_opts.gpu_passes = gpu_passes;
    run_opts.verbose_layers = verbose_layers;

    std::vector<TokenResult> results;
    results.reserve(rounds);

    for (std::uint32_t round = 0; round < rounds; ++round) {
        std::cerr << "--- Token " << (round + 1) << " ---\n";
        if (round > 0) {
            std::cerr << "  cache RAM avant token: " << (vtmm.ram_cache_used() / (1024 * 1024)) << " MiB\n";
        }
        const bool verbose = verbose_layers && round == 0;
        run_opts.verbose_layers = verbose;
        try {
            results.push_back(run_token(vtmm, sequence, page_layers, run_opts));
        } catch (const std::system_error& ex) {
            std::cerr << "FAILED [system_error code=" << ex.code().value()
                      << " cat=" << ex.code().category().name() << "]: " << ex.what() << '\n';
            return 1;
        } catch (const std::exception& ex) {
            std::cerr << "FAILED [" << typeid(ex).name() << "]: " << ex.what() << '\n';
            return 1;
        }

        const auto& r = results.back();
        const double tok_s = r.total_s > 0.0 ? (1.0 / r.total_s) : 0.0;
        std::cerr << "  total=" << r.total_s << " s  io=" << r.io_s << " s  gpu~" << r.compute_s << " s\n";
        std::cerr << "  SSD=" << (r.ssd_bytes / (1024 * 1024)) << " MiB (" << r.ssd_ops << " ops)";
        if (use_gpu) {
            std::cerr << "  VRAM_upload=" << r.vram_uploaded_mib << " MiB";
        }
        std::cerr << "  RAM_resident=" << r.ram_used_mib << " MiB\n";
        std::cerr << "  => " << tok_s << " tok/s  [" << verdict(tok_s) << "]\n\n";
    }

    if (results.size() >= 2 && keep_hot) {
        const double r2_ssd = results[1].ssd_bytes / (1024.0 * 1024.0);
        const double speedup = results[0].total_s / std::max(results[1].total_s, 1e-9);
        std::cerr << "--- keep-hot ---\n";
        std::cerr << "Token 2 SSD: " << static_cast<int>(r2_ssd) << " MiB (0 = tout en cache)\n";
        std::cerr << "Speedup token2 vs token1: " << speedup << "x\n";
    }

    return 0;
}
