// Measures unbuffered random-read throughput on a model file with expert-sized reads,
// at several thread counts (each thread = one outstanding read), bypassing the
// Windows file cache so the numbers reflect the SSD, not RAM.
#include <windows.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <random>
#include <thread>
#include <vector>

namespace {

constexpr std::uint64_t kSector = 4096;

struct Result {
    double gib_per_s = 0.0;
    double avg_ms = 0.0;
};

Result run(const wchar_t* path, std::uint64_t file_size, std::size_t read_size, int threads, int reads_per_thread) {
    std::atomic<std::uint64_t> total_bytes{0};
    std::atomic<std::uint64_t> total_us{0};
    std::vector<std::thread> pool;
    const auto t0 = std::chrono::steady_clock::now();
    for (int t = 0; t < threads; ++t) {
        pool.emplace_back([&, t] {
            HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                   FILE_FLAG_NO_BUFFERING, nullptr);
            if (h == INVALID_HANDLE_VALUE) {
                return;
            }
            const std::size_t aligned = (read_size + kSector - 1) / kSector * kSector + kSector;
            void* buf = VirtualAlloc(nullptr, aligned, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
            std::mt19937_64 rng(1234 + t);
            std::uniform_int_distribution<std::uint64_t> dist(0, (file_size - aligned) / kSector);
            for (int i = 0; i < reads_per_thread; ++i) {
                LARGE_INTEGER off;
                off.QuadPart = static_cast<LONGLONG>(dist(rng) * kSector);
                SetFilePointerEx(h, off, nullptr, FILE_BEGIN);
                DWORD got = 0;
                const auto r0 = std::chrono::steady_clock::now();
                ReadFile(h, buf, static_cast<DWORD>(aligned), &got, nullptr);
                total_us += static_cast<std::uint64_t>(
                    std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - r0).count());
                total_bytes += got;
            }
            VirtualFree(buf, 0, MEM_RELEASE);
            CloseHandle(h);
        });
    }
    for (auto& th : pool) {
        th.join();
    }
    const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    Result r;
    r.gib_per_s = static_cast<double>(total_bytes) / (1024.0 * 1024.0 * 1024.0) / secs;
    r.avg_ms = static_cast<double>(total_us) / 1000.0 / (threads * reads_per_thread);
    return r;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "Usage: ws_ssd_probe <file>\n");
        return 1;
    }
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (!GetFileAttributesExW(argv[1], GetFileExInfoStandard, &fad)) {
        std::fprintf(stderr, "cannot stat file\n");
        return 1;
    }
    const std::uint64_t size = (static_cast<std::uint64_t>(fad.nFileSizeHigh) << 32) | fad.nFileSizeLow;

    const std::size_t sizes[] = {589824, 860160};  // Q4_K and Q6_K expert slices of Qwen3-Coder-Next
    const int thread_counts[] = {1, 4, 8, 16, 32};
    for (std::size_t s : sizes) {
        for (int t : thread_counts) {
            const Result r = run(argv[1], size, s, t, 96);
            std::printf("read %4zu KiB  threads %2d  ->  %6.2f GiB/s   avg latency %6.2f ms\n", s / 1024, t, r.gib_per_s, r.avg_ms);
        }
    }
    return 0;
}
