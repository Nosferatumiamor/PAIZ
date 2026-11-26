#include "WeightStream/PageAutopsy.h"

#include <algorithm>
#include <fstream>
#include <iomanip>
#include <sstream>

namespace ws {

void PageAutopsyCollector::reset(std::size_t chunk_count) {
    entries_.assign(chunk_count, PageAutopsyEntry{});
    vram_since_.assign(chunk_count, Clock::time_point{});
    ram_since_.assign(chunk_count, Clock::time_point{});
    total_steps_ = 0;

    for (std::size_t i = 0; i < chunk_count; ++i) {
        entries_[i].chunk_index = i;
    }
}

void PageAutopsyCollector::on_access(std::size_t chunk_index, std::uint32_t step, bool vram_hit) {
    if (chunk_index >= entries_.size()) {
        return;
    }

    auto& e = entries_[chunk_index];
    ++e.accesses;
    e.first_step = std::min(e.first_step, step);
    e.last_step = std::max(e.last_step, step);
    total_steps_ = std::max(total_steps_, step + 1);

    if (vram_hit) {
        ++e.vram_hits;
    } else {
        ++e.vram_misses;
    }
}

void PageAutopsyCollector::on_ssd_load(std::size_t chunk_index) {
    if (chunk_index < entries_.size()) {
        ++entries_[chunk_index].loads_from_ssd;
    }
}

void PageAutopsyCollector::on_vram_enter(std::size_t chunk_index) {
    if (chunk_index < vram_since_.size()) {
        vram_since_[chunk_index] = Clock::now();
    }
}

void PageAutopsyCollector::on_vram_leave(std::size_t chunk_index) {
    if (chunk_index >= vram_since_.size() || vram_since_[chunk_index] == Clock::time_point{}) {
        return;
    }

    const double seconds = std::chrono::duration<double>(Clock::now() - vram_since_[chunk_index]).count();
    entries_[chunk_index].seconds_in_vram += seconds;
    vram_since_[chunk_index] = Clock::time_point{};
}

void PageAutopsyCollector::on_ram_enter(std::size_t chunk_index) {
    if (chunk_index < ram_since_.size()) {
        ram_since_[chunk_index] = Clock::now();
    }
}

void PageAutopsyCollector::on_ram_leave(std::size_t chunk_index) {
    if (chunk_index >= ram_since_.size() || ram_since_[chunk_index] == Clock::time_point{}) {
        return;
    }

    const double seconds = std::chrono::duration<double>(Clock::now() - ram_since_[chunk_index]).count();
    entries_[chunk_index].seconds_in_ram += seconds;
    ram_since_[chunk_index] = Clock::time_point{};
}

void PageAutopsyCollector::on_eviction(std::size_t chunk_index) {
    on_vram_leave(chunk_index);
    on_ram_leave(chunk_index);
    if (chunk_index < entries_.size()) {
        ++entries_[chunk_index].evictions;
    }
}

bool PageAutopsyCollector::write_text_report(const std::filesystem::path& path) const {
    std::ofstream out(path);
    if (!out) {
        return false;
    }

    out << "WeightStream Page Autopsy\n";
    out << "=========================\n\n";

    for (const auto& e : entries_) {
        if (e.accesses == 0 && e.loads_from_ssd == 0) {
            continue;
        }

        out << "Page " << e.chunk_index << '\n';
        out << "  Loaded from SSD : " << e.loads_from_ssd << " times\n";
        out << "  Accessed        : " << e.accesses << " times\n";
        out << "  VRAM hits/miss  : " << e.vram_hits << " / " << e.vram_misses << '\n';
        out << "  Evictions       : " << e.evictions << '\n';
        out << "  Time in VRAM    : " << std::fixed << std::setprecision(1) << (e.seconds_in_vram * 1000.0)
            << " ms\n";
        out << "  Time in RAM     : " << std::fixed << std::setprecision(1) << e.seconds_in_ram << " s\n";
        out << "  Steps           : " << e.first_step << " .. " << e.last_step << '\n';

        if (e.loads_from_ssd > 1 && e.accesses <= e.loads_from_ssd) {
            out << "  ⚠ REDUNDANT SSD READS\n";
        } else if (e.loads_from_ssd == 1 && e.accesses >= 4) {
            out << "  ✓ HOT candidate\n";
        }
        out << '\n';
    }

    return true;
}

bool PageAutopsyCollector::write_html_report(const std::filesystem::path& path) const {
    std::ofstream out(path);
    if (!out) {
        return false;
    }

    std::uint32_t max_loads = 1;
    for (const auto& e : entries_) {
        max_loads = std::max(max_loads, e.loads_from_ssd);
    }

    out << "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>WeightStream Autopsy</title>\n";
    out << "<style>body{font-family:monospace;background:#111;color:#eee;padding:20px}"
           ".bar{background:#2ecc71;height:14px;display:inline-block}"
           ".warn{color:#e74c3c}.hot{color:#f1c40f}"
           "table{border-collapse:collapse;width:100%}td,th{border:1px solid #333;padding:4px 8px}"
           "</style></head><body>\n";
    out << "<h1>WeightStream Page Autopsy</h1>\n";
    out << "<p>Steps: " << total_steps_ << " | Pages tracked: " << entries_.size() << "</p>\n";

    out << "<h2>SSD loads heatmap</h2><table><tr><th>Page</th><th>Loads</th><th>Accesses</th><th>Bar</th></tr>\n";

    for (const auto& e : entries_) {
        if (e.loads_from_ssd == 0 && e.accesses == 0) {
            continue;
        }

        const int width = max_loads > 0 ? static_cast<int>(200 * e.loads_from_ssd / max_loads) : 0;
        const char* cls = e.loads_from_ssd > 1 ? "warn" : (e.accesses >= 4 ? "hot" : "");

        out << "<tr><td>" << e.chunk_index << "</td><td class=\"" << cls << "\">" << e.loads_from_ssd
            << "</td><td>" << e.accesses << "</td><td><span class=\"bar\" style=\"width:" << width
            << "px;background:" << (e.loads_from_ssd > 1 ? "#e74c3c" : "#2ecc71") << "\"></span></td></tr>\n";
    }

    out << "</table>\n<h2>Timeline (access steps)</h2><pre>\n";

    for (const auto& e : entries_) {
        if (e.accesses == 0) {
            continue;
        }
        out << "Page " << e.chunk_index << "  ";
        const int bar = std::min(40, static_cast<int>(e.accesses));
        for (int i = 0; i < bar; ++i) {
            out << (e.loads_from_ssd > 1 ? '#' : '=');
        }
        out << "  (" << e.accesses << " acc, " << e.loads_from_ssd << " SSD)\n";
    }

    out << "</pre></body></html>\n";
    return true;
}

std::vector<std::size_t> PageAutopsyCollector::ssd_invariant_violations() const {
    std::vector<std::size_t> violations;
    for (const auto& e : entries_) {
        if (e.loads_from_ssd > 1) {
            violations.push_back(e.chunk_index);
        }
    }
    return violations;
}

std::vector<std::size_t> Planner::dedupe_first_access(const std::vector<std::size_t>& order) {
    std::vector<std::size_t> deduped;
    deduped.reserve(order.size());

    std::vector<bool> seen;
    if (!order.empty()) {
        std::size_t max_page = 0;
        for (const std::size_t p : order) {
            max_page = std::max(max_page, p);
        }
        seen.assign(max_page + 1, false);
    }

    for (const std::size_t page : order) {
        if (page >= seen.size() || seen[page]) {
            continue;
        }
        seen[page] = true;
        deduped.push_back(page);
    }

    return deduped;
}

void Planner::set_profile(const WSProfile* profile) {
    profile_ = profile;
    execution_order_.clear();
    prefetch_order_.clear();
    use_steps_.clear();

    if (!profile_) {
        return;
    }

    prefetch_order_ = profile_->forward_order;
    execution_order_ = dedupe_first_access(profile_->forward_order);
    rebuild_use_steps();
}

void Planner::rebuild_use_steps() {
    if (!profile_) {
        return;
    }

    use_steps_.assign(profile_->chunk_count, {});
    for (std::size_t step = 0; step < prefetch_order_.size(); ++step) {
        const std::size_t chunk = prefetch_order_[step];
        if (chunk < use_steps_.size()) {
            use_steps_[chunk].push_back(step);
        }
    }
}

std::uint64_t Planner::next_access_after(std::size_t chunk_index, std::size_t step) const {
    if (chunk_index >= use_steps_.size()) {
        return UINT64_MAX;
    }

    const auto& steps = use_steps_[chunk_index];
    const auto it = std::upper_bound(steps.begin(), steps.end(), step);
    if (it == steps.end()) {
        return UINT64_MAX;
    }
    return static_cast<std::uint64_t>(*it);
}

bool Planner::should_pin(std::size_t chunk_index, std::size_t step) const {
    (void)chunk_index;
    (void)step;
    return false;
}

}  // namespace ws
