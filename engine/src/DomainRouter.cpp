#include "WeightStream/DomainRouter.h"

#include <algorithm>
#include <cmath>
#include <utility>

namespace ws {

DomainRouter::DomainRouter(ExpertSheets& sheets, ExpertStore& store, std::size_t preload_experts, std::size_t skip_top)
    : sheets_(sheets), store_(store), preload_experts_(preload_experts), skip_top_(skip_top) {
    const std::size_t n = static_cast<std::size_t>(sheets_.n_layer()) * static_cast<std::size_t>(sheets_.n_expert());
    turn_prefill_.assign(n, 0);
    turn_all_.assign(n, 0);
    build_profiles();
}

void DomainRouter::build_profiles() {
    const int n_layer = sheets_.n_layer();
    const int n_expert = sheets_.n_expert();
    profiles_.assign(sheets_.domains().size(), std::vector<double>(static_cast<std::size_t>(n_layer) * static_cast<std::size_t>(n_expert), 0.0));
    for (std::size_t d = 0; d < profiles_.size(); ++d) {
        double norm = 0.0;
        for (int l = 0; l < n_layer; ++l) {
            for (int e = 0; e < n_expert; ++e) {
                const double v = static_cast<double>(sheets_.count(static_cast<int>(d), l, e));
                profiles_[d][static_cast<std::size_t>(l) * static_cast<std::size_t>(n_expert) + static_cast<std::size_t>(e)] = v;
                norm += v * v;
            }
        }
        if (norm > 0) {
            const double inv = 1.0 / std::sqrt(norm);
            for (double& v : profiles_[d]) v *= inv;
        }
    }
}

void DomainRouter::preload(int domain) {
    const auto ranked = sheets_.ranked(domain);
    std::vector<std::pair<int, int>> experts;
    experts.reserve(preload_experts_);
    for (std::size_t i = skip_top_; i < ranked.size() && experts.size() < preload_experts_; ++i) {
        experts.emplace_back(ranked[i].layer, ranked[i].expert);
    }
    store_.set_profile(experts);
    current_ = domain;
}

void DomainRouter::begin_turn() {
    std::fill(turn_prefill_.begin(), turn_prefill_.end(), 0u);
    std::fill(turn_all_.begin(), turn_all_.end(), 0u);
    turn_domain_ = -1;
}

void DomainRouter::observe(int layer, const std::int32_t* ids, std::size_t n_ids, bool prefill) {
    if (layer < 0 || layer >= sheets_.n_layer()) {
        return;
    }
    const std::size_t base = static_cast<std::size_t>(layer) * static_cast<std::size_t>(sheets_.n_expert());
    for (std::size_t i = 0; i < n_ids; ++i) {
        if (ids[i] < 0 || ids[i] >= sheets_.n_expert()) {
            continue;
        }
        ++turn_all_[base + static_cast<std::size_t>(ids[i])];
        if (prefill) {
            ++turn_prefill_[base + static_cast<std::size_t>(ids[i])];
        }
    }
}

DomainRouter::Detection DomainRouter::end_prefill() {
    Detection det;
    double norm = 0.0;
    for (std::uint32_t v : turn_prefill_) norm += static_cast<double>(v) * v;
    if (norm == 0.0 || profiles_.empty()) {
        return det;
    }
    for (std::size_t d = 0; d < profiles_.size(); ++d) {
        double dot = 0.0;
        for (std::size_t i = 0; i < turn_prefill_.size(); ++i) {
            dot += profiles_[d][i] * turn_prefill_[i];
        }
        const double sim = dot / std::sqrt(norm);
        if (sim > det.similarity) {
            det.similarity = sim;
            det.domain = static_cast<int>(d);
        }
    }
    turn_domain_ = det.domain;
    if (det.domain >= 0 && det.domain != current_) {
        preload(det.domain);
        det.switched = true;
    }
    return det;
}

void DomainRouter::end_turn(bool learn) {
    if (!learn || turn_domain_ < 0) {
        return;
    }
    const int n_expert = sheets_.n_expert();
    std::vector<std::int32_t> ids;
    for (int l = 0; l < sheets_.n_layer(); ++l) {
        ids.clear();
        for (int e = 0; e < n_expert; ++e) {
            const std::uint32_t c = turn_all_[static_cast<std::size_t>(l) * static_cast<std::size_t>(n_expert) + static_cast<std::size_t>(e)];
            ids.insert(ids.end(), c, e);
        }
        sheets_.record(turn_domain_, l, ids.data(), ids.size());
    }
    build_profiles();
}

}  // namespace ws
