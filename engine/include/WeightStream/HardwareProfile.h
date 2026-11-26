#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace ws {

/// Host + GPU snapshot for onboarding and size estimates.
struct HardwareProfile {
    std::string cpu_name;
    std::uint32_t cpu_logical_cores = 0;

    std::size_t ram_total_bytes = 0;
    std::size_t ram_avail_bytes = 0;

    bool has_gpu = false;
    std::string gpu_name;
    std::size_t gpu_vram_total_bytes = 0;
    std::size_t gpu_vram_free_bytes = 0;

    /// Practical model payload (weights only, GiB) without WeightStream tiering.
    double native_model_gib = 0.0;

    /// Comfortable streaming target (RAM/VRAM tiering, some SSD).
    double streaming_comfort_gib = 0.0;

    /// Stretch goal (heavy SSD streaming — slower but possible).
    double streaming_stretch_gib = 0.0;

    /// Multiplier vs native (comfort / native).
    double comfort_multiplier = 1.0;
};

/// Probe CPU, RAM, and first NVIDIA GPU (CUDA / NVML).
HardwareProfile detect_hardware();

/// Fill estimate fields from detected RAM/VRAM.
void fill_streaming_estimates(HardwareProfile& profile);

/// Human-readable report (French).
std::string format_hardware_report(const HardwareProfile& profile);

/// Compact JSON for the test UI.
std::string hardware_profile_json(const HardwareProfile& profile);

}  // namespace ws
