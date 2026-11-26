#pragma once

#include "WeightStream/ExpertSheets.h"
#include "WeightStream/ExpertStore.h"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace ws {

/// Drives domain-aware preloading for a live MoE session. Each user turn, the routing of the prompt
/// is compared with the domain profiles of the expert sheets; when the closest domain changes, its
/// most used experts are handed to the ExpertStore to preload. What the turn actually routed to is
/// then recorded into the sheets under that domain, so profiles sharpen with use.
class DomainRouter {
public:
    struct Detection {
        int domain = -1;
        double similarity = 0.0;  // cosine between the prompt's routing and the domain profile
        bool switched = false;    // a new profile was handed to the store
    };

    /// `skip_top`: experts at the top of each ranking that a faster tier (the GPU expert cache) is
    /// expected to hold already; the store only ever sees that tier's misses, so preloading them is waste.
    DomainRouter(ExpertSheets& sheets, ExpertStore& store, std::size_t preload_experts, std::size_t skip_top = 0);

    /// Preloads a domain's profile right away (domain < 0 = every domain together).
    void preload(int domain);

    void begin_turn();
    void observe(int layer, const std::int32_t* ids, std::size_t n_ids, bool prefill);
    Detection end_prefill();
    /// Adds the turn's routing to the sheets under the detected domain (if `learn`).
    void end_turn(bool learn);

    int current_domain() const { return current_; }

private:
    void build_profiles();

    ExpertSheets& sheets_;
    ExpertStore& store_;
    std::size_t preload_experts_ = 0;
    std::size_t skip_top_ = 0;
    int current_ = -2;  // -2 = nothing preloaded yet, -1 = global profile

    std::vector<std::vector<double>> profiles_;  // normalized usage per domain
    std::vector<std::uint32_t> turn_prefill_;
    std::vector<std::uint32_t> turn_all_;
    int turn_domain_ = -1;
};

}  // namespace ws
