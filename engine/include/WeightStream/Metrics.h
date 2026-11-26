#pragma once

#include <atomic>
#include <cstdint>

namespace ws {

/// Peak memory residency observed during a run.
struct WorkingSetPeaks {
    std::size_t peak_ram_bytes = 0;
    std::size_t peak_vram_bytes = 0;
    std::size_t peak_combined_bytes = 0;
    std::size_t peak_simultaneous_pages = 0;
};

/// Lightweight runtime counters for the MVP.
class Metrics {
public:
    void record_ssd_read(std::uint64_t bytes, double seconds);
    void record_byte_read();
    void record_coalesced_read(std::uint32_t pages_in_batch);
    void record_ram_to_vram(std::uint64_t bytes, double seconds);
    void record_cache_hit();
    void record_cache_miss();
    void record_gpu_wait(double seconds);
    void record_working_set(std::size_t ram_bytes,
                            std::size_t vram_bytes,
                            std::size_t ram_pages,
                            std::size_t vram_pages);

    /// Per-call read_at() instrumentation (llama I/O hook).
    void record_read_at(std::uint64_t bytes,
                        double wall_seconds,
                        double memcpy_seconds,
                        bool page_cache_hit);

    std::uint64_t ssd_bytes_read() const { return ssd_bytes_read_.load(); }
    std::uint64_t byte_read_ops() const { return byte_read_ops_.load(); }
    std::uint64_t ssd_read_ops() const { return ssd_read_ops_.load(); }
    std::uint64_t coalesced_pages() const { return coalesced_pages_.load(); }
    std::uint64_t vram_bytes_uploaded() const { return vram_bytes_uploaded_.load(); }
    std::uint64_t cache_hits() const { return cache_hits_.load(); }
    std::uint64_t cache_misses() const { return cache_misses_.load(); }
    double total_gpu_wait_seconds() const;
    double total_ssd_read_seconds() const;
    double total_read_at_seconds() const;
    double total_read_at_memcpy_seconds() const;
    std::uint64_t read_at_bytes() const { return read_at_bytes_.load(); }
    std::uint64_t read_at_page_hits() const { return read_at_page_hits_.load(); }
    std::uint64_t read_at_page_misses() const { return read_at_page_misses_.load(); }
    double avg_read_at_size() const;
    const WorkingSetPeaks& working_set_peaks() const { return working_set_peaks_; }

    void reset();

private:
    std::atomic<std::uint64_t> ssd_bytes_read_{0};
    std::atomic<std::uint64_t> byte_read_ops_{0};
    std::atomic<std::uint64_t> ssd_read_ops_{0};
    std::atomic<std::uint64_t> coalesced_pages_{0};
    std::atomic<std::uint64_t> vram_bytes_uploaded_{0};
    std::atomic<std::uint64_t> cache_hits_{0};
    std::atomic<std::uint64_t> cache_misses_{0};
    std::atomic<std::uint64_t> gpu_wait_ns_{0};
    std::atomic<std::uint64_t> ssd_read_ns_{0};
    std::atomic<std::uint64_t> read_at_wall_ns_{0};
    std::atomic<std::uint64_t> read_at_memcpy_ns_{0};
    std::atomic<std::uint64_t> read_at_bytes_{0};
    std::atomic<std::uint64_t> read_at_page_hits_{0};
    std::atomic<std::uint64_t> read_at_page_misses_{0};
    WorkingSetPeaks working_set_peaks_;
};

}  // namespace ws
