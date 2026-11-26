#include "WeightStream/PerformanceSampler.h"
#include "WeightStream/Metrics.h"

#include <iostream>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <dlfcn.h>
#include <sys/times.h>
#include <unistd.h>
#endif

namespace ws {

namespace {

#ifdef _WIN32
using ModuleHandle = HMODULE;
ModuleHandle load_module(const char* name) { return LoadLibraryA(name); }
void* get_symbol(ModuleHandle mod, const char* name) { return reinterpret_cast<void*>(GetProcAddress(mod, name)); }
void close_module(ModuleHandle mod) { FreeLibrary(mod); }

std::uint64_t filetime_to_uint64(const FILETIME& ft) {
    ULARGE_INTEGER uli;
    uli.LowPart = ft.dwLowDateTime;
    uli.HighPart = ft.dwHighDateTime;
    return uli.QuadPart;
}
#else
using ModuleHandle = void*;
ModuleHandle load_module(const char* name) { return dlopen(name, RTLD_LAZY); }
void* get_symbol(ModuleHandle mod, const char* name) { return dlsym(mod, name); }
void close_module(ModuleHandle mod) { dlclose(mod); }
#endif

constexpr unsigned int kNvmlPcieUtilTxBytes = 0;
constexpr unsigned int kNvmlPcieUtilRxBytes = 1;

}  // namespace

PerformanceSampler::PerformanceSampler() = default;

bool PerformanceSampler::init_nvml_once() {
    if (nvml_initialized_) {
        return gpu_available_;
    }
    nvml_initialized_ = true;
    gpu_available_ = init_nvml();
    return gpu_available_;
}

PerformanceSampler::~PerformanceSampler() {
    shutdown_nvml();
}

bool PerformanceSampler::init_nvml() {
#ifdef _WIN32
    nvml_dll_ = load_module("nvml.dll");
#else
    nvml_dll_ = load_module("libnvidia-ml.so.1");
    if (nvml_dll_ == nullptr) {
        nvml_dll_ = load_module("libnvidia-ml.so");
    }
#endif
    if (nvml_dll_ == nullptr) {
        return false;
    }

    nvml_init_ = reinterpret_cast<NvmlInitFn>(get_symbol(static_cast<ModuleHandle>(nvml_dll_), "nvmlInit_v2"));
    if (nvml_init_ == nullptr) {
        nvml_init_ = reinterpret_cast<NvmlInitFn>(get_symbol(static_cast<ModuleHandle>(nvml_dll_), "nvmlInit"));
    }
    nvml_shutdown_ =
        reinterpret_cast<NvmlShutdownFn>(get_symbol(static_cast<ModuleHandle>(nvml_dll_), "nvmlShutdown"));
    nvml_device_get_handle_ = reinterpret_cast<NvmlDeviceGetHandleByIndexFn>(
        get_symbol(static_cast<ModuleHandle>(nvml_dll_), "nvmlDeviceGetHandleByIndex"));
    nvml_device_get_util_ = reinterpret_cast<NvmlDeviceGetUtilizationRatesFn>(
        get_symbol(static_cast<ModuleHandle>(nvml_dll_), "nvmlDeviceGetUtilizationRates"));
    nvml_device_get_mem_ = reinterpret_cast<NvmlDeviceGetMemoryInfoFn>(
        get_symbol(static_cast<ModuleHandle>(nvml_dll_), "nvmlDeviceGetMemoryInfo"));
    nvml_device_get_pcie_ = reinterpret_cast<NvmlDeviceGetPcieThroughputFn>(
        get_symbol(static_cast<ModuleHandle>(nvml_dll_), "nvmlDeviceGetPcieThroughput"));

    if (nvml_init_ == nullptr || nvml_shutdown_ == nullptr || nvml_device_get_handle_ == nullptr ||
        nvml_device_get_util_ == nullptr || nvml_device_get_mem_ == nullptr) {
        shutdown_nvml();
        return false;
    }

    if (nvml_init_() != 0) {
        shutdown_nvml();
        return false;
    }

    void* device = nullptr;
    if (nvml_device_get_handle_(0, &device) != 0) {
        shutdown_nvml();
        return false;
    }

    nvml_device_ = device;
    return true;
}

void PerformanceSampler::shutdown_nvml() {
    if (gpu_available_ && nvml_shutdown_ != nullptr) {
        nvml_shutdown_();
    }
    if (nvml_dll_ != nullptr) {
        close_module(static_cast<ModuleHandle>(nvml_dll_));
        nvml_dll_ = nullptr;
    }
    nvml_device_ = nullptr;
    gpu_available_ = false;
}

std::optional<PerformanceSampler::Sample> PerformanceSampler::sample() {
    init_nvml_once();
    Sample out{};

#ifdef _WIN32
    FILETIME idle_ft{};
    FILETIME kernel_ft{};
    FILETIME user_ft{};
    if (GetSystemTimes(&idle_ft, &kernel_ft, &user_ft)) {
        const std::uint64_t idle = filetime_to_uint64(idle_ft);
        const std::uint64_t kernel = filetime_to_uint64(kernel_ft);
        const std::uint64_t user = filetime_to_uint64(user_ft);
        const std::uint64_t total = (kernel - prev_kernel_) + (user - prev_user_);
        const std::uint64_t idle_delta = idle - prev_idle_;
        if (cpu_initialized_ && total > 0) {
            out.cpu_util_pct = 100.0 * (1.0 - static_cast<double>(idle_delta) / static_cast<double>(total));
            if (out.cpu_util_pct < 0.0) {
                out.cpu_util_pct = 0.0;
            }
            if (out.cpu_util_pct > 100.0) {
                out.cpu_util_pct = 100.0;
            }
        }
        prev_idle_ = idle;
        prev_kernel_ = kernel;
        prev_user_ = user;
        cpu_initialized_ = true;
    }
#else
    static long clock_ticks = sysconf(_SC_CLK_TCK);
    struct tms tm {};
    if (times(&tm) != static_cast<clock_t>(-1) && clock_ticks > 0) {
        const std::uint64_t user = static_cast<std::uint64_t>(tm.tms_utime);
        const std::uint64_t kernel = static_cast<std::uint64_t>(tm.tms_stime);
        const std::uint64_t total = (user - prev_user_) + (kernel - prev_kernel_);
        if (cpu_initialized_ && total > 0) {
            out.cpu_util_pct = 100.0 * static_cast<double>(total) / static_cast<double>(clock_ticks);
        }
        prev_user_ = user;
        prev_kernel_ = kernel;
        cpu_initialized_ = true;
    }
#endif

    if (!gpu_available_ || nvml_device_ == nullptr) {
        return out;
    }

    out.gpu_available = true;

    detail::NvmlUtilRates util{};
    if (nvml_device_get_util_(nvml_device_, &util) == 0) {
        out.gpu_compute_pct = util.gpu;
        out.gpu_mem_ctrl_pct = util.memory;
    }

    detail::NvmlMemoryInfo mem{};
    if (nvml_device_get_mem_(nvml_device_, &mem) == 0) {
        out.vram_used_bytes = mem.used;
        out.vram_total_bytes = mem.total;
    }

    if (nvml_device_get_pcie_ != nullptr) {
        unsigned int tx = 0;
        unsigned int rx = 0;
        if (nvml_device_get_pcie_(nvml_device_, kNvmlPcieUtilTxBytes, &tx) == 0) {
            out.pcie_tx_mib_s = tx / 1024;
        }
        if (nvml_device_get_pcie_(nvml_device_, kNvmlPcieUtilRxBytes, &rx) == 0) {
            out.pcie_rx_mib_s = rx / 1024;
        }
    }

    return out;
}

void print_performance_sample(const PerformanceSampler::Sample& sample) {
    std::cerr << "[ws_profile] CPU: " << sample.cpu_util_pct << " %";
    if (sample.gpu_available) {
        std::cerr << " | GPU compute: " << sample.gpu_compute_pct << " %"
                  << " | GPU mem ctrl: " << sample.gpu_mem_ctrl_pct << " %"
                  << " | VRAM: " << (sample.vram_used_bytes / (1024.0 * 1024.0)) << " / "
                  << (sample.vram_total_bytes / (1024.0 * 1024.0)) << " MiB";
        if (sample.pcie_tx_mib_s > 0 || sample.pcie_rx_mib_s > 0) {
            std::cerr << " | PCIe TX/RX: " << sample.pcie_tx_mib_s << " / " << sample.pcie_rx_mib_s
                      << " MiB/s";
        }
    } else {
        std::cerr << " | GPU: (NVML unavailable — use nvidia-smi)";
    }
    std::cerr << '\n';
}

void print_read_at_report(const Metrics& m) {
    const auto ops = m.byte_read_ops();
    std::cerr << "[ws_report] read_at(): " << ops << " calls, avg "
              << (m.avg_read_at_size() / (1024.0 * 1024.0)) << " MiB/call\n";
    std::cerr << "[ws_report] read_at wall: " << m.total_read_at_seconds() << " s | memcpy: "
              << m.total_read_at_memcpy_seconds() << " s\n";
    std::cerr << "[ws_report] page cache hits/misses: " << m.read_at_page_hits() << " / "
              << m.read_at_page_misses() << '\n';
    std::cerr << "[ws_report] SSD ops (page loader): " << m.ssd_read_ops() << " | coalesced pages: "
              << m.coalesced_pages() << " | SSD bytes: " << (m.ssd_bytes_read() / (1024.0 * 1024.0))
              << " MiB | SSD time: " << m.total_ssd_read_seconds() << " s\n";
    std::cerr << "[ws_report] RAM cache peaks: " << (m.working_set_peaks().peak_ram_bytes / (1024.0 * 1024.0))
              << " MiB, " << m.working_set_peaks().peak_simultaneous_pages << " pages\n";
}

void print_phase_report(const char* phase, double wall_seconds, double read_at_seconds) {
    const double llama_other_s = wall_seconds - read_at_seconds;
    std::cerr << "[ws_report] " << phase << ": " << wall_seconds << " s wall | read_at: " << read_at_seconds
              << " s | llama/other: " << (llama_other_s >= 0.0 ? llama_other_s : 0.0) << " s\n";
}

}  // namespace ws
