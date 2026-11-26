#pragma once

#include <cstdio>

namespace ws {

inline void crash_log(const char* message) {
    if (FILE* f = std::fopen("ws_crash.log", "a")) {
        std::fprintf(f, "%s\n", message);
        std::fclose(f);
    }
    std::fprintf(stderr, "%s\n", message);
    std::fflush(stderr);
}

}  // namespace ws
