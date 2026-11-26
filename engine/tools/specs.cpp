#include "WeightStream/HardwareProfile.h"

#include <iostream>

int main() {
    const auto profile = ws::detect_hardware();
    std::cout << ws::format_hardware_report(profile);
    return 0;
}
