#include "WeightStream/VTMM.h"
#include "WeightStream/SSDReader.h"
#include <iostream>
#include <vector>
int main() {
    ws::VTMM vtmm(ws::Config{});
    vtmm.load_model("models/Qwen2.5-32B-Instruct-Q4_K_L.gguf");
    ws::SSDReader d(ws::GGUFReader("models/Qwen2.5-32B-Instruct-Q4_K_L.gguf"));
    uint64_t off = 2889986487ULL, len = 3437927ULL;
    std::vector<std::byte> a,b(len);
  d.read_bytes(off,len,a);
    if (!vtmm.read_at(off,b.data(),len)) { std::cerr<<"fail\n"; return 1; }
    std::cerr << (a==b?"OK":"MISMATCH") << '\n';
}
