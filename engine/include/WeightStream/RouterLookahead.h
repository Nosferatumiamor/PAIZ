#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace ws {

/// Guesses which experts a MoE layer will route to before that layer runs, by applying its router to the
/// activations of the layer before (the residual stream changes little from one layer to the next). The guess
/// only decides what ExpertStore reads ahead: the real routing still picks the experts, so a wrong guess costs
/// a wasted read, never a different result.
///
/// Uses the F32 router weights (`blk.N.ffn_gate_inp.weight`, [n_embd, n_expert]) and, when present, the
/// per-expert selection bias (`blk.N.exp_probs_b.bias`, sigmoid gating) and the input scale
/// (`blk.N.ffn_gate_inp.scale`). Layers with another router type are skipped.
class RouterLookahead {
public:
    bool open(const std::filesystem::path& gguf_path);

    bool has_layer(int layer) const;
    std::size_t n_embd() const { return n_embd_; }
    std::size_t n_expert() const { return n_expert_; }
    const std::string& error() const { return error_; }

    /// Experts `layer` is likely to use for `n_tokens` activation columns (each `n_embd` floats, `stride`
    /// floats apart). One token gives its top `per_token` experts; several tokens vote with their top
    /// `per_token` and the most voted experts are returned, at most `max_total`.
    std::vector<std::int32_t> predict(int layer, const float* x, std::size_t n_tokens, std::size_t stride,
                                      std::size_t per_token, std::size_t max_total) const;

private:
    struct Router {
        std::vector<float> weight;  // [n_expert][n_embd], empty if the layer has no usable router
        std::vector<float> bias;    // [n_expert] or empty
        std::vector<float> scale;   // [n_embd] or empty
    };

    std::vector<Router> layers_;
    std::size_t n_embd_ = 0;
    std::size_t n_expert_ = 0;
    std::string error_;
};

}  // namespace ws
