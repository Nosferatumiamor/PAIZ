#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <utility>
#include <vector>

namespace ws {

/// Usage "character sheets" for the experts of a MoE model: how often each expert of each layer is
/// routed to, split by the domain of the session that used it. Experts are never labeled up front;
/// their domain affinities emerge from usage and sharpen as more sessions are recorded.
class ExpertSheets {
public:
    struct ExpertId {
        int layer = 0;
        int expert = 0;
    };

    bool init(std::string model_name, int n_layer, int n_expert);
    bool load(const std::filesystem::path& path);
    bool save(const std::filesystem::path& path) const;

    const std::string& model_name() const { return model_name_; }
    int n_layer() const { return n_layer_; }
    int n_expert() const { return n_expert_; }

    /// Index of `name`, created if needed.
    int domain_id(const std::string& name);
    const std::vector<std::string>& domains() const { return domains_; }

    /// Records the routing of one layer (expert indices, any number of tokens) under `domain`.
    void record(int domain, int layer, const std::int32_t* ids, std::size_t n_ids);

    std::uint64_t count(int domain, int layer, int expert) const;
    std::uint64_t expert_total(int layer, int expert) const;
    std::uint64_t domain_total(int domain) const;
    std::uint64_t grand_total() const;

    /// How much more `domain` uses this expert than its overall share of usage predicts (1 = no preference).
    double affinity(int domain, int layer, int expert) const;

    /// Experts ranked by use in `domain` (every domain if domain < 0), most used first.
    std::vector<ExpertId> ranked(int domain) const;

    /// One CSV row per expert: uses, then share and affinity per domain.
    bool write_report(const std::filesystem::path& path) const;

private:
    std::size_t flat(int layer, int expert) const {
        return static_cast<std::size_t>(layer) * static_cast<std::size_t>(n_expert_) + static_cast<std::size_t>(expert);
    }

    std::string model_name_;
    int n_layer_ = 0;
    int n_expert_ = 0;
    std::vector<std::string> domains_;
    std::vector<std::vector<std::uint64_t>> counts_;  // [domain][layer * n_expert + expert]
};

}  // namespace ws
