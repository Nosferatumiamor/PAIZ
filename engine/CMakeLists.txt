cmake_minimum_required(VERSION 3.16)
project(WeightStream VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(WEIGHTSTREAM_BUILD_TOOLS "Build helper tools" ON)
option(WEIGHTSTREAM_CUDA "Enable CUDA device VRAM tier" ON)
option(WEIGHTSTREAM_ASAN "Enable MSVC/clang AddressSanitizer (requires ASan runtime)" OFF)
option(WEIGHTSTREAM_SAFE_MEMCPY "Abort on memcpy bounds violation (diagnostic)" OFF)

if(WEIGHTSTREAM_SAFE_MEMCPY)
    message(STATUS "WeightStream: SAFE_MEMCPY bounds checks enabled")
    add_compile_definitions(WEIGHTSTREAM_SAFE_MEMCPY=1)
endif()

if(WEIGHTSTREAM_ASAN)
    message(STATUS "WeightStream: AddressSanitizer compile flags enabled")
    if(MSVC)
        add_compile_options(/fsanitize=address)
        add_link_options(/INCREMENTAL:NO /fsanitize=address)
    else()
        add_compile_options(-fsanitize=address -fno-omit-frame-pointer -g)
        add_link_options(-fsanitize=address)
    endif()
endif()

add_library(weightstream
    src/GGUFReader.cpp
    src/TensorIndex.cpp
    src/VTAS.cpp
    src/TierCache.cpp
    src/CacheInvariants.cpp
    src/CudaTransfer.cpp
    src/SSDReader.cpp
    src/Scheduler.cpp
    src/VTMM.cpp
    src/Metrics.cpp
    src/Benchmark.cpp
    src/Profile.cpp
    src/PageAutopsy.cpp
    src/SystemMemoryGuard.cpp
    src/HardwareProfile.cpp
    src/RuntimeProfiler.cpp
    src/GpuTouch.cpp
)

target_include_directories(weightstream
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
)

if(WEIGHTSTREAM_CUDA)
    find_package(CUDAToolkit)
    if(CUDAToolkit_FOUND)
        target_compile_definitions(weightstream PUBLIC WEIGHTSTREAM_HAS_CUDA)
        target_link_libraries(weightstream PUBLIC CUDA::cudart)
        message(STATUS "WeightStream: CUDA VRAM tier enabled (cudart ${CUDAToolkit_VERSION})")
    else()
        message(WARNING "WEIGHTSTREAM_CUDA=ON but CUDAToolkit not found; building host-only VRAM")
    endif()
endif()

if(MSVC)
    target_compile_options(weightstream PRIVATE /W4 /permissive-)
else()
    target_compile_options(weightstream PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(weightstream_demo src/main.cpp)
target_link_libraries(weightstream_demo PRIVATE weightstream)

if(WEIGHTSTREAM_BUILD_TOOLS)
    add_executable(ws_generate_synthetic tools/generate_synthetic.cpp)
    target_link_libraries(ws_generate_synthetic PRIVATE weightstream)

    add_executable(ws_inspect_gguf tools/inspect_gguf.cpp)
    target_link_libraries(ws_inspect_gguf PRIVATE weightstream)

    add_executable(ws_benchmark tools/benchmark.cpp)
    target_link_libraries(ws_benchmark PRIVATE weightstream)

    add_executable(ws_profile tools/profile.cpp)
    target_link_libraries(ws_profile PRIVATE weightstream)

    add_executable(ws_report tools/report.cpp)
    target_link_libraries(ws_report PRIVATE weightstream)

    add_executable(ws_degrade tools/degrade.cpp)
    target_link_libraries(ws_degrade PRIVATE weightstream)

    add_executable(ws_layer_smoke tools/layer_forward_smoke.cpp)
    target_link_libraries(ws_layer_smoke PRIVATE weightstream)
    if(TARGET CUDA::cudart)
        target_link_libraries(ws_layer_smoke PRIVATE CUDA::cudart)
    endif()

    add_executable(ws_read_equiv tools/read_equiv.cpp)
    target_link_libraries(ws_read_equiv PRIVATE weightstream)

    add_executable(ws_specs tools/specs.cpp)
    target_link_libraries(ws_specs PRIVATE weightstream)

    if(TARGET CUDA::cudart)
        add_executable(ws_gpu_smoke tools/gpu_smoke.cpp)
        target_link_libraries(ws_gpu_smoke PRIVATE weightstream CUDA::cudart)
    endif()
endif()

option(WEIGHTSTREAM_LLAMA "Build llama.cpp inference PoC (ws_infer)" ON)
if(WEIGHTSTREAM_LLAMA)
    set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    if(CUDAToolkit_FOUND)
        option(GGML_CUDA "Enable ggml CUDA backend for llama.cpp" ON)
    endif()
    add_subdirectory(third_party/llama.cpp EXCLUDE_FROM_ALL)

    add_executable(ws_infer tools/infer.cpp)
    target_link_libraries(ws_infer PRIVATE weightstream llama)
    target_include_directories(ws_infer PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/include
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/ggml/include
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/src
    )

    add_executable(ws_ablate tools/ablate.cpp)
    target_link_libraries(ws_ablate PRIVATE weightstream llama)
    target_include_directories(ws_ablate PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/include
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/ggml/include
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/src
    )

    add_executable(ws_bi_score tools/bi_score.cpp)
    target_link_libraries(ws_bi_score PRIVATE weightstream llama)
    target_include_directories(ws_bi_score PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/include
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/ggml/include
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/src
    )

    add_executable(ws_fit_patch tools/fit_patch.cpp)
    target_link_libraries(ws_fit_patch PRIVATE weightstream llama)
    target_include_directories(ws_fit_patch PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/include
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/ggml/include
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/src
    )

    add_executable(ws_greedy_prune tools/greedy_prune.cpp)
    target_link_libraries(ws_greedy_prune PRIVATE weightstream llama)
    target_include_directories(ws_greedy_prune PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/include
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/ggml/include
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/src
    )

    add_executable(ws_chat_probe tools/chat_probe.cpp)
    target_link_libraries(ws_chat_probe PRIVATE weightstream llama)
    target_include_directories(ws_chat_probe PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/include
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/ggml/include
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/src
    )

    # Baseline: native llama loader (no WeightStream bridge)
    add_executable(llama_simple_baseline third_party/llama.cpp/examples/simple/simple.cpp)
    target_link_libraries(llama_simple_baseline PRIVATE llama)
    target_include_directories(llama_simple_baseline PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/include
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/ggml/include
    )

    add_executable(ws_chat_ui
        tools/chat_ui.cpp
        third_party/llama.cpp/vendor/cpp-httplib/httplib.cpp
    )
    target_link_libraries(ws_chat_ui PRIVATE weightstream llama)
    target_include_directories(ws_chat_ui PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/include
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/ggml/include
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/src
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/vendor/cpp-httplib
    )
endif()

enable_testing()
add_executable(weightstream_tests tests/test_gguf_reader.cpp)
target_link_libraries(weightstream_tests PRIVATE weightstream)
add_test(NAME gguf_reader COMMAND weightstream_tests)
