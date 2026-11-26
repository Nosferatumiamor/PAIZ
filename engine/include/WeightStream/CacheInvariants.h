#pragma once

#include "WeightStream/Types.h"
#include "WeightStream/VTAS.h"

#include <cstdint>
#include <string>

namespace ws {

class TierCache;

/// Abort with a message when `cond` is false (no-op when disabled).
void check_invariant(bool enabled, bool cond, const char* where, const std::string& message);

/// TierCache internal consistency (caller must not hold TierCache mutex unless using the _locked variant).
void validate_tier_cache(const TierCache& cache, bool enabled, const char* where);

/// TierCache extra checks for DEBUG_PARANOID (LRU bijection, unique offsets, storage pointers).
void validate_tier_cache_paranoid(const TierCache& cache, bool enabled, const char* where);

/// VTAS residency must match RAM/VRAM tier membership.
void validate_residency_sync(const VTAS& vtas,
                             const TierCache& ram_cache,
                             const TierCache& vram_cache,
                             bool enabled,
                             const char* where);

/// After RAM load or before SSD load: VTAS offsets must match tier membership.
void validate_page_ram_ready(const VTAS& vtas,
                             const TierCache& ram_cache,
                             std::uint64_t key,
                             bool enabled,
                             const char* where);

/// Full DEBUG_PARANOID sweep: tiers + VTAS + offset/size cross-checks.
void validate_paranoid_system(const VTAS& vtas,
                              const TierCache& ram_cache,
                              const TierCache& vram_cache,
                              bool enabled,
                              const char* where);

}  // namespace ws
