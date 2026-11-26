#pragma once

#include <cstdint>
#include <optional>

namespace ws {

namespace detail {

struct NvmlUtilRates {
    unsigned int gpu;
    unsigned int memory;
};

struct NvmlMemoryInfo {
    unsigned long long total;
    unsigned long long free;
    unsigned long long used;
};

}  // namespace detail

/// CPU + optional NVIDIA GPU samples (NVML via nvml.dll when present).
class PerformanceSampler {
public:
    struct Sample {
        double cpu_util_pct = 0.0;
        unsigned int gpu_compute_pct = 0;
        unsigned int gpu_mem_ctrl_pct = 0;
        std::uint64_t vram_used_bytes = 0;
        std::uint64_t vram_total_bytes = 0;
        unsigned int pcie_tx_mib_s = 0;
        unsigned int pcie_rx_mib_s = 0;
        bool gpu_available = false;
    };

    PerformanceSampler();
    ~PerformanceSampler();

    PerformanceSampler(const PerformanceSampler&) = delete;
    PerformanceSampler& operator=(const PerformanceSampler&) = delete;

    bool gpu_available() const { return gpu_available_; }
    std::optional<Sample> sample();

private:
    bool init_nvml_once();
    bool init_nvml();
    void shutdown_nvml();

    bool gpu_available_ = false;
    bool nvml_initialized_ = false;
    void* nvml_dll_ = nullptr;
    void* nvml_device_ = nullptr;

    using NvmlInitFn = int (*)();
    using NvmlShutdownFn = int (*)();
    using NvmlDeviceGetHandleByIndexFn = int (*)(unsigned int, void**);
    using NvmlDeviceGetUtilizationRatesFn = int (*)(void*, detail::NvmlUtilRates*);
    using NvmlDeviceGetMemoryInfoFn = int (*)(void*, detail::NvmlMemoryInfo*);
    using NvmlDeviceGetPcieThroughputFn = int (*)(void*, unsigned int, unsigned int*);

    NvmlInitFn nvml_init_ = nullptr;
    NvmlShutdownFn nvml_shutdown_ = nullptr;
    NvmlDeviceGetHandleByIndexFn nvml_device_get_handle_ = nullptr;
    NvmlDeviceGetUtilizationRatesFn nvml_device_get_util_ = nullptr;
    NvmlDeviceGetMemoryInfoFn nvml_device_get_mem_ = nullptr;
    NvmlDeviceGetPcieThroughputFn nvml_device_get_pcie_ = nullptr;

    bool cpu_initialized_ = false;
    std::uint64_t prev_idle_ = 0;
    std::uint64_t prev_kernel_ = 0;
    std::uint64_t prev_user_ = 0;
};

void print_performance_sample(const PerformanceSampler::Sample& sample);
void print_read_at_report(const class Metrics& metrics);
void print_phase_report(const char* phase, double wall_seconds, double read_at_seconds);

}  // namespace ws
