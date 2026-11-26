#pragma once

#include "WeightStream/TierCache.h"

#include <cstddef>
#include <cstdint>

namespace ws {

void copy_host_to_tier(TierCache& dst, std::byte* dst_ptr, const std::byte* src, std::size_t size);
void copy_tier_to_host(std::byte* dst, const TierCache& src, const std::byte* src_ptr, std::size_t size);

}  // namespace ws
