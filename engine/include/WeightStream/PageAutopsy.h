#pragma once

#include "WeightStream/Profile.h"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace ws {

/// Per-page autopsy stats collected during a run.
struct PageAutopsyEntry {
    std::size_t chunk_index = 0;
    std::uint32_t loads_from_ssd = 0;
    std::uint32_t accesses = 0;
    std::uint32_t vram_hits = 0;
    std::uint32_t vram_misses = 0;
    std::uint32_t evictions = 0;
    double seconds_in_vram = 0.0;
    double seconds_in_ram = 0.0;
    std::uint32_t first_step = UINT32_MAX;
    std::uint32_t last_step = 0;
};

/// Collects fine-grained page lifecycle events for autopsy + HTML reports.
class PageAutopsyCollector {
public:
    void reset(std::size_t chunk_count);
    void on_access(std::size_t chunk_index, std::uint32_t step, bool vram_hit);
    void on_ssd_load(std::size_t chunk_index);
    void on_vram_enter(std::size_t chunk_index);
    void on_vram_leave(std::size_t chunk_index);
    void on_ram_enter(std::size_t chunk_index);
    void on_ram_leave(std::size_t chunk_index);
    void on_eviction(std::size_t chunk_index);

    const std::vector<PageAutopsyEntry>& entries() const { return entries_; }
    std::uint32_t total_steps() const { return total_steps_; }

    bool write_text_report(const std::filesystem::path& path) const;
    bool write_html_report(const std::filesystem::path& path) const;

    /// Returns pages where loads_from_ssd > 1 (invariant violation).
    std::vector<std::size_t> ssd_invariant_violations() const;

private:
    using Clock = std::chrono::steady_clock;

    std::vector<PageAutopsyEntry> entries_;
    std::vector<Clock::time_point> vram_since_;
    std::vector<Clock::time_point> ram_since_;
    std::uint32_t total_steps_ = 0;
};

/// Profile-driven planning: dedupe, pinning, access order.
class Planner {
public:
    void set_profile(const WSProfile* profile);

    /// First-access deduplicated forward order (minimal SSD reads).
    const std::vector<std::size_t>& execution_order() const { return execution_order_; }

    /// Raw forward order (may contain revisits) for prefetch hints.
    const std::vector<std::size_t>& prefetch_order() const { return prefetch_order_; }

    bool should_pin(std::size_t chunk_index, std::size_t step) const;

    /// Belady: next access step strictly after `step`, or UINT64_MAX if none.
    std::uint64_t next_access_after(std::size_t chunk_index, std::size_t step) const;

    static std::vector<std::size_t> dedupe_first_access(const std::vector<std::size_t>& order);

private:
    void rebuild_use_steps();

    const WSProfile* profile_ = nullptr;
    std::vector<std::size_t> execution_order_;
    std::vector<std::size_t> prefetch_order_;
    std::vector<std::vector<std::size_t>> use_steps_;
};

}  // namespace ws
