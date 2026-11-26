#include "WeightStream/GpuTouch.h"

#ifdef WEIGHTSTREAM_HAS_CUDA
#include <cuda_runtime.h>
#endif

#include <stdexcept>
#include <string>

namespace ws {

bool gpu_touch_available() {
#ifdef WEIGHTSTREAM_HAS_CUDA
    return true;
#else
    return false;
#endif
}

void gpu_touch_device(const void* device_ptr, std::size_t bytes, int passes) {
#ifdef WEIGHTSTREAM_HAS_CUDA
    if (device_ptr == nullptr || bytes == 0 || passes <= 0) {
        return;
    }

    const std::size_t touch_bytes = bytes > (8ULL << 20) ? (8ULL << 20) : bytes;

    void* scratch = nullptr;
    const cudaError_t alloc_err = cudaMalloc(&scratch, touch_bytes);
    if (alloc_err != cudaSuccess) {
        throw std::runtime_error(std::string("gpu_touch cudaMalloc: ") + cudaGetErrorString(alloc_err));
    }

    for (int pass = 0; pass < passes; ++pass) {
        const cudaError_t err = cudaMemcpy(scratch, device_ptr, touch_bytes, cudaMemcpyDeviceToDevice);
        if (err != cudaSuccess) {
            cudaFree(scratch);
            throw std::runtime_error(std::string("gpu_touch cudaMemcpy D2D: ") + cudaGetErrorString(err));
        }
    }

    unsigned char byte = 0;
    const cudaError_t read_err = cudaMemcpy(&byte, scratch, 1, cudaMemcpyDeviceToHost);
    cudaFree(scratch);
    if (read_err != cudaSuccess) {
        throw std::runtime_error(std::string("gpu_touch cudaMemcpy D2H: ") + cudaGetErrorString(read_err));
    }
    (void)byte;
#else
    (void)device_ptr;
    (void)bytes;
    (void)passes;
#endif
}

}  // namespace ws
