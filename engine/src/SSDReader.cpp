#include "WeightStream/SSDReader.h"

#include <iostream>

namespace ws {

SSDReader::SSDReader(GGUFReader reader) : gguf_(std::move(reader)) {
    file_.open(gguf_.path(), std::ios::binary);
}

bool SSDReader::read_tensor(std::size_t tensor_index, std::vector<std::byte>& out) {
    const auto& tensors = gguf_.tensors();
    if (tensor_index >= tensors.size()) {
        return false;
    }
    const auto& t = tensors[tensor_index];
    out.resize(static_cast<std::size_t>(t.size));
    return read_into(gguf_.data_offset() + t.offset, static_cast<std::size_t>(t.size), out.data());
}

bool SSDReader::read_bytes(std::uint64_t file_offset, std::size_t size, std::vector<std::byte>& out) {
    out.resize(size);
    return read_into(file_offset, size, out.data());
}

bool SSDReader::read_into(std::uint64_t file_offset, std::size_t size, void* dst) {
    if (dst == nullptr || size == 0) {
        return false;
    }

    try {
        std::lock_guard lock(read_mutex_);

        if (!file_.is_open()) {
            file_.open(gguf_.path(), std::ios::binary);
            if (!file_) {
                return false;
            }
        }

        file_.clear();
        file_.seekg(static_cast<std::streamoff>(file_offset));
        if (!file_) {
            return false;
        }

        file_.read(reinterpret_cast<char*>(dst), static_cast<std::streamsize>(size));
        return file_.gcount() == static_cast<std::streamsize>(size);
    } catch (const std::exception& ex) {
        std::cerr << "[SSDReader] read_into exception @ off=" << file_offset << " size=" << size
                  << ": " << ex.what() << '\n';
        return false;
    }
}

}  // namespace ws
