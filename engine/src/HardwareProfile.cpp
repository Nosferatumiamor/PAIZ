#include "WeightStream/HardwareProfile.h"

#include "WeightStream/SystemMemoryGuard.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <sstream>
#include <string>

#ifdef WEIGHTSTREAM_HAS_CUDA
#include <cuda_runtime.h>
#endif

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#elif defined(__linux__)
#include <fstream>
#include <thread>
#endif

namespace ws {

namespace {

double bytes_to_gib(std::size_t bytes) {
    return static_cast<double>(bytes) / (1024.0 * 1024.0 * 1024.0);
}

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        if (c == '"' || c == '\\') {
            out.push_back('\\');
        }
        out.push_back(c);
    }
    return out;
}

#if defined(_WIN32)
std::string read_cpu_name() {
    HKEY key = nullptr;
    if (RegOpenKeyExA(HKEY_LOCAL_MACHINE,
                      "HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0",
                      0,
                      KEY_READ,
                      &key) != ERROR_SUCCESS) {
        return "CPU (Windows)";
    }

    char buffer[256]{};
    DWORD size = sizeof(buffer);
    DWORD type = REG_SZ;
    if (RegQueryValueExA(key, "ProcessorNameString", nullptr, &type,
                         reinterpret_cast<LPBYTE>(buffer), &size) != ERROR_SUCCESS) {
        RegCloseKey(key);
        return "CPU (Windows)";
    }
    RegCloseKey(key);
    return buffer;
}

std::uint32_t logical_cores() {
    SYSTEM_INFO info{};
    GetNativeSystemInfo(&info);
    return info.dwNumberOfProcessors;
}
#elif defined(__linux__)
std::string read_cpu_name() {
    std::ifstream cpuinfo("/proc/cpuinfo");
    std::string line;
    while (std::getline(cpuinfo, line)) {
        if (line.rfind("model name", 0) == 0) {
            const auto pos = line.find(':');
            if (pos != std::string::npos && pos + 2 < line.size()) {
                return line.substr(pos + 2);
            }
        }
    }
    return "CPU (Linux)";
}

std::uint32_t logical_cores() {
    return static_cast<std::uint32_t>(std::thread::hardware_concurrency());
}
#else
std::string read_cpu_name() { return "CPU"; }
std::uint32_t logical_cores() { return 1; }
#endif

void probe_cuda_gpu(HardwareProfile& profile) {
#ifdef WEIGHTSTREAM_HAS_CUDA
    int count = 0;
    if (cudaGetDeviceCount(&count) != cudaSuccess || count <= 0) {
        return;
    }

    cudaDeviceProp prop{};
    if (cudaGetDeviceProperties(&prop, 0) != cudaSuccess) {
        return;
    }

    profile.has_gpu = true;
    profile.gpu_name = prop.name;
    profile.gpu_vram_total_bytes = static_cast<std::size_t>(prop.totalGlobalMem);

    std::size_t free_bytes = 0;
    std::size_t total_bytes = 0;
    if (cudaMemGetInfo(&free_bytes, &total_bytes) == cudaSuccess) {
        profile.gpu_vram_free_bytes = free_bytes;
        if (total_bytes > 0) {
            profile.gpu_vram_total_bytes = total_bytes;
        }
    }
#else
    (void)profile;
#endif
}

}  // namespace

HardwareProfile detect_hardware() {
    HardwareProfile profile;
    profile.cpu_name = read_cpu_name();
    profile.cpu_logical_cores = logical_cores();

    const auto mem = SystemMemoryGuard::query();
    profile.ram_total_bytes = mem.total_bytes;
    profile.ram_avail_bytes = mem.avail_bytes;

    probe_cuda_gpu(profile);
    fill_streaming_estimates(profile);
    return profile;
}

void fill_streaming_estimates(HardwareProfile& profile) {
    const double ram_gib = bytes_to_gib(profile.ram_total_bytes);
    const double ram_avail_gib = bytes_to_gib(profile.ram_avail_bytes);
    const double vram_gib = bytes_to_gib(profile.gpu_vram_total_bytes);

    double native_gpu = 0.0;
    if (profile.has_gpu && vram_gib > 0.5) {
        native_gpu = vram_gib * 0.72;
    }

    const double native_cpu = std::max(0.0, (ram_gib - 2.0) * 0.55);
    profile.native_model_gib = std::max(native_gpu, native_cpu);

    double comfort = std::max(0.0, ram_gib * 0.78 - 2.0);
    if (profile.has_gpu && vram_gib > 0.5) {
        comfort = std::max(comfort, vram_gib * 0.70 + ram_gib * 0.30);
    }
    comfort = std::min(comfort, std::max(ram_avail_gib + ram_gib * 0.40, native_cpu));
    profile.streaming_comfort_gib = comfort;

    double stretch = comfort * 2.0;
    if (ram_gib >= 8.0) {
        stretch = std::max(stretch, comfort * 1.6);
    }
    if (ram_gib >= 16.0) {
        stretch = std::max(stretch, ram_gib * 1.2);
    }
    profile.streaming_stretch_gib = stretch;

    if (profile.native_model_gib > 0.5) {
        profile.comfort_multiplier = comfort / profile.native_model_gib;
    } else {
        profile.comfort_multiplier = 1.0;
    }
}

std::string format_hardware_report(const HardwareProfile& profile) {
    std::ostringstream out;
    out << "=== Matériel détecté ===\n";
    out << "CPU : " << profile.cpu_name << " (" << profile.cpu_logical_cores << " threads)\n";
    out << "RAM : " << static_cast<int>(bytes_to_gib(profile.ram_total_bytes) + 0.5) << " GiB total, "
        << static_cast<int>(bytes_to_gib(profile.ram_avail_bytes) + 0.5) << " GiB libre\n";

    if (profile.has_gpu) {
        out << "GPU : " << profile.gpu_name << " — VRAM "
            << static_cast<int>(bytes_to_gib(profile.gpu_vram_total_bytes) + 0.5) << " GiB ("
            << static_cast<int>(bytes_to_gib(profile.gpu_vram_free_bytes) + 0.5) << " GiB libre)\n";
    } else {
        out << "GPU : non détecté (inférence CPU)\n";
    }

    out << "\n=== Estimation modèles GGUF (poids seuls, ordre de grandeur) ===\n";
    out << "Sans streaming (classique)     : ~" << static_cast<int>(profile.native_model_gib + 0.5)
        << " GiB\n";
    out << "Avec WeightStream (confort)    : ~" << static_cast<int>(profile.streaming_comfort_gib + 0.5)
        << " GiB";
    if (profile.comfort_multiplier >= 1.2) {
        out << " (×" << static_cast<int>(profile.comfort_multiplier * 10.0 + 0.5) / 10.0 << " vs natif)";
    }
    out << "\n";
    out << "Stretch SSD (lent mais possible): ~" << static_cast<int>(profile.streaming_stretch_gib + 0.5)
        << " GiB\n";

    out << "\nNote : Gemma 1B sur machine faible ou gros Qwen sur 3060+32Go relèvent de cette logique.\n";
    out << "Le stretch suppose un SSD correct et de la patience (I/O << VRAM).\n";
    return out.str();
}

std::string hardware_profile_json(const HardwareProfile& profile) {
    char buf[512];
    std::snprintf(buf,
                  sizeof(buf),
                  R"({"cpu_name":"%s","cpu_threads":%u,"ram_total_gib":%.1f,"ram_avail_gib":%.1f,"has_gpu":%s,"gpu_name":"%s","vram_total_gib":%.1f,"vram_free_gib":%.1f,"native_gib":%.1f,"comfort_gib":%.1f,"stretch_gib":%.1f,"multiplier":%.2f})",
                  json_escape(profile.cpu_name).c_str(),
                  profile.cpu_logical_cores,
                  bytes_to_gib(profile.ram_total_bytes),
                  bytes_to_gib(profile.ram_avail_bytes),
                  profile.has_gpu ? "true" : "false",
                  json_escape(profile.gpu_name).c_str(),
                  bytes_to_gib(profile.gpu_vram_total_bytes),
                  bytes_to_gib(profile.gpu_vram_free_bytes),
                  profile.native_model_gib,
                  profile.streaming_comfort_gib,
                  profile.streaming_stretch_gib,
                  profile.comfort_multiplier);
    return buf;
}

}  // namespace ws
