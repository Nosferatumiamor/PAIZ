#include "WeightStream/GGUFReader.h"

#include <cstdio>
#include <filesystem>
#include <map>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

namespace {

struct LayerInfo {
    std::uint64_t bytes = 0;
    std::vector<const ws::TensorInfo*> tensors;
};

std::string json_escape(const std::string& value) {
    std::ostringstream out;
    for (const unsigned char c : value) {
        switch (c) {
        case '\\': out << "\\\\"; break;
        case '"': out << "\\\""; break;
        case '\b': out << "\\b"; break;
        case '\f': out << "\\f"; break;
        case '\n': out << "\\n"; break;
        case '\r': out << "\\r"; break;
        case '\t': out << "\\t"; break;
        default:
            if (c < 0x20) {
                out << "\\u";
                static const char* hex = "0123456789abcdef";
                out << '0' << '0' << hex[(c >> 4) & 0x0f] << hex[c & 0x0f];
            } else {
                out << static_cast<char>(c);
            }
        }
    }
    return out.str();
}

// GGUF names are architecture-dependent.  llama.cpp's conventional names use
// blk.<number>.<component>; accepting the other common prefixes makes this
// inspector useful beyond a single model family.
bool layer_index(const std::string& name, int& index) {
    static const std::regex pattern(R"(^(?:blk|layer|model\.layers)\.(\d+)\.)");
    std::smatch match;
    if (!std::regex_search(name, match, pattern)) {
        return false;
    }
    try {
        index = std::stoi(match[1].str());
        return true;
    } catch (...) {
        return false;
    }
}

double mib(std::uint64_t bytes) {
    return static_cast<double>(bytes) / (1024.0 * 1024.0);
}

void print_dimensions(const ws::TensorInfo& tensor) {
    for (std::size_t i = 0; i < tensor.dimensions.size(); ++i) {
        std::fprintf(stderr, "%s%llu", i == 0 ? "" : "x",
                     static_cast<unsigned long long>(tensor.dimensions[i]));
    }
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "Usage: ws_inspect_gguf <model.gguf> [--tensors] [--json] [index]\n");
        return 1;
    }

    ws::GGUFReader reader(argv[1]);
    if (!reader.valid()) {
        std::fprintf(stderr, "Error: %s\n", reader.error().c_str());
        return 1;
    }

    const auto& tensors = reader.tensors();
    std::fprintf(stderr, "Tensors: %zu, data offset: %llu, total payload: %llu MiB\n",
                 tensors.size(),
                 static_cast<unsigned long long>(reader.data_offset()),
                 static_cast<unsigned long long>(
                     (std::filesystem::file_size(argv[1]) - reader.data_offset()) / (1024 * 1024)));

    std::uint64_t max_size = 0;
    std::size_t max_idx = 0;
    for (std::size_t i = 0; i < tensors.size(); ++i) {
        if (tensors[i].size > max_size) {
            max_size = tensors[i].size;
            max_idx = i;
        }
    }
    std::fprintf(stderr, "Largest tensor: #%zu %s = %llu MiB\n", max_idx, tensors[max_idx].name.c_str(),
                 static_cast<unsigned long long>(max_size / (1024 * 1024)));

    std::map<int, LayerInfo> layers;
    std::uint64_t shared_bytes = 0;
    for (const auto& t : tensors) {
        int layer = -1;
        if (layer_index(t.name, layer)) {
            auto& info = layers[layer];
            info.bytes += t.size;
            info.tensors.push_back(&t);
        } else {
            shared_bytes += t.size;
        }
    }
    if (!layers.empty()) {
        std::fprintf(stderr, "\nLogical transformer layers: %zu | shared / non-layer tensors: %.2f MiB\n",
                     layers.size(), mib(shared_bytes));
        for (const auto& [index, info] : layers) {
            std::fprintf(stderr, "  layer %d: %.2f MiB (%zu tensors)\n", index, mib(info.bytes), info.tensors.size());
            for (const auto* tensor : info.tensors) {
                std::fprintf(stderr, "    %-48s %9.2f MiB  ", tensor->name.c_str(), mib(tensor->size));
                print_dimensions(*tensor);
                std::fprintf(stderr, "\n");
            }
        }
    } else {
        std::fprintf(stderr, "\nNo logical layer names recognised. Use --tensors to inspect this GGUF naming scheme.\n");
    }

    for (const auto& [key, value] : reader.metadata_strings()) {
        if (key.find("block_count") != std::string::npos || key.find(".n_layer") != std::string::npos ||
            key == "general.architecture") {
            std::fprintf(stderr, "meta %s = %s\n", key.c_str(), value.c_str());
        }
    }

    bool list_tensors = false;
    bool json_output = false;
    std::string index_arg;
    for (int i = 2; i < argc; ++i) {
        if (std::string(argv[i]) == "--tensors") {
            list_tensors = true;
        } else if (std::string(argv[i]) == "--json") {
            json_output = true;
        } else {
            index_arg = argv[i];
        }
    }

    if (json_output) {
        std::fprintf(stdout, "{\n");
        std::fprintf(stdout, "  \"model\": \"%s\",\n", json_escape(argv[1]).c_str());
        std::fprintf(stdout, "  \"data_offset\": %llu,\n", static_cast<unsigned long long>(reader.data_offset()));
        std::fprintf(stdout, "  \"tensor_count\": %zu,\n", tensors.size());
        std::fprintf(stdout, "  \"total_payload_mib\": %llu,\n",
                     static_cast<unsigned long long>((std::filesystem::file_size(argv[1]) - reader.data_offset()) /
                                                    (1024 * 1024)));
        std::fprintf(stdout, "  \"largest_tensor\": {\n");
        std::fprintf(stdout, "    \"index\": %zu,\n", max_idx);
        std::fprintf(stdout, "    \"name\": \"%s\",\n", json_escape(tensors[max_idx].name).c_str());
        std::fprintf(stdout, "    \"bytes\": %llu\n", static_cast<unsigned long long>(max_size));
        std::fprintf(stdout, "  },\n");
        std::fprintf(stdout, "  \"metadata\": {\n");
        bool first_meta = true;
        for (const auto& [key, value] : reader.metadata_strings()) {
            if (key.find("block_count") == std::string::npos && key.find(".n_layer") == std::string::npos &&
                key != "general.architecture") {
                continue;
            }
            std::fprintf(stdout, "%s    \"%s\": \"%s\"",
                         first_meta ? "" : ",\n",
                         json_escape(key).c_str(),
                         json_escape(value).c_str());
            first_meta = false;
        }
        if (!first_meta) {
            std::fprintf(stdout, "\n");
        }
        std::fprintf(stdout, "  },\n");
        std::fprintf(stdout, "  \"layers\": [\n");
        bool first_layer = true;
        for (const auto& [index, info] : layers) {
            std::fprintf(stdout, "%s    {\n", first_layer ? "" : ",\n");
            std::fprintf(stdout, "      \"index\": %d,\n", index);
            std::fprintf(stdout, "      \"bytes\": %llu,\n", static_cast<unsigned long long>(info.bytes));
            std::fprintf(stdout, "      \"tensor_count\": %zu,\n", info.tensors.size());
            std::fprintf(stdout, "      \"tensors\": [\n");
            for (std::size_t i = 0; i < info.tensors.size(); ++i) {
                const auto* tensor = info.tensors[i];
                std::fprintf(stdout, "%s        {\n", i == 0 ? "" : ",\n");
                std::fprintf(stdout, "          \"name\": \"%s\",\n", json_escape(tensor->name).c_str());
                std::fprintf(stdout, "          \"bytes\": %llu,\n", static_cast<unsigned long long>(tensor->size));
                std::fprintf(stdout, "          \"offset\": %llu,\n", static_cast<unsigned long long>(tensor->offset));
                std::fprintf(stdout, "          \"type\": %u,\n", static_cast<unsigned>(tensor->type));
                std::fprintf(stdout, "          \"dimensions\": [");
                for (std::size_t d = 0; d < tensor->dimensions.size(); ++d) {
                    std::fprintf(stdout, "%s%llu", d == 0 ? "" : ", ",
                                 static_cast<unsigned long long>(tensor->dimensions[d]));
                }
                std::fprintf(stdout, "]\n");
                std::fprintf(stdout, "        }");
            }
            std::fprintf(stdout, "\n      ]\n    }");
            first_layer = false;
        }
        std::fprintf(stdout, "\n  ]\n}\n");
        return 0;
    }

    if (list_tensors) {
        std::fprintf(stderr, "\nAll tensors:\n");
        for (std::size_t i = 0; i < tensors.size(); ++i) {
            std::fprintf(stderr, "  #%zu %-56s %9.2f MiB  ", i, tensors[i].name.c_str(), mib(tensors[i].size));
            print_dimensions(tensors[i]);
            std::fprintf(stderr, "\n");
        }
    }

    if (!index_arg.empty()) {
        const std::size_t idx = static_cast<std::size_t>(std::stoull(index_arg));
        if (idx >= tensors.size()) {
            std::fprintf(stderr, "Index out of range\n");
            return 1;
        }
        const auto& t = tensors[idx];
        std::fprintf(stderr, "#%zu name=%s size=%llu offset=%llu type=%u\n", idx, t.name.c_str(),
                     static_cast<unsigned long long>(t.size),
                     static_cast<unsigned long long>(t.offset),
                     static_cast<unsigned>(t.type));
    }

    return 0;
}
