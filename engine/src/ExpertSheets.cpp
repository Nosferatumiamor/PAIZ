#include "WeightStream/ExpertSheets.h"

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <numeric>

namespace ws {

namespace {

constexpr char kMagic[4] = {'W', 'S', 'X', 'S'};
constexpr std::uint32_t kVersion = 1;

void write_u32(std::ofstream& out, std::uint32_t v) {
    out.write(reinterpret_cast<const char*>(&v), sizeof(v));
}

void write_str(std::ofstream& out, const std::string& s) {
    write_u32(out, static_cast<std::uint32_t>(s.size()));
    out.write(s.data(), static_cast<std::streamsize>(s.size()));
}

bool read_u32(std::ifstream& in, std::uint32_t& v) {
    return static_cast<bool>(in.read(reinterpret_cast<char*>(&v), sizeof(v)));
}

bool read_str(std::ifstream& in, std::string& s) {
    std::uint32_t n = 0;
    if (!read_u32(in, n) || n > (1u << 20)) {
        return false;
    }
    s.resize(n);
    return static_cast<bool>(in.read(s.data(), static_cast<std::streamsize>(n)));
}

}  // namespace

bool ExpertSheets::init(std::string model_name, int n_layer, int n_expert) {
    if (n_layer <= 0 || n_expert <= 0) {
        return false;
    }
    model_name_ = std::move(model_name);
    n_layer_ = n_layer;
    n_expert_ = n_expert;
    domains_.clear();
    counts_.clear();
    return true;
}

bool ExpertSheets::load(const std::filesystem::path& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        return false;
    }
    char magic[4] = {};
    std::uint32_t version = 0;
    std::uint32_t n_layer = 0;
    std::uint32_t n_expert = 0;
    std::uint32_t n_domain = 0;
    std::string model_name;
    if (!in.read(magic, 4) || !std::equal(magic, magic + 4, kMagic) || !read_u32(in, version) || version != kVersion ||
        !read_u32(in, n_layer) || !read_u32(in, n_expert) || !read_str(in, model_name) || !read_u32(in, n_domain)) {
        return false;
    }
    std::vector<std::string> domains(n_domain);
    std::vector<std::vector<std::uint64_t>> counts(n_domain, std::vector<std::uint64_t>(static_cast<std::size_t>(n_layer) * n_expert));
    for (std::uint32_t d = 0; d < n_domain; ++d) {
        if (!read_str(in, domains[d]) ||
            !in.read(reinterpret_cast<char*>(counts[d].data()), static_cast<std::streamsize>(counts[d].size() * sizeof(std::uint64_t)))) {
            return false;
        }
    }
    model_name_ = std::move(model_name);
    n_layer_ = static_cast<int>(n_layer);
    n_expert_ = static_cast<int>(n_expert);
    domains_ = std::move(domains);
    counts_ = std::move(counts);
    return true;
}

bool ExpertSheets::save(const std::filesystem::path& path) const {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) {
        return false;
    }
    out.write(kMagic, 4);
    write_u32(out, kVersion);
    write_u32(out, static_cast<std::uint32_t>(n_layer_));
    write_u32(out, static_cast<std::uint32_t>(n_expert_));
    write_str(out, model_name_);
    write_u32(out, static_cast<std::uint32_t>(domains_.size()));
    for (std::size_t d = 0; d < domains_.size(); ++d) {
        write_str(out, domains_[d]);
        out.write(reinterpret_cast<const char*>(counts_[d].data()), static_cast<std::streamsize>(counts_[d].size() * sizeof(std::uint64_t)));
    }
    return static_cast<bool>(out);
}

int ExpertSheets::domain_id(const std::string& name) {
    const auto it = std::find(domains_.begin(), domains_.end(), name);
    if (it != domains_.end()) {
        return static_cast<int>(it - domains_.begin());
    }
    domains_.push_back(name);
    counts_.emplace_back(static_cast<std::size_t>(n_layer_) * static_cast<std::size_t>(n_expert_), 0);
    return static_cast<int>(domains_.size() - 1);
}

void ExpertSheets::record(int domain, int layer, const std::int32_t* ids, std::size_t n_ids) {
    if (domain < 0 || domain >= static_cast<int>(counts_.size()) || layer < 0 || layer >= n_layer_) {
        return;
    }
    auto& c = counts_[static_cast<std::size_t>(domain)];
    for (std::size_t i = 0; i < n_ids; ++i) {
        if (ids[i] >= 0 && ids[i] < n_expert_) {
            ++c[flat(layer, ids[i])];
        }
    }
}

std::uint64_t ExpertSheets::count(int domain, int layer, int expert) const {
    return counts_[static_cast<std::size_t>(domain)][flat(layer, expert)];
}

std::uint64_t ExpertSheets::expert_total(int layer, int expert) const {
    std::uint64_t sum = 0;
    for (const auto& c : counts_) {
        sum += c[flat(layer, expert)];
    }
    return sum;
}

std::uint64_t ExpertSheets::domain_total(int domain) const {
    const auto& c = counts_[static_cast<std::size_t>(domain)];
    return std::accumulate(c.begin(), c.end(), std::uint64_t{0});
}

std::uint64_t ExpertSheets::grand_total() const {
    std::uint64_t sum = 0;
    for (std::size_t d = 0; d < counts_.size(); ++d) {
        sum += domain_total(static_cast<int>(d));
    }
    return sum;
}

double ExpertSheets::affinity(int domain, int layer, int expert) const {
    const std::uint64_t mine = expert_total(layer, expert);
    const std::uint64_t all = grand_total();
    const std::uint64_t dom = domain_total(domain);
    if (mine == 0 || all == 0 || dom == 0) {
        return 0.0;
    }
    const double share_in_expert = static_cast<double>(count(domain, layer, expert)) / static_cast<double>(mine);
    const double share_overall = static_cast<double>(dom) / static_cast<double>(all);
    return share_in_expert / share_overall;
}

std::vector<ExpertSheets::ExpertId> ExpertSheets::ranked(int domain) const {
    std::vector<std::uint64_t> score(static_cast<std::size_t>(n_layer_) * static_cast<std::size_t>(n_expert_), 0);
    for (std::size_t d = 0; d < counts_.size(); ++d) {
        if (domain >= 0 && static_cast<int>(d) != domain) {
            continue;
        }
        for (std::size_t i = 0; i < score.size(); ++i) {
            score[i] += counts_[d][i];
        }
    }
    std::vector<std::size_t> order(score.size());
    std::iota(order.begin(), order.end(), std::size_t{0});
    std::stable_sort(order.begin(), order.end(), [&](std::size_t a, std::size_t b) { return score[a] > score[b]; });
    std::vector<ExpertId> out(order.size());
    for (std::size_t i = 0; i < order.size(); ++i) {
        out[i] = {static_cast<int>(order[i] / static_cast<std::size_t>(n_expert_)),
                  static_cast<int>(order[i] % static_cast<std::size_t>(n_expert_))};
    }
    return out;
}

bool ExpertSheets::write_report(const std::filesystem::path& path) const {
    FILE* f = nullptr;
#ifdef _WIN32
    if (_wfopen_s(&f, path.c_str(), L"w") != 0) {
        f = nullptr;
    }
#else
    f = std::fopen(path.c_str(), "w");
#endif
    if (f == nullptr) {
        return false;
    }
    std::fprintf(f, "layer,expert,uses,top_domain,top_affinity");
    for (const auto& d : domains_) {
        std::fprintf(f, ",%s_share,%s_affinity", d.c_str(), d.c_str());
    }
    std::fprintf(f, "\n");

    const int n_domain = static_cast<int>(domains_.size());
    std::vector<double> domain_share(static_cast<std::size_t>(n_domain), 0.0);
    const double all = static_cast<double>(grand_total());
    for (int d = 0; d < n_domain && all > 0; ++d) {
        domain_share[static_cast<std::size_t>(d)] = static_cast<double>(domain_total(d)) / all;
    }
    std::vector<double> share(static_cast<std::size_t>(n_domain));
    std::vector<double> aff(static_cast<std::size_t>(n_domain));
    for (int l = 0; l < n_layer_; ++l) {
        for (int e = 0; e < n_expert_; ++e) {
            const std::uint64_t uses = expert_total(l, e);
            int top = -1;
            double top_aff = 0.0;
            for (int d = 0; d < n_domain; ++d) {
                const auto di = static_cast<std::size_t>(d);
                share[di] = uses ? static_cast<double>(count(d, l, e)) / static_cast<double>(uses) : 0.0;
                aff[di] = domain_share[di] > 0 ? share[di] / domain_share[di] : 0.0;
                if (aff[di] > top_aff) {
                    top_aff = aff[di];
                    top = d;
                }
            }
            std::fprintf(f, "%d,%d,%llu,%s,%.2f", l, e, static_cast<unsigned long long>(uses),
                         top >= 0 ? domains_[static_cast<std::size_t>(top)].c_str() : "", top_aff);
            for (int d = 0; d < n_domain; ++d) {
                std::fprintf(f, ",%.1f,%.2f", 100.0 * share[static_cast<std::size_t>(d)], aff[static_cast<std::size_t>(d)]);
            }
            std::fprintf(f, "\n");
        }
    }
    std::fclose(f);
    return true;
}

}  // namespace ws
