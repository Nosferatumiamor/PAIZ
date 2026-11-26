#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <list>
#include <mutex>
#include <optional>
#include <unordered_map>
#include <vector>

namespace ws {

struct Config;

enum class MemoryKind {
    Host,
    Device,
};

/// Fixed-capacity cache with LRU eviction. Each entry owns its own buffer.
class TierCache {
public:
    explicit TierCache(std::size_t capacity_bytes, MemoryKind kind = MemoryKind::Host);

    MemoryKind memory_kind() const { return kind_; }
    bool is_device() const { return kind_ == MemoryKind::Device; }

    std::size_t capacity() const { return capacity_; }
    bool set_capacity(std::size_t new_capacity_bytes);
    std::size_t used() const;
    std::size_t entry_count() const;
    std::size_t free_space() const;

    /// Evict until at least `bytes` can be allocated (returns false if impossible).
    bool ensure_free_space(std::size_t bytes);

    std::optional<std::size_t> allocate(std::uint64_t key, std::size_t size);
    void release(std::uint64_t key);
    bool contains(std::uint64_t key) const;
    std::optional<std::size_t> offset_of(std::uint64_t key) const;
    std::size_t size_of(std::uint64_t key) const;

    std::byte* data_at(std::size_t offset);
    const std::byte* data_at(std::size_t offset) const;
    std::byte* data_for_key(std::uint64_t key);
    const std::byte* data_for_key(std::uint64_t key) const;

    /// Copy bytes from an entry while its storage lock is held (safe under concurrent eviction).
    bool copy_from_key(std::uint64_t key, std::size_t offset, void* dst, std::size_t size) const;

    /// Invoke `reader` with a pointer to entry storage while the cache mutex is held.
    bool write_via_key(std::uint64_t key,
                       const std::function<bool(std::byte* dst, std::size_t size)>& writer);

    /// Copy into an existing entry while the cache mutex is held.
    bool store_into_key(std::uint64_t key, std::size_t offset, const void* src, std::size_t size);

    std::uint64_t evictions() const { return evictions_; }

    /// Snapshot of resident keys (for paranoid cross-checks).
    std::vector<std::uint64_t> resident_keys() const;

    void clear();

    /// Abort on first internal consistency violation when `enabled` is true.
    void validate_invariants(bool enabled, const char* where) const;

    /// Extra DEBUG_PARANOID tier checks.
    void validate_paranoid_extras(bool enabled, const char* where) const;

    void set_invariants_enabled(bool enabled) { invariants_enabled_ = enabled; }

    /// Prevent LRU eviction while predicate returns true for a key.
    void set_pin_predicate(std::function<bool(std::uint64_t)> predicate);

    /// Belady-style eviction: evict the key with the largest priority (furthest next use).
    void set_eviction_priority(std::function<std::uint64_t(std::uint64_t)> priority);

    /// Called before a victim is dropped; copy bytes elsewhere (e.g. VRAM -> RAM demotion).
    void set_demotion_handler(std::function<void(std::uint64_t key, const std::byte* data, std::size_t size)> handler);

    /// Called after demotion, immediately before the entry is erased (state sync).
    void set_evict_notify(std::function<void(std::uint64_t key)> notify);

    /// Attach host RAM guard thresholds (RAM tier only; nullptr disables).
    void set_memory_guard_config(const Config* config) { guard_config_ = config; }

    /// HOT pages skip throttling during burst load; WARM pages use steady pacing.
    void set_page_hot_fn(std::function<bool(std::uint64_t)> predicate) {
        page_hot_fn_ = std::move(predicate);
    }

private:
    struct Entry {
        std::vector<std::byte> host_buffer;
        void* device_ptr = nullptr;
        std::size_t byte_size = 0;
        std::size_t offset = 0;
    };

    void free_entry_storage(Entry& entry);
    std::byte* entry_data(Entry& entry) const;
    const std::byte* entry_data(const Entry& entry) const;
    bool evict_one();
    void validate_invariants_unlocked(const char* where) const;
    void validate_paranoid_unlocked(const char* where) const;

    std::size_t capacity_;
    MemoryKind kind_;
    const Config* guard_config_ = nullptr;
    mutable std::mutex mutex_;

    std::unordered_map<std::uint64_t, Entry> entries_;
    std::list<std::uint64_t> lru_;
    std::size_t used_ = 0;
    std::size_t next_offset_ = 0;
    std::uint64_t evictions_ = 0;
    bool invariants_enabled_ = false;
    std::function<bool(std::uint64_t)> pin_predicate_;
    std::function<std::uint64_t(std::uint64_t)> eviction_priority_;
    std::function<void(std::uint64_t, const std::byte*, std::size_t)> demotion_handler_;
    std::function<void(std::uint64_t)> evict_notify_;
    std::function<bool(std::uint64_t)> page_hot_fn_;
};

}  // namespace ws
