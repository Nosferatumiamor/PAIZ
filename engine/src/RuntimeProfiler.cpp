#include "WeightStream/RuntimeProfiler.h"

#include <iostream>

namespace ws {

void RuntimeProfiler::start(SnapshotFn snapshot, std::chrono::milliseconds interval) {
    stop();
    if (!snapshot) {
        return;
    }
    running_.store(true);
    thread_ = std::thread([this, snapshot = std::move(snapshot), interval] {
        while (running_.load()) {
            snapshot();
            std::this_thread::sleep_for(interval);
        }
    });
}

void RuntimeProfiler::stop() {
    running_.store(false);
    if (thread_.joinable()) {
        thread_.join();
    }
}

}  // namespace ws
