# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Cursor, etc.) when working with code in this repository.

> **Read `Docs/HANDOFF_2026-11.md` first (its last section is the latest resume point; multi-model design in `Docs/MULTI_MODEL.md`).** Since November 2026 the project streams **MoE experts**
> (SSD -> RAM -> VRAM) through hooks in the vendored llama.cpp (`ExpertStore`, `ExpertSheets`,
> `DomainRouter`, tools `ws_moe_*`, `ws_expert_profile`, built by `scripts/build-llama.ps1` then
> `scripts/build-ws-tools.ps1`). The page-based design described below is the 2026-07 version and is
> partly obsolete; the main `CMakeLists.txt` does not build as-is (see the handoff note). Models live on
> the NVMe `C:\llm-models\`, never on `D:` (a hard disk).

> **L'application PAIZ-WeightStream (interface, file de tâches, mémoire, relais /v1) est dans `paiz/`** (Node, `cd paiz && npm test`) ; son `README.md` décrit l'état. Elle retrouve le moteur construit à la racine (`build-llama/bin`).

> Local service for characters / OpenAI-compatible chat (`ws_npc_server`, sleeping threads, suspend/resume): `Docs/NPC_SERVER.md`.

## Setup from a fresh clone (MoE streaming path)

```powershell
git clone --recursive https://github.com/Nosferatumiamor/PAIZ.git && cd PAIZ/engine   # or: git submodule update --init
.\scripts\apply-llama-patch.ps1   # WeightStream hooks into third_party/llama.cpp (submodule pinned at upstream 6c01da62)
.\scripts\build-llama.ps1         # llama.cpp CUDA build -> build-llama\ (~20-30 min the first time)
.\scripts\build-ws-tools.ps1      # ws_moe_probe, ws_mem_hog, ws_run_capped... -> build-llama\bin
```

The hooks live as a patch (`Docs/patches/llama-weightstream-hooks-6c01da62.patch`) because llama.cpp is a submodule:
after changing the vendored llama.cpp, regenerate it with
`git -C third_party/llama.cpp diff > Docs/patches/llama-weightstream-hooks-6c01da62.patch`.

## Project goal (set by the owner, 2026-11-07) - read this before measuring anything

WeightStream does **not** race llama.cpp on speed. llama.cpp is the engine; WeightStream makes it run the same models
with **fewer resources**, or on machines where it would not even try. Three targets:

1. **Small "decent" models (chat, game NPCs) on almost nothing**: minimal VRAM, RAM and CPU.
2. **Mid-size models (e.g. Gemma 10-15 GB)** with clearly less VRAM and RAM than normally needed, with slower
   generation accepted, for an **identical result**.
3. **Models larger than the machine**: they must run and end with a coherent answer, even if slowly.

So the headline metric is **resources divided by N for the same output** (peak VRAM, peak RAM of the process, CPU),
with speed reported as the price paid, never as the goal. A "x2 faster than llama.cpp" result is not the point; "same
text with half the RAM and a third of the VRAM, at Y tok/s" is. **Lossless is the default and the headline claim**
(identical text: never fewer experts, skipped layers or anything that changes the output, unless asked). Lossy modes
(e.g. quantizing weights in transit for speed) are allowed only as explicit, separately labeled options that say what is
lost, on which settings, and why it is accepted (speed); never mix their numbers into lossless claims.

## What this project is

WeightStream is a C++17 **weight-streaming engine** for AI models — it is not an inference engine. Its job is to move tensor data transparently between **SSD → RAM → VRAM**, the way a video-game asset streamer works, so that GGUF models larger than available VRAM (and possibly RAM) can run. The eventual consumer is an inference engine (currently llama.cpp, vendored under `third_party/llama.cpp` and built as PoC integration `ws_infer`/`ws_chat_ui`); WeightStream only ever exposes `GetTensor()`/`GetPage()`-style access by virtual address.

This repo is an MVP toward the fuller vision in `Docs/WeightStream RFC-0001..0004` (architecture, scheduler/cache, VTAS, VTMM) and `Docs/ROADMAP.md`. Not everything in the RFCs is implemented — check ROADMAP.md before assuming a feature (e.g. dynamic GPU/CPU offload, HOT/WARM/COLD thermal cache, multi-model support) exists.

## Build

Primary target platform is Windows + MSVC/Visual Studio. There are three separate build trees for different purposes — don't mix flags between them or CMake will re-configure unexpectedly.

```powershell
# Standard CPU-only build (Visual Studio 2019 generator, no CUDA/llama)
.\scripts\build.ps1              # -> build\Release\*.exe  (add -Debug for Debug config)

# GPU build with CUDA + llama.cpp integration (Ninja + nvcc, bypasses VS CUDA toolset issues)
.\scripts\build-gpu.ps1 [target] # -> build-gpu\*.exe       (default target: ws_infer)

# Diagnostic build: SAFE_MEMCPY bounds checks, no CUDA/llama, optional ASan
.\scripts\build-asan.ps1 [-UseAsan] [target]  # -> build-asan\*.exe (default target: ws_read_equiv)
```

`scripts/build-gpu.ps1` and `scripts/build-asan.ps1` hardcode toolchain paths (VS 2019 BuildTools `vcvars64.bat`, VS 2022 CMake, VS 2019 Ninja, CUDA 12.3 nvcc) — update those paths at the top of the script if your machine differs, rather than passing overrides.

Raw CMake options (see `CMakeLists.txt`): `WEIGHTSTREAM_CUDA` (default ON), `WEIGHTSTREAM_LLAMA` (default ON, pulls in `third_party/llama.cpp` and builds `ws_infer`/`ws_chat_ui`/`llama_simple_baseline`), `WEIGHTSTREAM_BUILD_TOOLS` (default ON), `WEIGHTSTREAM_ASAN`, `WEIGHTSTREAM_SAFE_MEMCPY`.

## Tests

```powershell
ctest --test-dir build -C Release
```

There is currently one test binary (`weightstream_tests`, from `tests/test_gguf_reader.cpp`, registered as ctest `gguf_reader`) covering the GGUF reader. It writes a minimal synthetic GGUF file inline rather than depending on a real model file. To exercise larger flows without downloading a model, use the `ws_generate_synthetic` tool to fabricate a fake GGUF (see below).

For end-to-end validation against a real large model on the reference hardware target (RTX 3060 12 GiB / 32 GiB RAM), use:

```powershell
.\scripts\run-realistic.ps1   # ~3 min: builds ws_read_equiv, runs 2000-sample streaming check, no eviction expected
```

## Key tools (all built from `tools/*.cpp`, linked against the `weightstream` library)

- `ws_inspect_gguf <model.gguf> [--tensors] [--json]` — shows the model's *logical* transformer layer composition (not raw storage pages). This is the basis for the future ablation/bypass protocol (`Docs/ABLATION_PROTOCOL.md`) — any bypass mask must target a whole logical layer, never an arbitrary fixed-size page.
- `ws_generate_synthetic <out.gguf> <n_tensors> <kib_per_tensor>` — fabricates a fake GGUF for pipeline testing without downloading real weights.
- `ws_benchmark <model.gguf> [--csv results.csv | --quick]` — runs the config matrix (7 configs takes hours on a large model; `--quick` runs one 32 MiB-page config).
- `ws_profile record|infer|replay` — PGO-style `.wsprofile` workflow: record a linear pass, build layer-by-layer forward order, then replay with profile-guided prefetch/eviction.
- `ws_specs` — detects CPU/RAM/GPU and estimates the largest model size the machine can stream comfortably.
- `ws_chat_ui` (via `.\scripts\run-chat-ui.ps1` or `WeightStream Chat.bat`) — local web UI (`http://127.0.0.1:8765`) with chat, console, RAM gauge, and a memory-guard quota slider (Auto/Manual/Off).
- `ws_infer` — llama.cpp integration PoC; `llama_simple_baseline` is the equivalent native llama.cpp loader (no WeightStream bridge) for comparison.
- `ws_read_equiv` — validates that the RAM-cache read path is equivalent to direct SSD reads at a given RAM budget, without doing real inference (used by `run-realistic.ps1`).

Model files (`.gguf`) go in `models/` and are gitignored (too large for git); see `models/README.md` for recommended test models.

## Architecture

Data flow:

```
GGUF Reader → Tensor Index → VTAS (virtual tensor addresses)
                                    ↓
                              VTMM + Scheduler
                                    ↓
                    SSD Reader → RAM Cache (TierCache) → VRAM Cache (TierCache)
```

- **`GGUFReader`** (`src/GGUFReader.cpp`) parses the GGUF file structure into a **`TensorIndex`** (`src/TensorIndex.cpp`) without loading tensor data.
- **`VTAS`** (Virtual Tensor Address Space, `src/VTAS.cpp`) assigns stable virtual addresses to pages/tensors and maps them across chunks — this is the addressing layer the rest of the system keys off of.
- **`VTMM`** (`include/WeightStream/VTMM.h`, `src/VTMM.cpp`) is the public façade (implements `ByteStore`). It owns the `TensorIndex`, `VTAS`, `SSDReader`, two `TierCache` instances (RAM and VRAM), and the `Scheduler`. Callers use `get_page()`/`get_page_by_index()` (paged mode, default 32 MiB pages) or `get_tensor()`/`get_tensor_by_name()` (legacy mode, `--page-mib 0`). `read_at(file_offset, dst, size)` is the raw-byte hook consumed by llama.cpp's I/O layer.
- **`TierCache`** (`include/WeightStream/TierCache.h`) is a fixed-capacity LRU cache with pluggable pin predicates, eviction priority (Belady-style "furthest next use"), demotion handlers (e.g. VRAM→RAM on eviction), and host-memory-guard-aware throttling. One instance is `MemoryKind::Host` (RAM), one is `MemoryKind::Device` (VRAM/CUDA).
- **`Scheduler`** (`include/WeightStream/Scheduler.h`, `src/Scheduler.cpp`) is the MVP FIFO scheduler with a configurable prefetch window. It runs a background worker thread processing `LoadRam`/`UploadGpu` jobs, and enforces invariants like "at most one SSD read per resident page" (`debug_ssd_invariant`) when enabled. Profile-guided mode (`ProfileMode::Replay`) uses a recorded `.wsprofile` to gate loads/evictions instead of naive FIFO.
- **`Config`** (`include/WeightStream/Config.h`) is the single struct controlling all of the above: cache sizes, page size, prefetch window, coalescing, profile mode, `ExecutionPolicy` (currently only `GpuOnly`/`HybridStatic` are wired; `HybridDynamic` is a Phase 3 stub), and the `SystemMemoryGuard*` fields (Auto/Manual/Off throttling to avoid saturating system RAM — see `SystemMemoryGuard.cpp`).
- **`single_copy_hierarchy`** (default true): RAM and VRAM residency are move semantics, not duplicated copies — RAM is the backing store, VRAM is a cache overlay on top of it. This invariant is checked by `CacheInvariants.cpp` when `debug_cache_invariants`/`debug_paranoid` are enabled.
- **`PageAutopsy`** / **`RuntimeProfiler`** / **`Metrics`** collect diagnostics (page lifecycle, timing, cache stats) that back the `ws_report`/`ws_degrade` tools and `.wsprofile` analysis.

The **data scheduler** (this repo: where are the weights — SSD/RAM/VRAM) is intentionally kept separate from the **compute scheduler** (where does calculation run — GPU/CPU), which llama.cpp currently owns via `-ngl`. See `Docs/ROADMAP.md` for the phased plan to eventually let WeightStream's profiling data drive compute placement too (Phase 3, not yet implemented — don't build toward it without checking current phase status first).

## Working conventions

- MSVC build uses `/W4 /permissive-`; non-MSVC uses `-Wall -Wextra -Wpedantic` (`CMakeLists.txt`). Keep changes warning-clean under these flags.
- `third_party/llama.cpp` is a vendored dependency (has its own `AGENTS.md`/`CLAUDE.md`) — treat it as read-only unless a change is specifically about the WeightStream↔llama.cpp bridge.
- Debug/paranoid invariant checks (`debug_ssd_invariant`, `debug_cache_invariants`, `debug_paranoid` in `Config`) exist because this system has had real eviction/corruption bugs (see the frozen "Bug éviction @ 8 GiB cache" item in `Docs/ROADMAP.md`); prefer enabling them over disabling when debugging cache/eviction logic.
- Reference hardware target for realistic testing is RTX 3060 (12 GiB VRAM) + 32 GiB system RAM + NVMe SSD, targeting 30–50 GiB GGUF models — keep this in mind when picking default capacities or test configs.
