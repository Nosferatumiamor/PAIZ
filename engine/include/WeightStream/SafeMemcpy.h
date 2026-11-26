#pragma once

#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "WeightStream/CrashLog.h"

namespace ws {

/// Bounds-checked memcpy for cache/IO paths.
/// With WEIGHTSTREAM_SAFE_MEMCPY=1, aborts immediately on the first invalid transfer.
inline void safe_memcpy(void* dst,
                        std::size_t dst_size,
                        const void* src,
                        std::size_t src_size,
                        std::size_t bytes,
                        const char* where = "safe_memcpy") {
#if defined(WEIGHTSTREAM_SAFE_MEMCPY) && WEIGHTSTREAM_SAFE_MEMCPY
    if (bytes > 0 && (dst == nullptr || src == nullptr)) {
        char buf[512];
        std::snprintf(buf,
                      sizeof(buf),
                      "[WeightStream] SAFE_MEMCPY null at %s: bytes=%zu dst=%p src=%p",
                      where,
                      bytes,
                      static_cast<void*>(dst),
                      src);
        crash_log(buf);
        std::abort();
    }
    if (bytes > dst_size || bytes > src_size) {
        char buf[512];
        std::snprintf(buf,
                      sizeof(buf),
                      "[WeightStream] SAFE_MEMCPY BOUNDS at %s: bytes=%zu dst_cap=%zu src_cap=%zu",
                      where,
                      bytes,
                      dst_size,
                      src_size);
        crash_log(buf);
        std::abort();
    }
#elif !defined(NDEBUG)
    if (bytes > 0 && (dst == nullptr || src == nullptr)) {
        std::abort();
    }
    if (bytes > dst_size || bytes > src_size) {
        std::abort();
    }
#endif
    if (bytes > 0) {
        std::memcpy(dst, src, bytes);
    }
}

}  // namespace ws
