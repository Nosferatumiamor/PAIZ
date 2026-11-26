#include "WeightStream/CudaTransfer.h"
#include "WeightStream/SafeMemcpy.h"

#ifdef WEIGHTSTREAM_HAS_CUDA
#include <cuda_runtime.h>
#endif

#include <cstring>
#include <stdexcept>

namespace ws {

namespace {

#ifdef WEIGHTSTREAM_HAS_CUDA
void check_cuda(cudaError_t err, const char* what) {
    if (err != cudaSuccess) {
        throw std::runtime_error(std::string(what) + ": " + cudaGetErrorString(err));
    }
}
#endif

}  // namespace

void copy_host_to_tier(TierCache& dst, std::byte* dst_ptr, const std::byte* src, std::size_t size) {
#ifdef WEIGHTSTREAM_HAS_CUDA
    if (dst.is_device()) {
        check_cuda(cudaMemcpy(dst_ptr, src, size, cudaMemcpyHostToDevice), "cudaMemcpy H2D");
        return;
    }
#endif
    (void)dst;
    safe_memcpy(dst_ptr, size, src, size, size, "copy_host_to_tier");
}

void copy_tier_to_host(std::byte* dst, const TierCache& src, const std::byte* src_ptr, std::size_t size) {
#ifdef WEIGHTSTREAM_HAS_CUDA
    if (src.is_device()) {
        check_cuda(cudaMemcpy(dst, src_ptr, size, cudaMemcpyDeviceToHost), "cudaMemcpy D2H");
        return;
    }
#endif
    (void)src;
    safe_memcpy(dst, size, src_ptr, size, size, "copy_tier_to_host");
}

}  // namespace ws
