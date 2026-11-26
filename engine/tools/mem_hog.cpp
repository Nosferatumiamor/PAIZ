// Simulates a machine with less RAM: locks physical memory until only --leave-mib of it is available,
// then waits (until killed or --seconds elapses). Used by the budget ladder to turn this 32 GB PC into
// an 8/6/4 GB one without touching the hardware.
#include <windows.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

double avail_mib() {
    MEMORYSTATUSEX m{};
    m.dwLength = sizeof(m);
    GlobalMemoryStatusEx(&m);
    return static_cast<double>(m.ullAvailPhys) / (1024.0 * 1024.0);
}

}  // namespace

int main(int argc, char** argv) {
    double leave_mib = 0;
    int seconds = 0;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--leave-mib" && i + 1 < argc) {
            leave_mib = std::atof(argv[++i]);
        } else if (a == "--seconds" && i + 1 < argc) {
            seconds = std::atoi(argv[++i]);
        }
    }
    if (leave_mib <= 0) {
        std::fprintf(stderr, "Usage: ws_mem_hog --leave-mib N [--seconds S]\n"
                             "  locks RAM until N MiB remain available (standby cache included)\n");
        return 1;
    }

    const double before = avail_mib();
    const double want = before - leave_mib;
    if (want <= 0) {
        std::printf("[mem_hog] already only %.0f MiB available (<= %.0f), nothing to lock\n", before, leave_mib);
        std::fflush(stdout);
    } else {
        const SIZE_T bytes = static_cast<SIZE_T>(want) * 1024 * 1024;
        SetProcessWorkingSetSizeEx(GetCurrentProcess(), bytes + (64u << 20), bytes + (256u << 20),
                                   QUOTA_LIMITS_HARDWS_MIN_DISABLE | QUOTA_LIMITS_HARDWS_MAX_DISABLE);
        // grab in 256 MiB chunks so we can stop as soon as the target is reached
        std::vector<void*> chunks;
        const SIZE_T chunk = 256u << 20;
        SIZE_T got = 0;
        while (got < bytes) {
            const SIZE_T n = (bytes - got < chunk) ? (bytes - got) : chunk;
            void* p = VirtualAlloc(nullptr, n, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
            if (!p) {
                break;
            }
            std::memset(p, 1, n);
            if (!VirtualLock(p, n)) {
                std::fprintf(stderr, "[mem_hog] VirtualLock failed (%lu), memory not pinned\n", GetLastError());
            }
            chunks.push_back(p);
            got += n;
        }
        std::printf("[mem_hog] locked %.0f MiB, available now %.0f MiB (target %.0f)\n",
                    static_cast<double>(got) / (1024.0 * 1024.0), avail_mib(), leave_mib);
        std::fflush(stdout);
    }

    // keep squeezing: the OS refills "available" with standby cache and freed pages, so lock more whenever
    // the machine has more than the target available; never release (a small machine has no spare RAM)
    std::vector<void*> extra;
    for (int t = 0; seconds <= 0 || t < seconds; ++t) {
        Sleep(250);
        const double over = avail_mib() - leave_mib;
        if (over > 128) {
            const SIZE_T n = static_cast<SIZE_T>(over > 512 ? 512 : over) * 1024 * 1024;
            void* p = VirtualAlloc(nullptr, n, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
            if (p) {
                std::memset(p, 1, n);
                VirtualLock(p, n);
                extra.push_back(p);
            }
        }
    }
    return 0;
}
