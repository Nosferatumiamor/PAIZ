#include "WeightStream/TierCache.h"

#include "WeightStream/CacheInvariants.h"
#include "WeightStream/Config.h"
#include "WeightStream/SystemMemoryGuard.h"

#include "WeightStream/CrashLog.h"
#include "WeightStream/SafeMemcpy.h"

#ifdef WEIGHTSTREAM_HAS_CUDA
#include <cuda_runtime.h>
#endif

#include <cstring>
#include <stdexcept>
#include <unordered_map>

namespace ws {

namespace {

#ifdef WEIGHTSTREAM_HAS_CUDA
void check_cuda(cudaError_t err, const char* what) {
    if (err != cudaSuccess) {
        throw std::runtime_error(std::string(what) + ": " + cudaGetErrorString(err));
    }
}
#endif

}  // namespace

TierCache::TierCache(std::size_t capacity_bytes, MemoryKind kind)
    : capacity_(capacity_bytes), kind_(kind) {}

void TierCache::free_entry_storage(Entry& entry) {
#ifdef WEIGHTSTREAM_HAS_CUDA
    if (kind_ == MemoryKind::Device && entry.device_ptr != nullptr) {
        check_cuda(cudaFree(entry.device_ptr), "cudaFree");
        entry.device_ptr = nullptr;
    }
#endif
    entry.host_buffer.clear();
    entry.host_buffer.shrink_to_fit();
    entry.byte_size = 0;
}

std::byte* TierCache::entry_data(Entry& entry) const {
#ifdef WEIGHTSTREAM_HAS_CUDA
    if (kind_ == MemoryKind::Device) {
        return static_cast<std::byte*>(entry.device_ptr);
    }
#endif
    return entry.host_buffer.data();
}

const std::byte* TierCache::entry_data(const Entry& entry) const {
    return const_cast<TierCache*>(this)->entry_data(const_cast<Entry&>(entry));
}

std::size_t TierCache::used() const {
    std::lock_guard lock(mutex_);
    return used_;
}

std::size_t TierCache::entry_count() const {
    std::lock_guard lock(mutex_);
    return entries_.size();
}

std::size_t TierCache::free_space() const {
    std::lock_guard lock(mutex_);
    return used_ >= capacity_ ? 0 : capacity_ - used_;
}

bool TierCache::set_capacity(std::size_t new_capacity_bytes) {
    std::lock_guard lock(mutex_);

    capacity_ = new_capacity_bytes;
    while (used_ > capacity_) {
        if (!evict_one()) {
            return false;
        }
    }
    return true;
}

bool TierCache::ensure_free_space(std::size_t bytes) {
    std::lock_guard lock(mutex_);

    if (bytes > capacity_) {
        return false;
    }

    if (kind_ == MemoryKind::Host && guard_config_ != nullptr) {
        const bool hot = !page_hot_fn_ || page_hot_fn_(0);
        SystemMemoryGuard::wait_before_host_growth(*guard_config_, bytes, used_, hot);
    }

    while (used_ + bytes > capacity_) {
        if (!evict_one()) {
            return false;
        }
    }

    if (invariants_enabled_) {
        validate_invariants_unlocked("ensure_free_space");
    }

    return true;
}

std::optional<std::size_t> TierCache::allocate(std::uint64_t key, std::size_t size) {
    std::lock_guard lock(mutex_);

    if (size > capacity_) {
        return std::nullopt;
    }

    if (kind_ == MemoryKind::Host && guard_config_ != nullptr) {
        const bool hot = !page_hot_fn_ || page_hot_fn_(key);
        SystemMemoryGuard::wait_before_host_growth(*guard_config_, size, used_, hot);
    }

    auto existing = entries_.find(key);
    if (existing != entries_.end()) {
        if (existing->second.byte_size != size) {
            char buf[256];
            std::snprintf(buf,
                          sizeof(buf),
                          "[WeightStream] allocate size mismatch key=0x%llx existing=%zu requested=%zu",
                          static_cast<unsigned long long>(key),
                          existing->second.byte_size,
                          size);
            crash_log(buf);
            std::abort();
        }
        lru_.remove(key);
        lru_.push_front(key);
        return existing->second.offset;
    }

    while (used_ + size > capacity_) {
        if (!evict_one()) {
            return std::nullopt;
        }
    }

    if (used_ + size > capacity_) {
        return std::nullopt;
    }

    Entry entry;
    entry.byte_size = size;
    entry.offset = next_offset_;
    next_offset_ += size;

#ifdef WEIGHTSTREAM_HAS_CUDA
    if (kind_ == MemoryKind::Device) {
        check_cuda(cudaMalloc(&entry.device_ptr, size), "cudaMalloc");
    } else
#endif
    {
        entry.host_buffer.resize(size);
    }

    entries_.emplace(key, std::move(entry));
    lru_.push_front(key);
    used_ += size;
    if (invariants_enabled_) {
        validate_invariants_unlocked("allocate");
    }
    return entries_[key].offset;
}

void TierCache::release(std::uint64_t key) {
    std::lock_guard lock(mutex_);
    auto it = entries_.find(key);
    if (it == entries_.end()) {
        if (invariants_enabled_) {
            check_invariant(true, false, "release", "release() on unknown key 0x" + std::to_string(key));
        }
        return;
    }
    used_ -= it->second.byte_size;
    free_entry_storage(it->second);
    lru_.remove(key);
    entries_.erase(it);
    if (invariants_enabled_) {
        validate_invariants_unlocked("release");
    }
}

bool TierCache::contains(std::uint64_t key) const {
    std::lock_guard lock(mutex_);
    return entries_.find(key) != entries_.end();
}

std::optional<std::size_t> TierCache::offset_of(std::uint64_t key) const {
    std::lock_guard lock(mutex_);
    auto it = entries_.find(key);
    if (it == entries_.end()) {
        return std::nullopt;
    }
    return it->second.offset;
}

std::size_t TierCache::size_of(std::uint64_t key) const {
    std::lock_guard lock(mutex_);
    auto it = entries_.find(key);
    if (it == entries_.end()) {
        return 0;
    }
    return it->second.byte_size;
}

std::byte* TierCache::data_at(std::size_t offset) {
    std::lock_guard lock(mutex_);
    for (auto& [key, entry] : entries_) {
        (void)key;
        if (entry.offset == offset) {
            return entry_data(entry);
        }
    }
    return nullptr;
}

const std::byte* TierCache::data_at(std::size_t offset) const {
    std::lock_guard lock(mutex_);
    for (const auto& [key, entry] : entries_) {
        (void)key;
        if (entry.offset == offset) {
            return entry_data(entry);
        }
    }
    return nullptr;
}

std::byte* TierCache::data_for_key(std::uint64_t key) {
    std::lock_guard lock(mutex_);
    auto it = entries_.find(key);
    if (it == entries_.end()) {
        return nullptr;
    }
    return entry_data(it->second);
}

const std::byte* TierCache::data_for_key(std::uint64_t key) const {
    std::lock_guard lock(mutex_);
    auto it = entries_.find(key);
    if (it == entries_.end()) {
        return nullptr;
    }
    return entry_data(it->second);
}

bool TierCache::copy_from_key(std::uint64_t key, std::size_t offset, void* dst, std::size_t size) const {
    if (dst == nullptr || size == 0) {
        return false;
    }

    std::lock_guard lock(mutex_);
    auto it = entries_.find(key);
    if (it == entries_.end()) {
        return false;
    }

    const std::size_t entry_size = it->second.byte_size;
    if (offset > entry_size || size > entry_size - offset) {
        return false;
    }

    const std::byte* src = entry_data(it->second);
    safe_memcpy(dst, size, src + offset, entry_size - offset, size, "TierCache::copy_from_key");
    if (invariants_enabled_) {
        validate_invariants_unlocked("copy_from_key");
    }
    return true;
}

bool TierCache::write_via_key(std::uint64_t key,
                              const std::function<bool(std::byte* dst, std::size_t size)>& writer) {
    if (!writer) {
        return false;
    }

    std::lock_guard lock(mutex_);
    auto it = entries_.find(key);
    if (it == entries_.end()) {
        return false;
    }

    std::byte* dst = entry_data(it->second);
    return writer(dst, it->second.byte_size);
}

bool TierCache::store_into_key(std::uint64_t key, std::size_t offset, const void* src, std::size_t size) {
    if (src == nullptr || size == 0) {
        return false;
    }

    std::lock_guard lock(mutex_);
    auto it = entries_.find(key);
    if (it == entries_.end()) {
        return false;
    }

    const std::size_t entry_size = it->second.byte_size;
    if (offset > entry_size || size > entry_size - offset) {
        return false;
    }

    std::byte* dst = entry_data(it->second);
    safe_memcpy(dst + offset, entry_size - offset, src, size, size, "TierCache::store_into_key");
    if (invariants_enabled_) {
        validate_invariants_unlocked("store_into_key");
    }
    return true;
}

bool TierCache::evict_one() {
    if (entries_.empty()) {
        return false;
    }

    std::uint64_t victim = 0;
    bool found = false;

    if (eviction_priority_) {
        std::uint64_t best = 0;
        for (const auto& [key, entry] : entries_) {
            (void)entry;
            if (pin_predicate_ && pin_predicate_(key)) {
                continue;
            }
            const std::uint64_t priority = eviction_priority_(key);
            if (!found || priority >= best) {
                best = priority;
                victim = key;
                found = true;
            }
        }
    } else {
        for (auto it = lru_.rbegin(); it != lru_.rend(); ++it) {
            if (pin_predicate_ && pin_predicate_(*it)) {
                continue;
            }
            victim = *it;
            found = true;
            break;
        }
    }

    if (!found) {
        return false;
    }

    if (invariants_enabled_) {
        check_invariant(true, entries_.find(victim) != entries_.end(), "evict_one",
                        "LRU victim 0x" + std::to_string(victim) + " missing from entries");
        check_invariant(true, !(pin_predicate_ && pin_predicate_(victim)), "evict_one",
                        "evicting pinned page 0x" + std::to_string(victim));
    }

    auto entry_it = entries_.find(victim);
    if (entry_it == entries_.end()) {
        return false;
    }

    if (invariants_enabled_) {
        check_invariant(true, entry_it->second.byte_size > 0, "evict_one",
                        "evicting entry with zero byte_size");
    }

    if (demotion_handler_) {
        demotion_handler_(victim, entry_data(entry_it->second), entry_it->second.byte_size);
    }

    used_ -= entry_it->second.byte_size;
    free_entry_storage(entry_it->second);
    lru_.remove(victim);
    entries_.erase(entry_it);
    ++evictions_;

    if (evict_notify_) {
        evict_notify_(victim);
    }

    if (invariants_enabled_) {
        validate_invariants_unlocked("evict_one");
    }

    return true;
}

void TierCache::set_eviction_priority(std::function<std::uint64_t(std::uint64_t)> priority) {
    std::lock_guard lock(mutex_);
    eviction_priority_ = std::move(priority);
}

void TierCache::set_demotion_handler(
    std::function<void(std::uint64_t, const std::byte*, std::size_t)> handler) {
    std::lock_guard lock(mutex_);
    demotion_handler_ = std::move(handler);
}

void TierCache::set_evict_notify(std::function<void(std::uint64_t)> notify) {
    std::lock_guard lock(mutex_);
    evict_notify_ = std::move(notify);
}

void TierCache::set_pin_predicate(std::function<bool(std::uint64_t)> predicate) {
    std::lock_guard lock(mutex_);
    pin_predicate_ = std::move(predicate);
}

void TierCache::clear() {
    std::lock_guard lock(mutex_);
    for (auto& [key, entry] : entries_) {
        (void)key;
        free_entry_storage(entry);
    }
    entries_.clear();
    lru_.clear();
    used_ = 0;
    next_offset_ = 0;
}

void TierCache::validate_invariants(bool enabled, const char* where) const {
    if (!enabled) {
        return;
    }

    std::lock_guard lock(mutex_);
    validate_invariants_unlocked(where);
}

void TierCache::validate_invariants_unlocked(const char* where) const {
    const bool enabled = true;

    std::size_t sum_bytes = 0;
    std::unordered_map<std::uint64_t, std::size_t> lru_counts;
    for (const std::uint64_t key : lru_) {
        ++lru_counts[key];
    }

    for (const auto& [key, entry] : entries_) {
        sum_bytes += entry.byte_size;
        check_invariant(enabled, entry.byte_size > 0, where,
                        "entry byte_size must be > 0 for key 0x" + std::to_string(key));
        check_invariant(enabled, lru_counts[key] >= 1, where,
                        "entry key 0x" + std::to_string(key) + " missing from LRU list");
#ifdef WEIGHTSTREAM_HAS_CUDA
        if (kind_ == MemoryKind::Host)
#endif
        {
            check_invariant(enabled, entry.host_buffer.size() == entry.byte_size, where,
                            "host_buffer.size mismatch for key 0x" + std::to_string(key));
        }
    }

    check_invariant(enabled, used_ == sum_bytes, where,
                    "used_ (" + std::to_string(used_) + ") != sum(byte_size) (" +
                        std::to_string(sum_bytes) + ")");
    check_invariant(enabled, used_ <= capacity_, where,
                    "used_ (" + std::to_string(used_) + ") > capacity (" + std::to_string(capacity_) +
                        ")");
    check_invariant(enabled, entries_.size() == lru_counts.size(), where,
                    "entries_.size() (" + std::to_string(entries_.size()) + ") != unique LRU keys (" +
                        std::to_string(lru_counts.size()) + ")");

    for (const auto& [key, count] : lru_counts) {
        check_invariant(enabled, count == 1, where,
                        "LRU key 0x" + std::to_string(key) + " appears " + std::to_string(count) + " times");
        (void)key;
    }
}

std::vector<std::uint64_t> TierCache::resident_keys() const {
    std::lock_guard lock(mutex_);
    std::vector<std::uint64_t> keys;
    keys.reserve(entries_.size());
    for (const auto& [key, entry] : entries_) {
        (void)entry;
        keys.push_back(key);
    }
    return keys;
}

void TierCache::validate_paranoid_extras(bool enabled, const char* where) const {
    if (!enabled) {
        return;
    }

    std::lock_guard lock(mutex_);
    validate_paranoid_unlocked(where);
}

void TierCache::validate_paranoid_unlocked(const char* where) const {
    const bool enabled = true;

    std::unordered_map<std::uint64_t, std::size_t> lru_counts;
    for (const std::uint64_t key : lru_) {
        ++lru_counts[key];
    }

    for (const std::uint64_t key : lru_) {
        check_invariant(enabled, entries_.find(key) != entries_.end(), where,
                        "LRU key 0x" + std::to_string(key) + " has no entries_ record");
    }

    std::unordered_map<std::size_t, std::uint64_t> offset_owner;
    for (const auto& [key, entry] : entries_) {
        check_invariant(enabled, entry_data(const_cast<Entry&>(entry)) != nullptr, where,
                        "key 0x" + std::to_string(key) + " has null storage pointer");
        const auto [it, inserted] = offset_owner.emplace(entry.offset, key);
        check_invariant(enabled, inserted, where,
                        "duplicate cache offset " + std::to_string(entry.offset) + " for keys 0x" +
                            std::to_string(it->second) + " and 0x" + std::to_string(key));
    }

    std::size_t lru_len = 0;
    for (const auto& [key, count] : lru_counts) {
        (void)key;
        lru_len += count;
    }
    check_invariant(enabled, lru_len == lru_.size(), where,
                    "LRU list length mismatch with counted nodes");
    check_invariant(enabled, lru_.size() == entries_.size(), where,
                    "LRU size (" + std::to_string(lru_.size()) + ") != entries_.size() (" +
                        std::to_string(entries_.size()) + ")");
}

}  // namespace ws
