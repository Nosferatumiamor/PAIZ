#include "WeightStream/RouterLookahead.h"

#include "WeightStream/GGUFReader.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <numeric>

namespace ws {

namespace {

// "blk.12.ffn_gate_inp.weight" -> 12, "ffn_gate_inp.weight" (the part after the layer number)
bool split_layer(const std::string& name, int& layer, std::string& rest) {
    if (name.rfind("blk.", 0) != 0) {
        return false;
    }
    const std::size_t dot = name.find('.', 4);
    if (dot == std::string::npos) {
        return false;
    }
    try {
        layer = std::stoi(name.substr(4, dot - 4));
    } catch (...) {
        return false;
    }
    rest = name.substr(dot + 1);
    return true;
}

bool read_f32(const GGUFReader& reader, const TensorInfo& t, std::vector<float>& out) {
    if (t.type != TensorType::F32) {
        return false;
    }
    std::vector<std::byte> bytes;
    if (!reader.read_tensor_bytes(t, bytes) || bytes.size() % sizeof(float) != 0) {
        return false;
    }
    out.resize(bytes.size() / sizeof(float));
    std::memcpy(out.data(), bytes.data(), bytes.size());
    return true;
}

}  // namespace

bool RouterLookahead::open(const std::filesystem::path& gguf_path) {
    layers_.clear();
    n_embd_ = 0;
    n_expert_ = 0;

    GGUFReader reader(gguf_path);
    if (!reader.valid()) {
        error_ = "cannot read GGUF: " + reader.error();
        return false;
    }
    for (const TensorInfo& t : reader.tensors()) {
        int layer = -1;
        std::string rest;
        if (!split_layer(t.name, layer, rest) || layer < 0) {
            continue;
        }
        if (layers_.size() <= static_cast<std::size_t>(layer)) {
            layers_.resize(static_cast<std::size_t>(layer) + 1);
        }
        Router& r = layers_[static_cast<std::size_t>(layer)];
        if (rest == "ffn_gate_inp.weight" && t.dimensions.size() == 2) {
            const auto embd = static_cast<std::size_t>(t.dimensions[0]);
            const auto experts = static_cast<std::size_t>(t.dimensions[1]);
            if ((n_embd_ != 0 && embd != n_embd_) || (n_expert_ != 0 && experts != n_expert_) || !read_f32(reader, t, r.weight)) {
                r.weight.clear();
                continue;
            }
            n_embd_ = embd;
            n_expert_ = experts;
        } else if (rest == "exp_probs_b.bias") {
            read_f32(reader, t, r.bias);
        } else if (rest == "ffn_gate_inp.scale") {
            read_f32(reader, t, r.scale);
        }
    }
    if (n_expert_ == 0) {
        error_ = "no F32 MoE router in " + gguf_path.string();
        return false;
    }
    return true;
}

bool RouterLookahead::has_layer(int layer) const {
    return layer >= 0 && static_cast<std::size_t>(layer) < layers_.size() && !layers_[static_cast<std::size_t>(layer)].weight.empty();
}

std::vector<std::int32_t> RouterLookahead::predict(int layer, const float* x, std::size_t n_tokens, std::size_t stride,
                                                   std::size_t per_token, std::size_t max_total) const {
    if (!has_layer(layer) || n_tokens == 0 || per_token == 0) {
        return {};
    }
    const Router& r = layers_[static_cast<std::size_t>(layer)];
    const bool has_bias = r.bias.size() == n_expert_;
    const bool has_scale = r.scale.size() == n_embd_;
    per_token = std::min(per_token, n_expert_);

    // a long prompt block only needs a sample of its tokens to know which experts most of them use
    constexpr std::size_t kMaxSampled = 16;
    const std::size_t step = std::max<std::size_t>(1, n_tokens / kMaxSampled);

    std::vector<float> xs(n_embd_);
    std::vector<float> score(n_expert_);
    std::vector<std::int32_t> order(n_expert_);
    std::vector<std::uint32_t> votes(n_expert_, 0);
    for (std::size_t tok = 0; tok < n_tokens; tok += step) {
        const float* col = x + tok * stride;
        for (std::size_t i = 0; i < n_embd_; ++i) {
            xs[i] = has_scale ? col[i] * r.scale[i] : col[i];
        }
        for (std::size_t e = 0; e < n_expert_; ++e) {
            const float* w = r.weight.data() + e * n_embd_;
            float acc = 0.0f;
            for (std::size_t i = 0; i < n_embd_; ++i) {
                acc += w[i] * xs[i];
            }
            // sigmoid gating selects on sigmoid(logit) + bias; softmax gating on the logit order
            score[e] = has_bias ? 1.0f / (1.0f + std::exp(-acc)) + r.bias[e] : acc;
        }
        std::iota(order.begin(), order.end(), 0);
        std::partial_sort(order.begin(), order.begin() + static_cast<std::ptrdiff_t>(per_token), order.end(),
                          [&](std::int32_t a, std::int32_t b) { return score[static_cast<std::size_t>(a)] > score[static_cast<std::size_t>(b)]; });
        for (std::size_t k = 0; k < per_token; ++k) {
            ++votes[static_cast<std::size_t>(order[k])];
        }
    }

    std::vector<std::int32_t> out;
    for (std::size_t e = 0; e < n_expert_; ++e) {
        if (votes[e] > 0) {
            out.push_back(static_cast<std::int32_t>(e));
        }
    }
    std::stable_sort(out.begin(), out.end(), [&](std::int32_t a, std::int32_t b) {
        return votes[static_cast<std::size_t>(a)] > votes[static_cast<std::size_t>(b)];
    });
    if (out.size() > max_total) {
        out.resize(max_total);
    }
    return out;
}

}  // namespace ws
