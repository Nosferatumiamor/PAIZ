#include "WeightStream/ExpertStore.h"

#include "WeightStream/GGUFReader.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <list>
#include <regex>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace ws {

namespace {

constexpr std::size_t kMinSector = 4096;
// fewer slots than this cannot hold the misses of one layer for a 32-token micro-batch; below it the hook falls
// back to the mmap pointers (still correct), so the floor only guards against absurd budgets
constexpr std::size_t kMinSlots = 24;
constexpr std::size_t kPreloadBatch = 16;   // reads the preloader keeps in flight
constexpr std::size_t kPrefetchBatch = 128; // most experts one prefetch() starts at once
// a prefetch may only evict slots no fetch() used in this many calls: the gate, up and down ops of the layer
// being computed fetch one after another and must still find what the previous op read along with them
constexpr std::uint64_t kPrefetchProtect = 4;

std::vector<std::filesystem::path> gguf_shards(const std::filesystem::path& first) {
    static const std::regex re(R"((.*)-(\d{5})-of-(\d{5})\.gguf)", std::regex::icase);
    const std::string name = first.filename().string();
    std::smatch m;
    std::vector<std::filesystem::path> out;
    if (std::regex_match(name, m, re)) {
        const int total = std::stoi(m[3].str());
        for (int i = 1; i <= total; ++i) {
            char suffix[32];
            std::snprintf(suffix, sizeof(suffix), "-%05d-of-%05d.gguf", i, total);
            out.push_back(first.parent_path() / (m[1].str() + suffix));
        }
    } else {
        out.push_back(first);
    }
    return out;
}

std::size_t round_up(std::size_t v, std::size_t a) {
    return (v + a - 1) / a * a;
}

struct TensorEntry {
    std::uint64_t file_offset = 0;  // absolute offset of expert 0 (in its shard)
    std::uint32_t shard = 0;        // index of the GGUF file holding the tensor (split models)
    std::size_t expert_bytes = 0;
    std::int64_t n_expert = 0;
    int layer = -1;
};

enum class SlotState { Empty, Loading, Ready };

struct Slot {
    std::uint64_t key = 0;
    std::size_t skew = 0;          // offset of the expert inside the sector-aligned read
    std::uint64_t generation = 0;  // fetch() that last returned it; not evictable until the next fetch()
    SlotState state = SlotState::Empty;
    bool pinned = false;
    bool prefetched = false;       // read by prefetch() and not requested since
    std::list<std::uint32_t>::iterator lru_pos;
};

// "blk.12.ffn_up_exps.weight" -> 12
int layer_of(const std::string& name) {
    if (name.rfind("blk.", 0) != 0) {
        return -1;
    }
    try {
        return std::stoi(name.substr(4));
    } catch (...) {
        return -1;
    }
}

}  // namespace

#ifdef _WIN32

struct ExpertStore::Impl {
    std::vector<HANDLE> files;  // one handle per GGUF shard
    std::size_t sector = kMinSector;

    std::vector<TensorEntry> tensors;
    std::vector<std::vector<std::uint32_t>> tensors_of_layer;
    std::unordered_map<std::string, std::uint32_t> tensor_by_name;
    std::unordered_map<const char*, std::uint32_t> tensor_by_ptr;

    std::byte* arena = nullptr;  // reserved for max_slots, committed for slots.size()
    std::size_t max_slots = 0;
    std::size_t slot_bytes = 0;
    bool group_layer_reads = false;
    std::vector<Slot> slots;
    std::vector<std::uint32_t> free_slots;
    std::list<std::uint32_t> lru;  // front = most recently used
    std::unordered_map<std::uint64_t, std::uint32_t> slot_of_key;
    std::uint64_t generation = 0;

    // profile preloading, all guarded by mu
    std::vector<std::uint64_t> pin_order;
    std::unordered_set<std::uint64_t> pin_keys;
    std::size_t pin_cursor = 0;
    std::size_t pin_resident = 0;
    bool preload_in_flight = false;

    // prefetch requests not started yet (replaced by each prefetch() call), guarded by mu
    std::vector<std::uint64_t> prefetch_queue;
    bool prefetch_in_flight = false;

    mutable std::mutex mu;
    std::condition_variable cv_ready;  // a Loading slot became Ready
    std::condition_variable cv_work;   // preload work or demand finished
    std::atomic<int> demand_active{0};
    bool stop = false;
    std::thread worker;

    struct Pending {
        std::uint32_t slot = 0;
        std::uint32_t shard = 0;
        DWORD length = 0;
        DWORD need = 0;  // bytes actually wanted: the aligned read may run past the end of a shard
        OVERLAPPED ov{};
    };
    std::vector<Pending> pending;
    std::vector<HANDLE> events;
    std::vector<Pending> preload_pending;
    std::vector<HANDLE> preload_events;

    Stats stats;
    std::string error;

    ~Impl() { release(); }

    void release() {
        {
            std::lock_guard<std::mutex> lock(mu);
            stop = true;
        }
        cv_work.notify_all();
        if (worker.joinable()) {
            worker.join();
        }
        for (HANDLE e : events) CloseHandle(e);
        for (HANDLE e : preload_events) CloseHandle(e);
        events.clear();
        preload_events.clear();
        if (arena != nullptr) {
            VirtualFree(arena, 0, MEM_RELEASE);
            arena = nullptr;
        }
        for (HANDLE f : files) {
            if (f != INVALID_HANDLE_VALUE) {
                CloseHandle(f);
            }
        }
        files.clear();
        tensors.clear();
        tensors_of_layer.clear();
        tensor_by_name.clear();
        tensor_by_ptr.clear();
        slots.clear();
        free_slots.clear();
        lru.clear();
        slot_of_key.clear();
        pin_order.clear();
        pin_keys.clear();
        pin_cursor = 0;
        pin_resident = 0;
        prefetch_queue.clear();
        max_slots = 0;
        stop = false;
    }

    bool fail(std::string message) {
        std::lock_guard<std::mutex> lock(mu);
        error = std::move(message);
        return false;
    }

    std::byte* slot_data(std::uint32_t slot) { return arena + static_cast<std::size_t>(slot) * slot_bytes; }

    const std::uint32_t* lookup_tensor(const char* name) {
        if (const auto it = tensor_by_ptr.find(name); it != tensor_by_ptr.end()) {
            return &it->second;
        }
        const auto it = tensor_by_name.find(name);
        if (it == tensor_by_name.end()) {
            return nullptr;
        }
        return &(tensor_by_ptr[name] = it->second);
    }

    static std::uint64_t make_key(std::uint32_t tid, std::int64_t expert) {
        return (static_cast<std::uint64_t>(tid) << 32) | static_cast<std::uint64_t>(expert);
    }

    void unlink(std::uint32_t slot) {
        Slot& s = slots[slot];
        if (s.pinned && s.state == SlotState::Ready) {
            --pin_resident;
        }
        slot_of_key.erase(s.key);
        lru.erase(s.lru_pos);
        s.state = SlotState::Empty;
        s.pinned = false;
        s.prefetched = false;
    }

    // a free slot, else the least recently used evictable one: Ready, not handed out by the last `protect`
    // fetch() calls (1 = the current one), and unpinned unless `may_take_pinned`
    bool take_slot(std::uint32_t& out, bool may_take_pinned, std::uint64_t protect = 1) {
        if (!free_slots.empty()) {
            out = free_slots.back();
            free_slots.pop_back();
            return true;
        }
        for (int pass = 0; pass < (may_take_pinned ? 2 : 1); ++pass) {
            for (auto it = lru.rbegin(); it != lru.rend(); ++it) {
                const Slot& s = slots[*it];
                if (s.state != SlotState::Ready || s.generation + protect > generation || (s.pinned && pass == 0)) {
                    continue;
                }
                out = *it;
                unlink(out);
                return true;
            }
        }
        return false;
    }

    struct ReadRange {
        std::uint64_t offset;
        DWORD length;
        std::uint32_t shard;
        DWORD need;
    };

    // claims `slot` for `key`, returns the sector-aligned file range to read into it
    ReadRange assign(std::uint32_t slot, std::uint64_t key, bool pinned) {
        const TensorEntry& t = tensors[static_cast<std::size_t>(key >> 32)];
        const auto expert = static_cast<std::int64_t>(key & 0xFFFFFFFFull);
        const std::uint64_t begin = t.file_offset + static_cast<std::uint64_t>(expert) * t.expert_bytes;
        const std::uint64_t aligned = begin / sector * sector;
        Slot& s = slots[slot];
        s.key = key;
        s.skew = static_cast<std::size_t>(begin - aligned);
        s.state = SlotState::Loading;
        s.pinned = pinned;
        s.prefetched = false;
        lru.push_front(slot);
        s.lru_pos = lru.begin();
        slot_of_key[key] = slot;
        return {aligned, static_cast<DWORD>(round_up(s.skew + t.expert_bytes, sector)), t.shard, static_cast<DWORD>(s.skew + t.expert_bytes)};
    }

    void mark_ready(std::uint32_t slot) {
        Slot& s = slots[slot];
        s.state = SlotState::Ready;
        if (s.pinned) {
            ++pin_resident;
        }
    }

    // issues every read before the first wait, so the SSD sees them all at once; returns bytes read or -1
    long long read_all(std::vector<Pending>& batch, std::vector<HANDLE>& evs) {
        bool ok = true;
        for (std::size_t i = 0; i < batch.size(); ++i) {
            while (evs.size() <= i) {
                evs.push_back(CreateEventW(nullptr, TRUE, FALSE, nullptr));
            }
            ResetEvent(evs[i]);
            batch[i].ov.hEvent = evs[i];
            if (!ReadFile(files[batch[i].shard], slot_data(batch[i].slot), batch[i].length, nullptr, &batch[i].ov) &&
                GetLastError() != ERROR_IO_PENDING) {
                ok = false;
                batch[i].ov.hEvent = nullptr;
            }
        }
        long long bytes = 0;
        for (Pending& p : batch) {
            DWORD got = 0;
            if (p.ov.hEvent == nullptr || !GetOverlappedResult(files[p.shard], &p.ov, &got, TRUE) || got < p.need) {
                ok = false;
            }
            bytes += got;
        }
        return ok ? bytes : -1;
    }

    static Pending make_pending(std::uint32_t slot, ReadRange range) {
        Pending p;
        p.slot = slot;
        p.shard = range.shard;
        p.length = range.length;
        p.need = range.need;
        p.ov.Offset = static_cast<DWORD>(range.offset & 0xFFFFFFFFull);
        p.ov.OffsetHigh = static_cast<DWORD>(range.offset >> 32);
        return p;
    }

    // reads the queued prefetch in one batch, concurrently with demand fetches (it is for the next layer)
    void run_prefetch(std::unique_lock<std::mutex>& lock) {
        preload_pending.clear();
        for (const std::uint64_t key : prefetch_queue) {
            if (preload_pending.size() >= kPrefetchBatch) {
                break;
            }
            if (slot_of_key.count(key) != 0) {
                continue;
            }
            std::uint32_t slot = 0;
            if (!take_slot(slot, false, kPrefetchProtect)) {
                break;  // the cache is too small to read ahead without evicting what the current layer uses
            }
            preload_pending.push_back(make_pending(slot, assign(slot, key, pin_keys.count(key) != 0)));
            slots[slot].prefetched = true;
        }
        prefetch_queue.clear();
        if (preload_pending.empty()) {
            return;
        }

        prefetch_in_flight = true;
        lock.unlock();
        const long long bytes = read_all(preload_pending, preload_events);
        lock.lock();
        prefetch_in_flight = false;

        for (const Pending& p : preload_pending) {
            if (bytes < 0) {
                unlink(p.slot);
                free_slots.push_back(p.slot);
            } else {
                mark_ready(p.slot);
            }
        }
        if (bytes > 0) {
            stats.prefetch_reads += preload_pending.size();
            stats.prefetch_bytes += static_cast<std::uint64_t>(bytes);
        }
        cv_ready.notify_all();
    }

    void preload_loop() {
        std::unique_lock<std::mutex> lock(mu);
        while (true) {
            cv_work.wait(lock, [&] {
                return stop || !prefetch_queue.empty() || (pin_cursor < pin_order.size() && demand_active.load() == 0);
            });
            if (stop) {
                return;
            }
            if (!prefetch_queue.empty()) {
                run_prefetch(lock);
                continue;
            }
            preload_pending.clear();
            while (pin_cursor < pin_order.size() && preload_pending.size() < kPreloadBatch) {
                const std::uint64_t key = pin_order[pin_cursor];
                if (const auto it = slot_of_key.find(key); it != slot_of_key.end()) {
                    ++pin_cursor;
                    continue;
                }
                std::uint32_t slot = 0;
                if (!take_slot(slot, false)) {
                    pin_cursor = pin_order.size();  // everything left is pinned or in use: the profile is as loaded as it gets
                    break;
                }
                preload_pending.push_back(make_pending(slot, assign(slot, key, true)));
                ++pin_cursor;
            }
            if (preload_pending.empty()) {
                continue;
            }

            preload_in_flight = true;
            lock.unlock();
            const long long bytes = read_all(preload_pending, preload_events);
            lock.lock();
            preload_in_flight = false;

            for (const Pending& p : preload_pending) {
                if (bytes < 0) {
                    unlink(p.slot);
                    free_slots.push_back(p.slot);
                } else {
                    mark_ready(p.slot);
                }
            }
            if (bytes > 0) {
                stats.preload_reads += preload_pending.size();
                stats.preload_bytes += static_cast<std::uint64_t>(bytes);
            }
            cv_ready.notify_all();
        }
    }
};

ExpertStore::ExpertStore() : impl_(std::make_unique<Impl>()) {}
ExpertStore::~ExpertStore() = default;

bool ExpertStore::open(const std::filesystem::path& gguf_path, std::size_t ram_budget_bytes, std::size_t max_budget_bytes) {
    Impl& d = *impl_;
    d.release();
    d.stats = {};

    const std::vector<std::filesystem::path> shards = gguf_shards(gguf_path);
    std::size_t max_expert_bytes = 0;
    for (std::uint32_t shard = 0; shard < shards.size(); ++shard) {
        GGUFReader reader(shards[shard]);
        if (!reader.valid()) {
            return d.fail("cannot read GGUF " + shards[shard].string() + ": " + reader.error());
        }
        for (const TensorInfo& t : reader.tensors()) {
            if (t.name.find("_exps") == std::string::npos || t.dimensions.size() != 3) {
                continue;
            }
            const auto n_expert = static_cast<std::int64_t>(t.dimensions[2]);
            if (t.size == 0 || n_expert <= 0 || t.size % static_cast<std::uint64_t>(n_expert) != 0) {
                return d.fail("unsupported expert tensor layout: " + t.name);
            }
            TensorEntry e;
            e.file_offset = reader.data_offset() + t.offset;
            e.shard = shard;
            e.expert_bytes = static_cast<std::size_t>(t.size / static_cast<std::uint64_t>(n_expert));
            e.n_expert = n_expert;
            e.layer = layer_of(t.name);
            const auto tid = static_cast<std::uint32_t>(d.tensors.size());
            d.tensor_by_name.emplace(t.name, tid);
            d.tensors.push_back(e);
            if (const int layer = layer_of(t.name); layer >= 0) {
                if (d.tensors_of_layer.size() <= static_cast<std::size_t>(layer)) {
                    d.tensors_of_layer.resize(static_cast<std::size_t>(layer) + 1);
                }
                d.tensors_of_layer[static_cast<std::size_t>(layer)].push_back(tid);
            }
            max_expert_bytes = std::max(max_expert_bytes, e.expert_bytes);
        }
    }
    if (d.tensors.empty()) {
        return d.fail("no MoE expert tensors in " + gguf_path.string());
    }

    for (const auto& shard_path : shards) {
        HANDLE h = CreateFileW(shard_path.wstring().c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                               FILE_FLAG_NO_BUFFERING | FILE_FLAG_OVERLAPPED | FILE_FLAG_RANDOM_ACCESS, nullptr);
        if (h == INVALID_HANDLE_VALUE) {
            d.release();
            return d.fail("cannot open " + shard_path.string() + " for unbuffered reads");
        }
        d.files.push_back(h);
    }
    FILE_STORAGE_INFO storage{};
    if (GetFileInformationByHandleEx(d.files[0], FileStorageInfo, &storage, sizeof(storage))) {
        d.sector = std::max<std::size_t>(kMinSector, storage.LogicalBytesPerSector);
    }

    // an expert can start anywhere in a sector, so its aligned read spans one more sector
    d.slot_bytes = round_up(max_expert_bytes, d.sector) + d.sector;
    const std::size_t n_slots = ram_budget_bytes / d.slot_bytes;
    if (n_slots < kMinSlots) {
        d.release();
        return d.fail("RAM budget too small: need at least " + std::to_string(kMinSlots * d.slot_bytes / (1024 * 1024)) + " MiB");
    }
    d.max_slots = std::max(n_slots, max_budget_bytes / d.slot_bytes);
    d.arena = static_cast<std::byte*>(VirtualAlloc(nullptr, d.max_slots * d.slot_bytes, MEM_RESERVE, PAGE_READWRITE));
    if (d.arena == nullptr || VirtualAlloc(d.arena, n_slots * d.slot_bytes, MEM_COMMIT, PAGE_READWRITE) == nullptr) {
        d.release();
        return d.fail("cannot reserve " + std::to_string(n_slots * d.slot_bytes / (1024 * 1024)) + " MiB of RAM");
    }
    d.slots.resize(n_slots);
    d.free_slots.reserve(n_slots);
    for (std::size_t i = n_slots; i > 0; --i) {
        d.free_slots.push_back(static_cast<std::uint32_t>(i - 1));
    }
    d.worker = std::thread([&d] { d.preload_loop(); });
    return true;
}

void ExpertStore::close() {
    impl_->release();
}

bool ExpertStore::fetch(Request* requests, std::size_t count) {
    Impl& d = *impl_;
    if (d.arena == nullptr) {
        return d.fail("store is not open");
    }

    struct DemandGuard {
        Impl& d;
        explicit DemandGuard(Impl& impl) : d(impl) { ++d.demand_active; }
        ~DemandGuard() {
            --d.demand_active;
            d.cv_work.notify_all();
        }
    } guard(d);

    std::vector<std::uint32_t> wait_for;
    {
        std::unique_lock<std::mutex> lock(d.mu);
        ++d.generation;
        ++d.stats.fetch_calls;
        d.stats.requests += count;
        d.pending.clear();
        d.pending.reserve(count);

        // slots claimed earlier in this fetch would otherwise stay Loading forever
        auto abort_fetch = [&](std::string message) {
            for (const Impl::Pending& p : d.pending) {
                d.unlink(p.slot);
                d.free_slots.push_back(p.slot);
            }
            d.pending.clear();
            d.error = std::move(message);
            return false;
        };

        for (std::size_t i = 0; i < count; ++i) {
            Request& r = requests[i];
            const std::uint32_t* tid = d.lookup_tensor(r.tensor_name);
            if (tid == nullptr) {
                return abort_fetch(std::string("unknown expert tensor: ") + r.tensor_name);
            }
            const TensorEntry& t = d.tensors[*tid];
            if (r.expert < 0 || r.expert >= t.n_expert || r.expert_bytes != t.expert_bytes) {
                return abort_fetch(std::string("expert layout mismatch for ") + r.tensor_name);
            }
            const std::uint64_t key = Impl::make_key(*tid, r.expert);

            if (const auto it = d.slot_of_key.find(key); it != d.slot_of_key.end()) {
                Slot& s = d.slots[it->second];
                d.lru.erase(s.lru_pos);
                d.lru.push_front(it->second);
                s.lru_pos = d.lru.begin();
                s.generation = d.generation;
                r.data = d.slot_data(it->second) + s.skew;
                ++d.stats.ram_hits;
                if (s.prefetched) {
                    s.prefetched = false;
                    ++d.stats.prefetch_hits;
                }
                if (s.state == SlotState::Loading) {
                    wait_for.push_back(it->second);
                }
                continue;
            }

            std::uint32_t slot = 0;
            if (!d.take_slot(slot, true)) {
                return abort_fetch("RAM cache too small for one fetch");
            }
            const bool pinned = d.pin_keys.count(key) != 0;
            d.pending.push_back(Impl::make_pending(slot, d.assign(slot, key, pinned)));
            d.slots[slot].generation = d.generation;
            r.data = d.slot_data(slot) + d.slots[slot].skew;
        }

        // the other expert tensors of the same layer for each missed expert: read now, used by the next ops
        if (d.group_layer_reads) {
            const std::size_t n_demand = d.pending.size();
            for (std::size_t i = 0; i < n_demand; ++i) {
                const std::uint64_t key = d.slots[d.pending[i].slot].key;
                const TensorEntry& t = d.tensors[static_cast<std::size_t>(key >> 32)];
                if (t.layer < 0) {
                    continue;
                }
                const auto expert = static_cast<std::int64_t>(key & 0xFFFFFFFFull);
                for (const std::uint32_t sib : d.tensors_of_layer[static_cast<std::size_t>(t.layer)]) {
                    const std::uint64_t sib_key = Impl::make_key(sib, expert);
                    if (d.slot_of_key.count(sib_key) != 0) {
                        continue;
                    }
                    std::uint32_t slot = 0;
                    if (!d.take_slot(slot, false)) {
                        break;
                    }
                    d.pending.push_back(Impl::make_pending(slot, d.assign(slot, sib_key, d.pin_keys.count(sib_key) != 0)));
                    d.slots[slot].generation = d.generation;
                    ++d.stats.group_reads;
                }
            }
        }
    }

    bool ok = true;
    double d_disk_s = 0; std::size_t d_disk_n = 0, d_disk_b = 0;
    if (!d.pending.empty()) {
        const auto t0 = std::chrono::steady_clock::now();
        const long long bytes = d.read_all(d.pending, d.events);
        const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        d_disk_s = secs; d_disk_n = d.pending.size(); d_disk_b = bytes > 0 ? static_cast<std::size_t>(bytes) : 0;

        std::lock_guard<std::mutex> lock(d.mu);
        d.stats.disk_seconds += secs;
        d.stats.disk_reads += d.pending.size();
        ok = bytes >= 0;
        if (ok) {
            d.stats.disk_bytes += static_cast<std::uint64_t>(bytes);
        }
        for (const Impl::Pending& p : d.pending) {
            if (ok) {
                d.mark_ready(p.slot);
            } else {
                d.unlink(p.slot);
                d.free_slots.push_back(p.slot);
            }
        }
    }

    const auto tw0 = std::chrono::steady_clock::now();
    if (!wait_for.empty()) {
        std::unique_lock<std::mutex> lock(d.mu);
        d.stats.waits_on_preload += wait_for.size();
        d.cv_ready.wait(lock, [&] {
            return std::all_of(wait_for.begin(), wait_for.end(), [&](std::uint32_t s) { return d.slots[s].state != SlotState::Loading; });
        });
        for (std::uint32_t s : wait_for) {
            if (d.slots[s].state != SlotState::Ready) {
                ok = false;  // the preload of this expert failed and freed its slot
            }
        }
    }
    if (!ok) {
        return d.fail("unbuffered read failed");
    }
    {
        static const bool prof = std::getenv("WS_PROF") != nullptr;
        if (prof && count <= 64) {
            static double p_disk = 0, p_wait = 0; static std::size_t p_calls = 0, p_req = 0, p_dreads = 0, p_waits = 0, p_dbytes = 0;
            const auto now = std::chrono::steady_clock::now();
            p_wait += std::chrono::duration<double>(now - tw0).count();
            p_disk += d_disk_s; p_req += count; p_dreads += d_disk_n; p_dbytes += d_disk_b; p_waits += wait_for.size();
            if (++p_calls % 480 == 0) {
                std::fprintf(stderr, "[ws_prof] store, 10 tokens: %zu requests, %zu from SSD (%.0f MB, %.2fs), %zu waited on a prefetch (%.2fs)\n",
                    p_req, p_dreads, p_dbytes/1e6, p_disk, p_waits, p_wait);
                p_disk = p_wait = 0; p_req = p_dreads = p_waits = p_dbytes = 0;
            }
        }
    }
    return true;
}

// Reads `nbytes` from `offset` inside the stacked expert tensor `tensor_name` with sequential unbuffered reads (kChunk each, a sliding
// window of them in flight), for prefilling a big batch that touches almost every expert of a layer: one big read per tensor instead of
// one per expert. Independent of the cache: it does not touch the slots, so it can run on another thread than fetch().
bool ExpertStore::bulk_read(const char* tensor_name, std::size_t offset, std::size_t nbytes, void* dst, std::size_t dst_capacity, std::size_t* skew_out) {
    Impl& d = *impl_;
    const auto it = d.tensor_by_name.find(tensor_name);
    if (it == d.tensor_by_name.end() || d.files.empty()) {
        return false;
    }
    const TensorEntry& t = d.tensors[it->second];
    if (offset + nbytes > static_cast<std::size_t>(t.n_expert) * t.expert_bytes) {
        return false;
    }
    const std::uint64_t begin = t.file_offset + offset;
    const std::uint64_t aligned = begin / d.sector * d.sector;
    const std::size_t skew = static_cast<std::size_t>(begin - aligned);
    const std::size_t total = round_up(skew + nbytes, d.sector);
    if (total > dst_capacity || reinterpret_cast<std::uintptr_t>(dst) % d.sector != 0) {
        return false;
    }
    constexpr std::size_t kChunk = 4u << 20;
    constexpr std::size_t kWindow = 24;
    const std::size_t n_chunks = (total + kChunk - 1) / kChunk;
    struct Op { OVERLAPPED ov{}; HANDLE ev = nullptr; DWORD want = 0; DWORD need = 0; bool issued = false; };
    std::vector<Op> ops(std::min(n_chunks, kWindow));
    for (Op& o : ops) {
        o.ev = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    }
    HANDLE file = d.files[t.shard];
    bool ok = true;
    std::size_t next = 0;
    auto issue = [&](Op& o) {
        const std::size_t pos = next * kChunk;
        o.want = static_cast<DWORD>(std::min(kChunk, total - pos));
        o.need = static_cast<DWORD>(std::min<std::size_t>(o.want, skew + nbytes > pos ? skew + nbytes - pos : 0));
        const std::uint64_t at = aligned + pos;
        o.ov = OVERLAPPED{};
        o.ov.Offset = static_cast<DWORD>(at & 0xFFFFFFFFull);
        o.ov.OffsetHigh = static_cast<DWORD>(at >> 32);
        o.ov.hEvent = o.ev;
        ResetEvent(o.ev);
        o.issued = true;
        ++next;
        if (!ReadFile(file, static_cast<char*>(dst) + pos, o.want, nullptr, &o.ov) && GetLastError() != ERROR_IO_PENDING) {
            o.issued = false;
            ok = false;
        }
    };
    auto finish = [&](Op& o) {
        if (!o.issued) {
            return;
        }
        DWORD got = 0;
        if (!GetOverlappedResult(file, &o.ov, &got, TRUE) || got < o.need) {
            ok = false;
        }
        o.issued = false;
    };
    // ring of operations: the oldest is waited for before its slot issues the next chunk
    std::size_t head = 0;
    for (; next < ops.size() && ok; ) {
        issue(ops[next]);
    }
    std::size_t waited = 0;
    while (waited < n_chunks) {
        Op& o = ops[head];
        finish(o);
        ++waited;
        head = (head + 1) % ops.size();
        if (ok && next < n_chunks) {
            issue(o);
        }
        if (!ok) {
            for (Op& r : ops) {
                finish(r);
            }
            break;
        }
    }
    for (Op& o : ops) {
        CloseHandle(o.ev);
    }
    if (ok && skew_out != nullptr) {
        *skew_out = skew;
    }
    return ok;
}

void ExpertStore::set_profile(const std::vector<std::pair<int, int>>& layer_experts, double pin_fraction) {
    Impl& d = *impl_;
    {
        std::lock_guard<std::mutex> lock(d.mu);
        const std::size_t cap = static_cast<std::size_t>(static_cast<double>(d.slots.size()) * std::clamp(pin_fraction, 0.0, 1.0));
        d.pin_order.clear();
        d.pin_keys.clear();
        for (const auto& [layer, expert] : layer_experts) {
            if (layer < 0 || static_cast<std::size_t>(layer) >= d.tensors_of_layer.size()) {
                continue;
            }
            for (std::uint32_t tid : d.tensors_of_layer[static_cast<std::size_t>(layer)]) {
                if (expert < 0 || expert >= d.tensors[tid].n_expert || d.pin_order.size() >= cap) {
                    continue;
                }
                const std::uint64_t key = Impl::make_key(tid, expert);
                d.pin_order.push_back(key);
                d.pin_keys.insert(key);
            }
        }
        d.pin_resident = 0;
        for (Slot& s : d.slots) {
            s.pinned = s.state != SlotState::Empty && d.pin_keys.count(s.key) != 0;
            if (s.pinned && s.state == SlotState::Ready) {
                ++d.pin_resident;
            }
        }
        d.pin_cursor = 0;
    }
    d.cv_work.notify_all();
}

ExpertStore::ProfileProgress ExpertStore::profile_progress() const {
    std::lock_guard<std::mutex> lock(impl_->mu);
    return {impl_->pin_resident, impl_->pin_order.size(), impl_->preload_in_flight || impl_->pin_cursor < impl_->pin_order.size()};
}

void ExpertStore::prefetch(int layer, const std::int32_t* experts, std::size_t count) {
    Impl& d = *impl_;
    {
        std::lock_guard<std::mutex> lock(d.mu);
        if (d.arena == nullptr || layer < 0 || static_cast<std::size_t>(layer) >= d.tensors_of_layer.size()) {
            return;
        }
        d.prefetch_queue.clear();
        for (std::size_t i = 0; i < count; ++i) {
            for (const std::uint32_t tid : d.tensors_of_layer[static_cast<std::size_t>(layer)]) {
                if (experts[i] >= 0 && experts[i] < d.tensors[tid].n_expert) {
                    d.prefetch_queue.push_back(Impl::make_key(tid, experts[i]));
                }
            }
        }
    }
    d.cv_work.notify_all();
}

void ExpertStore::set_group_layer_reads(bool on) {
    std::lock_guard<std::mutex> lock(impl_->mu);
    impl_->group_layer_reads = on;
}

bool ExpertStore::resize(std::size_t ram_budget_bytes) {
    Impl& d = *impl_;
    std::unique_lock<std::mutex> lock(d.mu);
    if (d.arena == nullptr) {
        d.error = "store is not open";
        return false;
    }
    // nothing may be reading into the slots that go away
    d.prefetch_queue.clear();
    d.cv_ready.wait(lock, [&] { return !d.preload_in_flight && !d.prefetch_in_flight; });

    const std::size_t new_n = std::clamp(ram_budget_bytes / d.slot_bytes, kMinSlots, d.max_slots);
    const std::size_t old_n = d.slots.size();
    if (new_n < old_n) {
        for (std::size_t i = new_n; i < old_n; ++i) {
            if (d.slots[i].state != SlotState::Empty) {
                d.unlink(static_cast<std::uint32_t>(i));
            }
        }
        d.free_slots.erase(std::remove_if(d.free_slots.begin(), d.free_slots.end(), [&](std::uint32_t s) { return s >= new_n; }),
                           d.free_slots.end());
        VirtualFree(d.slot_data(static_cast<std::uint32_t>(new_n)), (old_n - new_n) * d.slot_bytes, MEM_DECOMMIT);
        d.slots.resize(new_n);
    } else if (new_n > old_n) {
        if (VirtualAlloc(d.slot_data(static_cast<std::uint32_t>(old_n)), (new_n - old_n) * d.slot_bytes, MEM_COMMIT, PAGE_READWRITE) == nullptr) {
            d.error = "cannot commit " + std::to_string((new_n - old_n) * d.slot_bytes / (1024 * 1024)) + " MiB more";
            return false;
        }
        d.slots.resize(new_n);
        for (std::size_t i = new_n; i > old_n; --i) {
            d.free_slots.push_back(static_cast<std::uint32_t>(i - 1));
        }
    }
    d.pin_cursor = 0;  // let the preloader refill what the new size allows
    ++d.stats.resizes;
    lock.unlock();
    d.cv_work.notify_all();
    return true;
}

std::size_t ExpertStore::capacity_bytes() const {
    std::lock_guard<std::mutex> lock(impl_->mu);
    return impl_->slots.size() * impl_->slot_bytes;
}

bool ExpertStore::is_open() const {
    std::lock_guard<std::mutex> lock(impl_->mu);
    return impl_->arena != nullptr;
}

void ExpertStore::forget_tensor_pointers() {
    std::lock_guard<std::mutex> lock(impl_->mu);
    impl_->tensor_by_ptr.clear();
}

std::size_t ExpertStore::max_capacity_bytes() const {
    std::lock_guard<std::mutex> lock(impl_->mu);
    return impl_->max_slots * impl_->slot_bytes;
}

std::size_t ExpertStore::min_capacity_bytes() const {
    return kMinSlots * impl_->slot_bytes;
}

#else

struct ExpertStore::Impl {
    mutable std::mutex mu;
    Stats stats;
    std::string error = "ExpertStore is only implemented on Windows for now";
};

ExpertStore::ExpertStore() : impl_(std::make_unique<Impl>()) {}
ExpertStore::~ExpertStore() = default;
bool ExpertStore::open(const std::filesystem::path&, std::size_t, std::size_t) { return false; }
void ExpertStore::prefetch(int, const std::int32_t*, std::size_t) {}
void ExpertStore::set_group_layer_reads(bool) {}
bool ExpertStore::resize(std::size_t) { return false; }
bool ExpertStore::is_open() const { return false; }
void ExpertStore::forget_tensor_pointers() {}
std::size_t ExpertStore::capacity_bytes() const { return 0; }
std::size_t ExpertStore::max_capacity_bytes() const { return 0; }
std::size_t ExpertStore::min_capacity_bytes() const { return 0; }
void ExpertStore::close() {}
bool ExpertStore::fetch(Request*, std::size_t) { return false; }
bool ExpertStore::bulk_read(const char*, std::size_t, std::size_t, void*, std::size_t, std::size_t*) { return false; }
void ExpertStore::set_profile(const std::vector<std::pair<int, int>>&, double) {}
ExpertStore::ProfileProgress ExpertStore::profile_progress() const { return {}; }

#endif

ExpertStore::Stats ExpertStore::stats() const {
    std::lock_guard<std::mutex> lock(impl_->mu);
    return impl_->stats;
}

std::size_t ExpertStore::slot_count() const {
#ifdef _WIN32
    std::lock_guard<std::mutex> lock(impl_->mu);
    return impl_->slots.size();
#else
    return 0;
#endif
}

std::size_t ExpertStore::slot_bytes() const {
#ifdef _WIN32
    return impl_->slot_bytes;
#else
    return 0;
#endif
}

std::string ExpertStore::last_error() const {
    std::lock_guard<std::mutex> lock(impl_->mu);
    return impl_->error;
}

}  // namespace ws
