#pragma once

#include <cstddef>

namespace ws {

/// Read weight bytes on CUDA device (D2D passes) — real GPU bandwidth, not sleep.
void gpu_touch_device(const void* device_ptr, std::size_t bytes, int passes);

bool gpu_touch_available();

}  // namespace ws
