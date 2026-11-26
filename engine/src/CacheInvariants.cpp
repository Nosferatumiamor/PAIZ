#include "WeightStream/CacheInvariants.h"

#include "WeightStream/TierCache.h"

#include <iostream>
#include <unordered_map>
#include <unordered_set>

namespace ws {

namespace {

bool is_transient_state(TensorState state) {
    return state == TensorState::LoadingRam || state == TensorState::UploadingGpu ||
           state == TensorState::Evicting || state == TensorState::InUse;
}

bool is_non_resident_state(TensorState state) {
    return state == TensorState::SsdOnly || state == TensorState::Error || state == TensorState::NotPresent ||
           state == TensorState::LoadingRam;
}

}  // namespace

void check_invariant(bool enabled, bool cond, const char* where, const std::string& message) {
    if (!enabled || cond) {
        return;
    }

    std::cerr << "[WeightStream] INVARIANT VIOLATION at " << where << ": " << message << '\n';
    std::abort();
}

void validate_tier_cache(const TierCache& cache, bool enabled, const char* where) {
    cache.validate_invariants(enabled, where);
}

void validate_tier_cache_paranoid(const TierCache& cache, bool enabled, const char* where) {
    if (!enabled) {
        return;
    }

    cache.validate_paranoid_extras(enabled, where);
}

void validate_residency_sync(const VTAS& vtas,
                             const TierCache& ram_cache,
                             const TierCache& vram_cache,
                             bool enabled,
                             const char* where) {
    if (!enabled) {
        return;
    }

    const std::size_t chunks = vtas.chunk_count();
    for (std::size_t index = 0; index < chunks; ++index) {
        const auto address = vtas.address_at_index(index);
        if (!address) {
            continue;
        }

        const std::uint64_t key = address->value;
        const auto state = vtas.state(*address);
        const auto ram_off = vtas.ram_offset(*address);
        const auto vram_off = vtas.vram_offset(*address);
        const bool in_ram = ram_cache.contains(key);
        const bool in_vram = vram_cache.contains(key);

        check_invariant(enabled, !(in_ram && in_vram), where,
                        "page " + std::to_string(index) + " in both RAM and VRAM tiers");

        if (in_ram) {
            check_invariant(enabled,
                            state == TensorState::RamReady || state == TensorState::LoadingRam ||
                                state == TensorState::UploadingGpu,
                            where,
                            "page " + std::to_string(index) + " in RAM cache but VTAS state is " +
                                std::to_string(static_cast<int>(state)));
            check_invariant(enabled, ram_off.has_value(), where,
                            "page " + std::to_string(index) + " in RAM cache but ram_offset unset");
        } else if (!in_vram) {
            check_invariant(enabled, !ram_off.has_value(), where,
                            "page " + std::to_string(index) + " not resident but ram_offset still set");
        }

        if (in_vram) {
            check_invariant(enabled,
                            state == TensorState::GpuReady || state == TensorState::UploadingGpu,
                            where,
                            "page " + std::to_string(index) + " in VRAM cache but VTAS state is " +
                                std::to_string(static_cast<int>(state)));
            check_invariant(enabled, vram_off.has_value(), where,
                            "page " + std::to_string(index) + " in VRAM cache but vram_offset unset");
        } else if (!in_ram) {
            check_invariant(enabled, !vram_off.has_value(), where,
                            "page " + std::to_string(index) + " not resident but vram_offset still set");
        }

        if (!in_ram && !in_vram) {
            check_invariant(enabled, is_non_resident_state(state) || is_transient_state(state), where,
                            "page " + std::to_string(index) + " not resident but VTAS state is " +
                                std::to_string(static_cast<int>(state)));
        }
    }
}

void validate_page_ram_ready(const VTAS& vtas,
                             const TierCache& ram_cache,
                             std::uint64_t key,
                             bool enabled,
                             const char* where) {
    if (!enabled) {
        return;
    }

    const VirtualTensorAddress address{key};
    const auto state = vtas.state(address);
    const bool in_ram = ram_cache.contains(key);
    const auto ram_off = vtas.ram_offset(address);

    check_invariant(enabled, in_ram, where,
                    "page 0x" + std::to_string(key) + " expected in RAM cache (state=" +
                        std::to_string(static_cast<int>(state)) + ")");
    check_invariant(enabled, state == TensorState::RamReady, where,
                    "page 0x" + std::to_string(key) + " VTAS state must be RamReady");
    check_invariant(enabled, ram_off.has_value(), where,
                    "page 0x" + std::to_string(key) + " missing ram_offset while resident");
    check_invariant(enabled, ram_cache.offset_of(key).has_value(), where,
                    "page 0x" + std::to_string(key) + " missing cache offset while resident");
}

void validate_paranoid_system(const VTAS& vtas,
                              const TierCache& ram_cache,
                              const TierCache& vram_cache,
                              bool enabled,
                              const char* where) {
    if (!enabled) {
        return;
    }

    validate_tier_cache(ram_cache, true, where);
    validate_tier_cache(vram_cache, true, where);
    validate_tier_cache_paranoid(ram_cache, true, where);
    validate_tier_cache_paranoid(vram_cache, true, where);
    validate_residency_sync(vtas, ram_cache, vram_cache, true, where);

    const std::size_t chunks = vtas.chunk_count();
    for (std::size_t index = 0; index < chunks; ++index) {
        const auto address = vtas.address_at_index(index);
        if (!address) {
            continue;
        }

        const std::uint64_t key = address->value;
        const auto state = vtas.state(*address);
        const auto* chunk = vtas.chunk(*address);
        const bool in_ram = ram_cache.contains(key);
        const bool in_vram = vram_cache.contains(key);
        const auto ram_off = vtas.ram_offset(*address);
        const auto vram_off = vtas.vram_offset(*address);
        const auto cache_ram_off = ram_cache.offset_of(key);
        const auto cache_vram_off = vram_cache.offset_of(key);

        const int residency = (in_ram ? 1 : 0) + (in_vram ? 1 : 0);
        check_invariant(enabled, residency <= 1, where,
                        "page " + std::to_string(index) + " resident in " + std::to_string(residency) + " tiers");

        if (in_ram) {
            check_invariant(enabled, cache_ram_off.has_value(), where,
                            "page " + std::to_string(index) + " in RAM but cache has no offset");
            check_invariant(enabled, ram_off.has_value(), where,
                            "page " + std::to_string(index) + " in RAM but VTAS ram_offset unset");
            check_invariant(enabled, *cache_ram_off == *ram_off, where,
                            "page " + std::to_string(index) + " ram_offset mismatch: VTAS=" +
                                std::to_string(*ram_off) + " cache=" + std::to_string(*cache_ram_off));
            check_invariant(enabled, ram_cache.data_for_key(key) != nullptr, where,
                            "page " + std::to_string(index) + " in RAM but storage pointer is null");
            if (chunk != nullptr) {
                check_invariant(enabled, ram_cache.size_of(key) == static_cast<std::size_t>(chunk->size), where,
                                "page " + std::to_string(index) + " RAM byte_size mismatch with chunk descriptor");
            }
        }

        if (in_vram) {
            check_invariant(enabled, cache_vram_off.has_value(), where,
                            "page " + std::to_string(index) + " in VRAM but cache has no offset");
            check_invariant(enabled, vram_off.has_value(), where,
                            "page " + std::to_string(index) + " in VRAM but VTAS vram_offset unset");
            check_invariant(enabled, *cache_vram_off == *vram_off, where,
                            "page " + std::to_string(index) + " vram_offset mismatch: VTAS=" +
                                std::to_string(*vram_off) + " cache=" + std::to_string(*cache_vram_off));
            check_invariant(enabled, vram_cache.data_for_key(key) != nullptr, where,
                            "page " + std::to_string(index) + " in VRAM but storage pointer is null");
            if (chunk != nullptr) {
                check_invariant(enabled, vram_cache.size_of(key) == static_cast<std::size_t>(chunk->size), where,
                                "page " + std::to_string(index) + " VRAM byte_size mismatch with chunk descriptor");
            }
        }

        if (!in_ram && !in_vram) {
            check_invariant(enabled, !ram_off.has_value() && !vram_off.has_value(), where,
                            "page " + std::to_string(index) + " evicted but offset still set (state=" +
                                std::to_string(static_cast<int>(state)) + ")");
            check_invariant(enabled,
                            state == TensorState::SsdOnly || state == TensorState::LoadingRam ||
                                state == TensorState::Error || state == TensorState::NotPresent,
                            where,
                            "page " + std::to_string(index) + " not resident but state is " +
                                std::to_string(static_cast<int>(state)));
        }

        if (state == TensorState::RamReady) {
            check_invariant(enabled, in_ram, where,
                            "page " + std::to_string(index) + " RamReady but not in RAM cache");
        }
        if (state == TensorState::GpuReady) {
            check_invariant(enabled, in_vram, where,
                            "page " + std::to_string(index) + " GpuReady but not in VRAM cache");
        }
        if (state == TensorState::SsdOnly) {
            check_invariant(enabled, !in_ram && !in_vram, where,
                            "page " + std::to_string(index) + " SsdOnly but still in a tier cache");
        }
    }

    const auto ram_keys = ram_cache.resident_keys();
    const auto vram_keys = vram_cache.resident_keys();
    std::unordered_set<std::uint64_t> seen;
    for (const std::uint64_t key : ram_keys) {
        check_invariant(enabled, seen.insert(key).second, where,
                        "RAM key 0x" + std::to_string(key) + " duplicated across tier snapshots");
        const VirtualTensorAddress address{key};
        check_invariant(enabled, vtas.index_of(address).has_value(), where,
                        "RAM key 0x" + std::to_string(key) + " not registered in VTAS");
    }
    for (const std::uint64_t key : vram_keys) {
        check_invariant(enabled, seen.insert(key).second, where,
                        "VRAM key 0x" + std::to_string(key) + " duplicates RAM key or itself");
        const VirtualTensorAddress address{key};
        check_invariant(enabled, vtas.index_of(address).has_value(), where,
                        "VRAM key 0x" + std::to_string(key) + " not registered in VTAS");
    }

    check_invariant(enabled, ram_keys.size() == ram_cache.entry_count(), where,
                    "RAM resident_keys() size != entry_count()");
    check_invariant(enabled, vram_keys.size() == vram_cache.entry_count(), where,
                    "VRAM resident_keys() size != entry_count()");
}

}  // namespace ws
