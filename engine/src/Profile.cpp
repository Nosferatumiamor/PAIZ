#include "WeightStream/PageAutopsy.h"
#include "WeightStream/TensorIndex.h"

#include <algorithm>
#include <fstream>
#include <regex>
#include <sstream>
#include <unordered_map>

namespace ws {

void ProfileRecorder::reset() {
    trace_.clear();
}

void ProfileRecorder::record(std::size_t chunk_index) {
    trace_.push_back(chunk_index);
}

WSProfile ProfileRecorder::build_profile(const std::string& model_name,
                                           std::size_t page_size,
                                           std::size_t chunk_count) const {
    WSProfile profile;
    profile.model_name = model_name;
    profile.page_size = page_size;
    profile.chunk_count = chunk_count;
    profile.access_trace = trace_;
    profile.analyze(0);
    return profile;
}

void WSProfile::analyze(std::uint32_t pass_length) {
    chunk_stats.clear();
    chunk_stats.resize(chunk_count);

    for (std::size_t i = 0; i < chunk_count; ++i) {
        chunk_stats[i].chunk_index = i;
        chunk_stats[i].first_use = UINT32_MAX;
        chunk_stats[i].last_use = 0;
        chunk_stats[i].access_count = 0;
    }

    for (std::uint32_t step = 0; step < access_trace.size(); ++step) {
        const std::size_t idx = access_trace[step];
        if (idx >= chunk_count) {
            continue;
        }

        auto& stat = chunk_stats[idx];
        ++stat.access_count;
        stat.first_use = std::min(stat.first_use, step);
        stat.last_use = std::max(stat.last_use, step);
    }

    if (pass_length == 0 && chunk_count > 0 && !access_trace.empty()) {
        passes_recorded = static_cast<std::uint32_t>(access_trace.size() / chunk_count);
        if (passes_recorded == 0) {
            passes_recorded = 1;
        }
        pass_length = static_cast<std::uint32_t>(access_trace.size() / passes_recorded);
    }

    if (pass_length > 0) {
        for (auto& stat : chunk_stats) {
            stat.reused_within_pass = stat.access_count > 1;
            (void)pass_length;
        }
    }

    if (!access_trace.empty()) {
        forward_order.clear();
        forward_order.reserve(access_trace.size());
        for (const std::size_t idx : access_trace) {
            if (forward_order.empty() || forward_order.back() != idx) {
                forward_order.push_back(idx);
            }
        }

        if (pass_length > 0 && forward_order.size() > pass_length) {
            std::vector<std::size_t> one_pass;
            one_pass.reserve(pass_length);
            for (const std::size_t idx : access_trace) {
                if (one_pass.empty() || one_pass.back() != idx) {
                    one_pass.push_back(idx);
                }
                if (one_pass.size() >= pass_length) {
                    break;
                }
            }
            if (!one_pass.empty()) {
                forward_order = std::move(one_pass);
            }
        }
    }

    last_forward_step.assign(chunk_count, 0);
    for (std::size_t step = 0; step < forward_order.size(); ++step) {
        if (forward_order[step] < chunk_count) {
            const std::size_t idx = forward_order[step];
            last_forward_step[idx] = step;

            auto& stat = chunk_stats[idx];
            ++stat.access_count;
            const auto step32 = static_cast<std::uint32_t>(step);
            stat.first_use = std::min(stat.first_use, step32);
            stat.last_use = std::max(stat.last_use, step32);
            stat.reused_within_pass = stat.access_count > 1;
        }
    }
}

bool WSProfile::save(const std::filesystem::path& path) const {
    std::ofstream out(path);
    if (!out) {
        return false;
    }

    out << kMagic << '\n';
    out << "model=" << model_name << '\n';
    out << "page_size=" << page_size << '\n';
    out << "chunk_count=" << chunk_count << '\n';
    out << "passes_recorded=" << passes_recorded << '\n';
    out << "[access_trace]\n";
    for (const std::size_t idx : access_trace) {
        out << idx << '\n';
    }
    out << "[chunk_stats]\n";
    out << "# index first_use last_use access_count reused\n";
    for (const auto& stat : chunk_stats) {
        out << stat.chunk_index << ' ' << stat.first_use << ' ' << stat.last_use << ' '
            << stat.access_count << ' ' << (stat.reused_within_pass ? 1 : 0) << '\n';
    }
    out << "[forward_order]\n";
    for (const std::size_t idx : forward_order) {
        out << idx << '\n';
    }
    return static_cast<bool>(out);
}

bool WSProfile::load(const std::filesystem::path& path) {
    std::ifstream in(path);
    if (!in) {
        return false;
    }

    access_trace.clear();
    chunk_stats.clear();
    forward_order.clear();

    std::string line;
    enum class Section { None, Trace, Stats, Order };
    Section section = Section::None;

    if (!std::getline(in, line) || line != kMagic) {
        return false;
    }

    while (std::getline(in, line)) {
        if (line.empty()) {
            continue;
        }
        if (line == "[access_trace]") {
            section = Section::Trace;
            continue;
        }
        if (line == "[chunk_stats]") {
            section = Section::Stats;
            continue;
        }
        if (line == "[forward_order]") {
            section = Section::Order;
            continue;
        }
        if (line[0] == '#') {
            continue;
        }

        if (section == Section::None) {
            const auto eq = line.find('=');
            if (eq == std::string::npos) {
                continue;
            }
            const std::string key = line.substr(0, eq);
            const std::string value = line.substr(eq + 1);
            if (key == "model") {
                model_name = value;
            } else if (key == "page_size") {
                page_size = static_cast<std::size_t>(std::stoull(value));
            } else if (key == "chunk_count") {
                chunk_count = static_cast<std::size_t>(std::stoull(value));
            } else if (key == "passes_recorded") {
                passes_recorded = static_cast<std::uint32_t>(std::stoul(value));
            }
            continue;
        }

        if (section == Section::Trace) {
            access_trace.push_back(static_cast<std::size_t>(std::stoull(line)));
        } else if (section == Section::Order) {
            forward_order.push_back(static_cast<std::size_t>(std::stoull(line)));
        } else if (section == Section::Stats) {
            ChunkUsage stat;
            std::istringstream iss(line);
            int reused = 0;
            iss >> stat.chunk_index >> stat.first_use >> stat.last_use >> stat.access_count >> reused;
            stat.reused_within_pass = reused != 0;
            chunk_stats.push_back(stat);
        }
    }

    if (chunk_stats.empty() && !access_trace.empty()) {
        analyze(0);
    }

    return chunk_count > 0 && !forward_order.empty();
}

namespace {

int layer_number(const std::string& name) {
    static const std::regex pattern(R"(blk\.(\d+)\.)");
    std::smatch match;
    if (std::regex_search(name, match, pattern)) {
        return std::stoi(match[1].str());
    }
    return -1;
}

int tensor_sort_key(const std::string& name) {
    if (name.find("token_embd") != std::string::npos) {
        return -100;
    }
    if (name.find("output_norm") != std::string::npos) {
        return 9000;
    }
    if (name.find("output") != std::string::npos) {
        return 9100;
    }

    static const char* order[] = {
        "attn_norm", "attn_q",  "attn_k", "attn_v", "attn_qkv", "attn_output",
        "ffn_norm",  "ffn_gate", "ffn_up", "ffn_down",
    };

    for (int i = 0; i < static_cast<int>(sizeof(order) / sizeof(order[0])); ++i) {
        if (name.find(order[i]) != std::string::npos) {
            return i;
        }
    }
    return 5000;
}

void append_pages_for_range(std::uint64_t offset,
                            std::uint64_t size,
                            std::size_t page_size,
                            std::vector<std::size_t>& pages) {
    if (page_size == 0 || size == 0) {
        return;
    }

    const std::size_t first = static_cast<std::size_t>(offset / page_size);
    const std::size_t last = static_cast<std::size_t>((offset + size - 1) / page_size);

    for (std::size_t page = first; page <= last; ++page) {
        if (pages.empty() || pages.back() != page) {
            pages.push_back(page);
        }
    }
}

bool tensor_is_load_hot(const std::string& name, int layer, int n_layer_all, int i_gpu_start, int act_gpu_layers) {
    if (layer < 0) {
        if (name.find("token_embd") != std::string::npos) {
            return true;
        }
        if (name.find("output") != std::string::npos) {
            return true;
        }
        return false;
    }

    if (layer >= i_gpu_start && layer < i_gpu_start + act_gpu_layers) {
        return true;
    }

    if (layer == 0) {
        return true;
    }

    (void)n_layer_all;
    return false;
}

}  // namespace

std::vector<std::size_t> InferenceOrder::build_forward_pages(const TensorIndex& index,
                                                              std::uint64_t data_section_offset,
                                                              std::uint64_t data_section_size,
                                                              std::size_t page_size) {
    (void)data_section_size;

    struct TensorRef {
        std::string name;
        int layer;
        int sort_key;
        std::uint64_t offset;
        std::uint64_t size;
    };

    std::vector<TensorRef> tensors;
    tensors.reserve(index.size());

    for (std::size_t i = 0; i < index.size(); ++i) {
        const TensorInfo* info = index.find_by_index(i);
        if (!info) {
            continue;
        }
        tensors.push_back(
            {info->name, layer_number(info->name), tensor_sort_key(info->name), info->offset, info->size});
    }

    std::sort(tensors.begin(), tensors.end(), [](const TensorRef& a, const TensorRef& b) {
        if (a.layer != b.layer) {
            if (a.layer < 0) {
                return true;
            }
            if (b.layer < 0) {
                return false;
            }
            return a.layer < b.layer;
        }
        if (a.sort_key != b.sort_key) {
            return a.sort_key < b.sort_key;
        }
        return a.name < b.name;
    });

    std::vector<std::size_t> pages;
    for (const auto& tensor : tensors) {
        append_pages_for_range(tensor.offset, tensor.size, page_size, pages);
    }

    return pages;
}

LoadPriorityPlan LoadPriorityPlan::build(const TensorIndex& index, int n_gpu_layers, std::size_t page_size) {
    LoadPriorityPlan plan;
    if (n_gpu_layers <= 0 || page_size == 0 || index.size() == 0) {
        return plan;
    }

    int max_layer = -1;
    for (std::size_t i = 0; i < index.size(); ++i) {
        const TensorInfo* info = index.find_by_index(i);
        if (!info) {
            continue;
        }
        max_layer = std::max(max_layer, layer_number(info->name));
    }

    const int n_layer_all = max_layer >= 0 ? max_layer + 1 : 0;
    const int i_gpu_start = std::max(n_layer_all + 1 - n_gpu_layers, 0);
    const int act_gpu_layers = std::min(n_gpu_layers, n_layer_all + 1);

    std::size_t page_count = 0;
    for (std::size_t i = 0; i < index.size(); ++i) {
        const TensorInfo* info = index.find_by_index(i);
        if (!info || info->size == 0) {
            continue;
        }
        const std::size_t last =
            static_cast<std::size_t>((info->offset + info->size - 1) / page_size);
        page_count = std::max(page_count, last + 1);
    }

    if (page_count == 0) {
        return plan;
    }

    plan.hot_.assign(page_count, false);

    for (std::size_t i = 0; i < index.size(); ++i) {
        const TensorInfo* info = index.find_by_index(i);
        if (!info || info->size == 0) {
            continue;
        }
        if (!tensor_is_load_hot(info->name, layer_number(info->name), n_layer_all, i_gpu_start,
                                act_gpu_layers)) {
            continue;
        }

        const std::size_t first = static_cast<std::size_t>(info->offset / page_size);
        const std::size_t last =
            static_cast<std::size_t>((info->offset + info->size - 1) / page_size);
        for (std::size_t page = first; page <= last && page < page_count; ++page) {
            plan.hot_[page] = true;
        }
    }

    std::vector<std::size_t> forward;
    forward.reserve(page_count);
    for (std::size_t i = 0; i < index.size(); ++i) {
        const TensorInfo* info = index.find_by_index(i);
        if (!info || info->size == 0) {
            continue;
        }
        if (!tensor_is_load_hot(info->name, layer_number(info->name), n_layer_all, i_gpu_start,
                                act_gpu_layers)) {
            continue;
        }
        append_pages_for_range(info->offset, info->size, page_size, forward);
    }

    plan.hot_order_.clear();
    const auto inference_order =
        InferenceOrder::build_forward_pages(index, 0, 0, page_size);
    for (const std::size_t page : inference_order) {
        if (page < plan.hot_.size() && plan.hot_[page]) {
            if (plan.hot_order_.empty() || plan.hot_order_.back() != page) {
                plan.hot_order_.push_back(page);
            }
        }
    }
    if (plan.hot_order_.empty()) {
        plan.hot_order_ = std::move(forward);
    }

    plan.enabled_ = true;
    return plan;
}

bool LoadPriorityPlan::is_hot(std::size_t chunk_index) const {
    if (!enabled_ || chunk_index >= hot_.size()) {
        return true;
    }
    return hot_[chunk_index];
}

std::size_t LoadPriorityPlan::hot_page_count() const {
    if (!enabled_) {
        return 0;
    }
    return static_cast<std::size_t>(
        std::count(hot_.begin(), hot_.end(), true));
}

}  // namespace ws
