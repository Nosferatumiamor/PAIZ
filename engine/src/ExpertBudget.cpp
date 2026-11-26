#include "WeightStream/ExpertBudget.h"

#include "WeightStream/ExpertStore.h"

#include <algorithm>

namespace ws {

bool ExpertBudget::add(ExpertStore* store, std::string name, std::size_t floor_bytes) {
    if (store == nullptr) {
        error_ = "null store";
        return false;
    }
    remove(store);
    const std::size_t floor = std::clamp(floor_bytes, store->min_capacity_bytes(), store->max_capacity_bytes());
    members_.push_back({store, std::move(name), floor});
    if (focused_ == nullptr) {
        focused_ = store;
    }
    return apply();
}

void ExpertBudget::remove(ExpertStore* store) {
    members_.erase(std::remove_if(members_.begin(), members_.end(), [&](const Member& m) { return m.store == store; }),
                   members_.end());
    if (focused_ == store) {
        focused_ = members_.empty() ? nullptr : members_.front().store;
    }
}

bool ExpertBudget::focus(ExpertStore* store) {
    const bool known = std::any_of(members_.begin(), members_.end(), [&](const Member& m) { return m.store == store; });
    if (!known) {
        error_ = "focus on a store that is not in the budget";
        return false;
    }
    focused_ = store;
    return apply();
}

bool ExpertBudget::set_total(std::size_t total_bytes) {
    total_ = total_bytes;
    return apply();
}

// shrinks first, grows after, so the sum of the caches never exceeds the budget on the way
bool ExpertBudget::apply() {
    std::size_t floors = 0;
    for (const Member& m : members_) {
        if (m.store != focused_) {
            floors += m.floor;
        }
    }
    std::vector<std::size_t> target(members_.size());
    for (std::size_t i = 0; i < members_.size(); ++i) {
        const Member& m = members_[i];
        if (m.store == focused_) {
            const std::size_t room = total_ > floors ? total_ - floors : 0;
            target[i] = std::clamp(room, m.store->min_capacity_bytes(), m.store->max_capacity_bytes());
        } else {
            target[i] = m.floor;
        }
    }
    bool ok = true;
    for (int pass = 0; pass < 2; ++pass) {
        for (std::size_t i = 0; i < members_.size(); ++i) {
            ExpertStore* s = members_[i].store;
            const bool shrinking = target[i] < s->capacity_bytes();
            if ((pass == 0) == shrinking && target[i] != s->capacity_bytes() && !s->resize(target[i])) {
                error_ = members_[i].name + ": " + s->last_error();
                ok = false;
            }
        }
    }
    return ok;
}

std::vector<ExpertBudget::Allocation> ExpertBudget::allocation() const {
    std::vector<Allocation> out;
    for (const Member& m : members_) {
        out.push_back({m.name, m.store->capacity_bytes(), m.store == focused_});
    }
    return out;
}

}  // namespace ws
