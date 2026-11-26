#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace ws {

class ExpertStore;

/// Shares one RAM budget between the expert caches of several models loaded side by side (two LLMs that take
/// turns, an LLM next to another generator...). The model in focus gets everything the others do not keep as
/// their "warm" floor; switching focus shrinks the previous one to its floor (its hottest experts stay) and
/// grows the new one, without reloading either model. set_total() moves the whole window, e.g. to give memory
/// back to the system or to an image model for a while.
///
/// All calls resize stores, so they must happen between turns (no fetch() running on any member).
/// Only the expert caches are managed here; each model's shared weights and KV cache are outside the budget.
class ExpertBudget {
public:
    struct Allocation {
        std::string name;
        std::size_t bytes = 0;
        bool focused = false;
    };

    explicit ExpertBudget(std::size_t total_bytes) : total_(total_bytes) {}

    /// Adds a store that keeps at least `floor_bytes` while another model is in focus (clamped to what
    /// the store can hold). The first store added gets the focus.
    bool add(ExpertStore* store, std::string name, std::size_t floor_bytes);
    void remove(ExpertStore* store);

    bool focus(ExpertStore* store);
    bool set_total(std::size_t total_bytes);

    std::size_t total() const { return total_; }
    std::vector<Allocation> allocation() const;
    const std::string& error() const { return error_; }

private:
    struct Member {
        ExpertStore* store = nullptr;
        std::string name;
        std::size_t floor = 0;
    };

    bool apply();

    std::vector<Member> members_;
    ExpertStore* focused_ = nullptr;
    std::size_t total_ = 0;
    std::string error_;
};

}  // namespace ws
