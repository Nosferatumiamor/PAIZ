#pragma once

#include "WeightStream/VTMM.h"

#include <atomic>
#include <chrono>
#include <functional>
#include <thread>

namespace ws {

class RuntimeProfiler {
public:
    using SnapshotFn = std::function<void()>;

    void start(SnapshotFn snapshot, std::chrono::milliseconds interval = std::chrono::seconds(1));
    void stop();

private:
    std::atomic<bool> running_{false};
    std::thread thread_;
};

}  // namespace ws
