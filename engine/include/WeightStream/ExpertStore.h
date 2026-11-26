#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace ws {

/// Serves the experts of a MoE GGUF (slices of its stacked `*_exps` tensors) from a fixed-size
/// RAM cache, reading misses straight from disk with unbuffered parallel I/O. Bypassing the OS
/// page cache keeps RAM use within the budget and lets many reads be in flight at once, instead of
/// the one-page-at-a-time faults an mmap gives when the model does not fit in RAM.
///
/// A profile (experts ranked by expected use) can be preloaded by a background thread. Its experts
/// are pinned so ordinary misses do not evict them, and demand reads always take priority over it.
///
/// The same thread serves asynchronous prefetches (experts a layer is predicted to need, read while
/// the previous layer computes), and the cache can be resized between turns within the address range
/// reserved at open(), which is what lets several models share one memory budget (see ExpertBudget).
class ExpertStore {
public:
    struct Request {
        const char* tensor_name = nullptr;  // must stay valid while the store is open (it is cached by pointer)
        std::int64_t expert = 0;
        std::size_t expert_bytes = 0;  // checked against the GGUF layout
        const void* data = nullptr;    // out: valid until the next fetch()
    };

    struct Stats {
        std::uint64_t fetch_calls = 0;
        std::uint64_t requests = 0;
        std::uint64_t ram_hits = 0;
        std::uint64_t waits_on_preload = 0;  // hits on an expert the preloader was still reading
        std::uint64_t disk_reads = 0;
        std::uint64_t disk_bytes = 0;
        double disk_seconds = 0.0;  // wall time demand fetches spent waiting for reads
        std::uint64_t preload_reads = 0;
        std::uint64_t preload_bytes = 0;
        std::uint64_t prefetch_reads = 0;  // experts read ahead by prefetch()
        std::uint64_t prefetch_bytes = 0;
        std::uint64_t prefetch_hits = 0;   // demand requests served by a prefetched expert (its first use)
        std::uint64_t group_reads = 0;     // sibling tensors read along with a demand miss (set_group_layer_reads)
        std::uint64_t resizes = 0;
    };

    struct ProfileProgress {
        std::size_t resident = 0;  // pinned experts of the profile already in RAM
        std::size_t target = 0;    // pinned experts the profile asks for
        bool loading = false;      // the preloader still has work queued or in flight
    };

    ExpertStore();
    ~ExpertStore();

    ExpertStore(const ExpertStore&) = delete;
    ExpertStore& operator=(const ExpertStore&) = delete;

    /// Indexes the experts of `gguf_path` and commits `ram_budget_bytes` of RAM for cached experts. Address
    /// space is reserved for `max_budget_bytes` (0 = the budget), the ceiling for later resize() calls.
    bool open(const std::filesystem::path& gguf_path, std::size_t ram_budget_bytes, std::size_t max_budget_bytes = 0);
    void close();

    /// Resolves every request, reading all RAM misses in parallel.
    bool fetch(Request* requests, std::size_t count);

    /// Sequential unbuffered read of bytes [offset, offset + nbytes) of an expert tensor (by GGUF name) into `dst`, which must be
    /// sector-aligned and hold round_up(skew + nbytes, sector) bytes; the data starts at dst + *skew_out. Does not use the cache slots and may
    /// run on another thread than fetch(): it is how a prefill batch that needs a whole layer streams it from the SSD in big reads.
    bool bulk_read(const char* tensor_name, std::size_t offset, std::size_t nbytes, void* dst, std::size_t dst_capacity, std::size_t* skew_out);

    /// Starts reading, in the background, every expert tensor of `layer` for these experts, replacing any
    /// prefetch not started yet. A later fetch() of one of them waits for the read instead of issuing its own.
    void prefetch(int layer, const std::int32_t* experts, std::size_t count);

    /// When on, a demand miss also reads the other expert tensors of the same layer for that expert (gate, up
    /// and down are fetched one op at a time by the CPU backend, so this turns three disk waits into one).
    void set_group_layer_reads(bool on);

    /// Grows or shrinks the cache (within the reserved range, never below the minimum). Shrinking evicts the
    /// slots beyond the new size and returns their memory to the OS. Must not overlap a fetch(): call it
    /// between turns. Background reads in flight are waited for.
    bool resize(std::size_t ram_budget_bytes);

    /// True while the store holds an open GGUF (the cache may be kept across a model unload / reload of the same file).
    bool is_open() const;
    /// The expert tensors are looked up by the address of their name string, which belongs to the loaded model: after the model was
    /// freed and loaded again those addresses are stale. Call this before serving the new model; the cached experts stay.
    void forget_tensor_pointers();
    std::size_t capacity_bytes() const;
    std::size_t max_capacity_bytes() const;
    std::size_t min_capacity_bytes() const;

    /// Pins and preloads (layer, expert) pairs in the given order, replacing the previous profile.
    /// At most `pin_fraction` of the cache is pinned; the rest stays an LRU for unexpected misses.
    void set_profile(const std::vector<std::pair<int, int>>& layer_experts, double pin_fraction = 0.75);
    ProfileProgress profile_progress() const;

    Stats stats() const;
    std::size_t slot_count() const;
    std::size_t slot_bytes() const;
    std::string last_error() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace ws
