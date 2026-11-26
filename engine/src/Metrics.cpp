#include "WeightStream/Metrics.h"

namespace ws {

void Metrics::record_ssd_read(std::uint64_t bytes, double seconds) {
    const auto ns = static_cast<std::uint64_t>(seconds * 1e9);
    ssd_read_ns_.fetch_add(ns, std::memory_order_relaxed);
    ssd_bytes_read_.fetch_add(bytes, std::memory_order_relaxed);
}

void Metrics::record_byte_read() {
    byte_read_ops_.fetch_add(1, std::memory_order_relaxed);
}

void Metrics::record_coalesced_read(std::uint32_t pages_in_batch) {
    ssd_read_ops_.fetch_add(1, std::memory_order_relaxed);
    if (pages_in_batch > 1) {
        coalesced_pages_.fetch_add(pages_in_batch, std::memory_order_relaxed);
    }
}

void Metrics::record_ram_to_vram(std::uint64_t bytes, double seconds) {
    (void)seconds;
    vram_bytes_uploaded_.fetch_add(bytes, std::memory_order_relaxed);
}

void Metrics::record_cache_hit() {
    cache_hits_.fetch_add(1, std::memory_order_relaxed);
}

void Metrics::record_cache_miss() {
    cache_misses_.fetch_add(1, std::memory_order_relaxed);
}

void Metrics::record_gpu_wait(double seconds) {
    const auto ns = static_cast<std::uint64_t>(seconds * 1e9);
    gpu_wait_ns_.fetch_add(ns, std::memory_order_relaxed);
}

double Metrics::total_gpu_wait_seconds() const {
    return static_cast<double>(gpu_wait_ns_.load()) / 1e9;
}

double Metrics::total_ssd_read_seconds() const {
    return static_cast<double>(ssd_read_ns_.load()) / 1e9;
}

void Metrics::record_read_at(std::uint64_t bytes,
                             double wall_seconds,
                             double memcpy_seconds,
                             bool page_cache_hit) {
    read_at_wall_ns_.fetch_add(static_cast<std::uint64_t>(wall_seconds * 1e9), std::memory_order_relaxed);
    read_at_memcpy_ns_.fetch_add(static_cast<std::uint64_t>(memcpy_seconds * 1e9), std::memory_order_relaxed);
    read_at_bytes_.fetch_add(bytes, std::memory_order_relaxed);
    record_byte_read();
    if (page_cache_hit) {
        read_at_page_hits_.fetch_add(1, std::memory_order_relaxed);
    } else {
        read_at_page_misses_.fetch_add(1, std::memory_order_relaxed);
    }
}

double Metrics::total_read_at_seconds() const {
    return static_cast<double>(read_at_wall_ns_.load()) / 1e9;
}

double Metrics::total_read_at_memcpy_seconds() const {
    return static_cast<double>(read_at_memcpy_ns_.load()) / 1e9;
}

double Metrics::avg_read_at_size() const {
    const auto ops = byte_read_ops_.load();
    if (ops == 0) {
        return 0.0;
    }
    return static_cast<double>(read_at_bytes_.load()) / static_cast<double>(ops);
}

void Metrics::record_working_set(std::size_t ram_bytes,
                                 std::size_t vram_bytes,
                                 std::size_t ram_pages,
                                 std::size_t vram_pages) {
    const std::size_t combined = ram_bytes + vram_bytes;
    const std::size_t pages = ram_pages + vram_pages;

    if (ram_bytes > working_set_peaks_.peak_ram_bytes) {
        working_set_peaks_.peak_ram_bytes = ram_bytes;
    }
    if (vram_bytes > working_set_peaks_.peak_vram_bytes) {
        working_set_peaks_.peak_vram_bytes = vram_bytes;
    }
    if (combined > working_set_peaks_.peak_combined_bytes) {
        working_set_peaks_.peak_combined_bytes = combined;
    }
    if (pages > working_set_peaks_.peak_simultaneous_pages) {
        working_set_peaks_.peak_simultaneous_pages = pages;
    }
}

void Metrics::reset() {
    ssd_bytes_read_.store(0);
    byte_read_ops_.store(0);
    ssd_read_ops_.store(0);
    coalesced_pages_.store(0);
    vram_bytes_uploaded_.store(0);
    cache_hits_.store(0);
    cache_misses_.store(0);
    gpu_wait_ns_.store(0);
    ssd_read_ns_.store(0);
    read_at_wall_ns_.store(0);
    read_at_memcpy_ns_.store(0);
    read_at_bytes_.store(0);
    read_at_page_hits_.store(0);
    read_at_page_misses_.store(0);
    working_set_peaks_ = {};
}

}  // namespace ws
