#!/usr/bin/env python3
"""WeightStream PoC: layer-wise streaming via llm-layer-prefetch (safetensors).

Only a few transformer blocks stay on GPU; the rest streams from disk each forward pass.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import sys
import time
from dataclasses import dataclass
from typing import Any

import psutil
import torch
import torch.nn.functional as F
from huggingface_hub import snapshot_download
from layer_streamer import LayerStreamer
from tqdm import tqdm
from transformers import AutoTokenizer


def parse_header(path: str) -> tuple[dict[str, Any], int]:
    with open(path, "rb") as f:
        header_size = struct.unpack("<Q", f.read(8))[0]
        header = json.loads(f.read(header_size))
    return header, 8 + header_size


def _rotate_half(t: torch.Tensor) -> torch.Tensor:
    half = t.shape[-1] // 2
    return torch.cat([-t[..., half:], t[..., :half]], dim=-1)


def rms_norm(x: torch.Tensor, weight: torch.Tensor, eps: float) -> torch.Tensor:
    return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + eps) * weight


def apply_rope(
    q: torch.Tensor,
    k: torch.Tensor,
    cos: torch.Tensor,
    sin: torch.Tensor,
    past_length: int,
) -> tuple[torch.Tensor, torch.Tensor]:
    cos_slice = cos[:, :, past_length : past_length + q.shape[2]]
    sin_slice = sin[:, :, past_length : past_length + q.shape[2]]
    return (
        q * cos_slice + _rotate_half(q) * sin_slice,
        k * cos_slice + _rotate_half(k) * sin_slice,
    )


def make_rope(
    length: int,
    head_dim: int,
    theta: float,
    dtype: torch.dtype,
    device: str,
) -> tuple[torch.Tensor, torch.Tensor]:
    inv_freq = 1.0 / (theta ** (torch.arange(0, head_dim, 2).float() / head_dim))
    freqs = torch.outer(torch.arange(length).float(), inv_freq)
    emb = torch.cat([freqs, freqs], dim=-1)
    return (
        emb.cos().to(dtype).to(device)[None, None],
        emb.sin().to(dtype).to(device)[None, None],
    )


def forward_block(
    x: torch.Tensor,
    weights: dict[str, torch.Tensor],
    kv_cache: list[tuple[torch.Tensor, torch.Tensor] | None],
    layer_idx: int,
    num_heads: int,
    num_kv_heads: int,
    head_dim: int,
    eps: float,
    cos: torch.Tensor,
    sin: torch.Tensor,
) -> torch.Tensor:
    batch_size, seq_len, _ = x.shape
    past_kv = kv_cache[layer_idx]
    past_length = past_kv[0].shape[2] if past_kv is not None else 0
    residual = x
    x = rms_norm(x, weights["input_layernorm.weight"], eps)
    q = F.linear(x, weights["self_attn.q_proj.weight"], weights.get("self_attn.q_proj.bias")).view(
        batch_size, seq_len, num_heads, head_dim
    ).transpose(1, 2)
    k = F.linear(x, weights["self_attn.k_proj.weight"], weights.get("self_attn.k_proj.bias")).view(
        batch_size, seq_len, num_kv_heads, head_dim
    ).transpose(1, 2)
    v = F.linear(x, weights["self_attn.v_proj.weight"], weights.get("self_attn.v_proj.bias")).view(
        batch_size, seq_len, num_kv_heads, head_dim
    ).transpose(1, 2)
    q, k = apply_rope(q, k, cos, sin, past_length)

    if past_kv is not None:
        k = torch.cat([past_kv[0], k], dim=2)
        v = torch.cat([past_kv[1], v], dim=2)
    kv_cache[layer_idx] = (k, v)

    kv_repeat = num_heads // num_kv_heads
    x = F.scaled_dot_product_attention(
        q,
        k.repeat_interleave(kv_repeat, dim=1),
        v.repeat_interleave(kv_repeat, dim=1),
        is_causal=(past_length == 0 and seq_len > 1),
    )
    x = residual + F.linear(
        x.transpose(1, 2).reshape(batch_size, seq_len, -1),
        weights["self_attn.o_proj.weight"],
    )
    residual = x
    x = rms_norm(x, weights["post_attention_layernorm.weight"], eps)
    gate = F.linear(x, weights["mlp.gate_proj.weight"])
    up = F.linear(x, weights["mlp.up_proj.weight"])
    return residual + F.linear(F.silu(gate) * up, weights["mlp.down_proj.weight"])


def sample(logits: torch.Tensor, temperature: float, top_k: int) -> int:
    if temperature == 0.0:
        return int(logits.argmax().item())
    logits = logits / temperature
    if top_k > 0:
        top_values, _ = logits.topk(min(top_k, logits.size(-1)))
        logits[logits < top_values[..., [-1]]] = -float("inf")
    return int(torch.multinomial(F.softmax(logits, dim=-1), 1).item())


def cuda_mem_gib() -> float:
    if not torch.cuda.is_available():
        return 0.0
    return torch.cuda.memory_allocated() / (1024**3)


def model_shard_names(model_dir: str) -> list[str]:
    index_path = os.path.join(model_dir, "model.safetensors.index.json")
    if not os.path.isfile(index_path):
        return []
    with open(index_path, encoding="utf-8") as f:
        weight_map = json.load(f)["weight_map"]
    return sorted(set(weight_map.values()))


def model_is_complete(model_dir: str) -> bool:
    shards = model_shard_names(model_dir)
    if not shards:
        return False
    for shard in shards:
        path = os.path.join(model_dir, shard)
        if not os.path.isfile(path) or os.path.getsize(path) < 1024:
            return False
    return True


def ensure_model(model_dir: str, repo_id: str, download: bool) -> None:
    if model_is_complete(model_dir):
        return

    missing = [s for s in model_shard_names(model_dir) if not os.path.isfile(os.path.join(model_dir, s))]
    if missing and os.path.isdir(model_dir):
        print(f"Modele incomplet ({len(missing)} shard(s) manquant(s)) - reprise du telechargement...")
        for name in missing[:4]:
            print(f"  manquant: {name}")
        if len(missing) > 4:
            print(f"  ... et {len(missing) - 4} autre(s)")

    if not download:
        print(f"Modele incomplet ou absent: {model_dir}", file=sys.stderr)
        print("Relance avec --download ou via WeightStream Layer Prefetch.bat", file=sys.stderr)
        sys.exit(1)

    os.makedirs(model_dir, exist_ok=True)
    print(f"Telechargement {repo_id} -> {model_dir} (safetensors sharded, peut prendre longtemps)...")
    snapshot_download(
        repo_id=repo_id,
        local_dir=model_dir,
        ignore_patterns=["*.bin", "*.pt", "*.gguf", "original/"],
    )
    if not model_is_complete(model_dir):
        print("Telechargement termine mais shards toujours manquants.", file=sys.stderr)
        sys.exit(1)
    print("Modele complet.")


@dataclass
class StreamingParams:
    n_gpu: int
    n_cpu_pinned: int
    n_cpu: int
    batch_gpu: int
    batch_cpu_pinned: int
    batch_cpu: int
    per_layer_mib: float
    ram_cache_layers: int
    gpu_pipe_layers: int
    gpu_resident_layers: int
    note: str


def model_payload_bytes(model_dir: str) -> int:
    return sum(os.path.getsize(os.path.join(model_dir, shard)) for shard in model_shard_names(model_dir))


def estimate_per_layer_bytes(model_dir: str, num_layers: int, dtype: torch.dtype) -> int:
    with open(os.path.join(model_dir, "model.safetensors.index.json"), encoding="utf-8") as f:
        weight_map = json.load(f)["weight_map"]
    layer0 = "model.layers.0."
    elem = torch.empty(1, dtype=dtype).element_size()
    elems = 0
    for name in weight_map:
        if not name.startswith(layer0):
            continue
        shard = weight_map[name]
        header, data_off = parse_header(os.path.join(model_dir, shard))
        shape = header[name]["shape"]
        elems += math.prod(shape)
    if elems > 0:
        return elems * elem
    payload = model_payload_bytes(model_dir)
    static_guess = payload // max(num_layers + 2, 1)
    return max(static_guess, payload // max(num_layers, 1))


def hardware_snapshot() -> tuple[float, float, float]:
    mem = psutil.virtual_memory()
    ram_total = mem.total / (1024**3)
    ram_avail = mem.available / (1024**3)
    vram_total = 0.0
    if torch.cuda.is_available():
        props = torch.cuda.get_device_properties(0)
        vram_total = props.total_memory / (1024**3)
    return ram_total, ram_avail, vram_total


def compute_streaming_params(
    model_dir: str,
    dtype: torch.dtype,
    profile: str,
    ram_allowance: float = 0.78,
    vram_allowance: float = 0.72,
    os_reserve_gib: float = 4.0,
    vram_static_gib: float = 3.5,
) -> StreamingParams:
    with open(os.path.join(model_dir, "config.json"), encoding="utf-8") as f:
        num_layers = json.load(f)["num_hidden_layers"]

    if profile == "light":
        return StreamingParams(
            n_gpu=2,
            n_cpu_pinned=4,
            n_cpu=4,
            batch_gpu=1,
            batch_cpu_pinned=1,
            batch_cpu=2,
            per_layer_mib=0.0,
            ram_cache_layers=0,
            gpu_pipe_layers=3,
            gpu_resident_layers=0,
            note="profil light (streaming disque, prefetch minimal)",
        )

    if profile == "balanced":
        return StreamingParams(
            n_gpu=3,
            n_cpu_pinned=5,
            n_cpu=4,
            batch_gpu=1,
            batch_cpu_pinned=1,
            batch_cpu=2,
            per_layer_mib=0.0,
            ram_cache_layers=0,
            gpu_pipe_layers=4,
            gpu_resident_layers=0,
            note="profil balanced (streaming disque, compromis 3060)",
        )

    if profile == "hybrid":
        _ram_total, ram_avail, _vram_total = hardware_snapshot()
        per_layer = estimate_per_layer_bytes(model_dir, num_layers, dtype)
        per_layer_gib = per_layer / (1024**3)
        n_gpu = 4
        n_cpu_pinned = 6
        n_cpu = 5
        pipeline_ram_gib = (pool_slots(n_cpu_pinned) + pool_slots(n_cpu)) * per_layer_gib
        os_reserve = 4.0
        cache_budget = max(0.0, ram_avail - os_reserve - pipeline_ram_gib - 1.5)
        max_cache_layers = int(cache_budget / per_layer_gib) if per_layer_gib > 0 else 0
        max_cache_layers = max(4, min(num_layers - 2, max_cache_layers))
        cache_gib = max_cache_layers * per_layer_gib
        cold_disk_gib = max(0.0, (num_layers - max_cache_layers) * per_layer_gib)
        note = (
            f"profil hybrid: cache LRU {max_cache_layers} couches RAM (~{cache_gib:.1f} GiB), "
            f"pipeline disque actif (~{cold_disk_gib:.1f} GiB/token a froid, baisse ensuite)"
        )
        return StreamingParams(
            n_gpu=n_gpu,
            n_cpu_pinned=n_cpu_pinned,
            n_cpu=n_cpu,
            batch_gpu=1,
            batch_cpu_pinned=1,
            batch_cpu=3,
            per_layer_mib=per_layer / (1024**2),
            ram_cache_layers=max_cache_layers,
            gpu_pipe_layers=pool_slots(n_gpu),
            gpu_resident_layers=0,
            note=note,
        )

    if profile == "turbo":
        profile = "gpu_first"

    if profile == "gpu_first":
        ram_total, ram_avail, vram_total = hardware_snapshot()
        per_layer = estimate_per_layer_bytes(model_dir, num_layers, dtype)
        per_layer_gib = per_layer / (1024**3)
        model_gib = per_layer_gib * num_layers

        if ram_avail < model_gib + 2.5:
            print(
                f"gpu_first: modele ~{model_gib:.1f} GiB trop gros pour {ram_avail:.0f} Go RAM libre.\n"
                f"Utilise un 7B ou WeightStream Chat.bat (GGUF quantise).",
                file=sys.stderr,
            )
            sys.exit(1)

        note = (
            f"gpu_first: {num_layers} couches RAM (~{model_gib:.1f} GiB), "
            f"GPU pilote (VRAM max, disque ignore apres preload)"
        )
        return StreamingParams(
            n_gpu=8,
            n_cpu_pinned=0,
            n_cpu=0,
            batch_gpu=1,
            batch_cpu_pinned=1,
            batch_cpu=2,
            per_layer_mib=per_layer / (1024**2),
            ram_cache_layers=num_layers,
            gpu_pipe_layers=9,
            gpu_resident_layers=num_layers - 1,
            note=note,
        )

    if profile == "max":
        ram_allowance = 0.82
        vram_allowance = 0.78
        os_reserve_gib = 3.5
    else:
        # comfort: leger bump sans pools enormes
        return StreamingParams(
            n_gpu=4,
            n_cpu_pinned=6,
            n_cpu=5,
            batch_gpu=1,
            batch_cpu_pinned=1,
            batch_cpu=2,
            per_layer_mib=0.0,
            ram_cache_layers=0,
            gpu_pipe_layers=5,
            gpu_resident_layers=0,
            note="profil comfort (streaming disque, prefetch renforce)",
        )

    ram_total, _ram_avail, vram_total = hardware_snapshot()
    per_layer = estimate_per_layer_bytes(model_dir, num_layers, dtype)
    per_layer_gib = per_layer / (1024**3)

    ram_budget_gib = max(0.0, ram_total * ram_allowance - os_reserve_gib)
    vram_budget_gib = max(0.0, vram_total * vram_allowance - vram_static_gib)

    host_pool_gib = ram_budget_gib * 0.62
    max_host_slots = max(4, int(host_pool_gib / per_layer_gib) if per_layer_gib > 0 else 4)

    pinned_slots = min(8, max(3, int(max_host_slots * 0.45)))
    n_cpu_pinned = pinned_slots - 1
    remaining_slots = max(0, max_host_slots - pinned_slots)
    cpu_slots = min(6, max(2, remaining_slots))
    n_cpu = cpu_slots - 1 if cpu_slots >= 2 else 0

    max_gpu_slots = int(vram_budget_gib / per_layer_gib) if per_layer_gib > 0 else 3
    n_gpu = max(2, min(5, max_gpu_slots - 1))

    while pool_slots(n_cpu_pinned) * per_layer_gib > host_pool_gib * 0.65 and n_cpu_pinned > 2:
        n_cpu_pinned -= 1
    while pool_slots(n_gpu) * per_layer_gib + vram_static_gib > vram_total * 0.80 and n_gpu > 2:
        n_gpu -= 1

    est_pin_gib = pool_slots(n_cpu_pinned) * per_layer_gib
    est_cpu_gib = pool_slots(n_cpu) * per_layer_gib if n_cpu > 0 else 0.0
    est_vram_gib = vram_static_gib + pool_slots(n_gpu) * per_layer_gib

    note = (
        f"profil {profile}: prefetch {n_cpu_pinned+1} pin + {pool_slots(n_cpu) if n_cpu else 0} cpu "
        f"+ {n_gpu+1} gpu (~{est_pin_gib:.1f}+{est_cpu_gib:.1f} GiB host, ~{est_vram_gib:.1f} GiB VRAM)"
    )

    return StreamingParams(
        n_gpu=n_gpu,
        n_cpu_pinned=n_cpu_pinned,
        n_cpu=n_cpu,
        batch_gpu=1,
        batch_cpu_pinned=min(2, max(1, n_cpu_pinned // 4)),
        batch_cpu=min(4, max(2, max(1, n_cpu // 2))),
        per_layer_mib=per_layer / (1024**2),
        ram_cache_layers=0,
        gpu_pipe_layers=n_gpu + 1,
        gpu_resident_layers=0,
        note=note,
    )


def pool_slots(n: int) -> int:
    return n + 1


def apply_streaming_profile(args: argparse.Namespace, model_dir: str, dtype: torch.dtype) -> StreamingParams:
    preset = compute_streaming_params(model_dir, dtype, args.profile)
    if preset.per_layer_mib <= 0:
        with open(os.path.join(model_dir, "config.json"), encoding="utf-8") as f:
            num_layers = json.load(f)["num_hidden_layers"]
        preset.per_layer_mib = estimate_per_layer_bytes(model_dir, num_layers, dtype) / (1024**2)
    if args.n_gpu is not None:
        preset.n_gpu = args.n_gpu
    if args.n_cpu_pinned is not None:
        preset.n_cpu_pinned = args.n_cpu_pinned
    if args.n_cpu is not None:
        preset.n_cpu = args.n_cpu
    if args.batch_gpu is not None:
        preset.batch_gpu = args.batch_gpu
    if args.batch_cpu_pinned is not None:
        preset.batch_cpu_pinned = args.batch_cpu_pinned
    if args.batch_cpu is not None:
        preset.batch_cpu = args.batch_cpu

    args.n_gpu = preset.n_gpu
    args.n_cpu_pinned = preset.n_cpu_pinned
    args.n_cpu = preset.n_cpu
    args.batch_gpu = preset.batch_gpu
    args.batch_cpu_pinned = preset.batch_cpu_pinned
    args.batch_cpu = preset.batch_cpu
    return preset


def cuda_mem_free_gib() -> float:
    if not torch.cuda.is_available():
        return 0.0
    torch.cuda.synchronize()
    free, _total = torch.cuda.mem_get_info()
    return free / (1024**3)


def gpu_resident_fit(num_layers: int, per_layer_gib: float, target: int, margin_gib: float = 0.25) -> int:
    """Estimation rapide (greedy fill fait le vrai remplissage)."""
    budget = max(0.0, cuda_mem_free_gib() - margin_gib)
    fit = int(budget / per_layer_gib) if per_layer_gib > 0 else 0
    return max(0, min(target, fit, num_layers - 1))


def fill_gpu_residents_greedy(streamer: LayerStreamer, num_layers: int, reserve_gib: float = 0.25) -> int:
    """Charge le max de couches en VRAM, une par une, jusqu'a la limite."""
    if streamer._layer_ram_cache is None:
        return 0
    per_layer_gib = (
        sum(streamer.block_sizes.values()) * torch.empty(1, dtype=streamer.raw_dtype).element_size() / (1024**3)
    )
    loaded = streamer.n_gpu_resident
    while loaded < num_layers - 1:
        if cuda_mem_free_gib() < reserve_gib + per_layer_gib:
            break
        try:
            src = streamer._layer_ram_cache[loaded]
            dst = streamer._alloc(False, "cuda")
            for key in streamer.block_keys:
                dst[key].copy_(src[key])
            streamer._gpu_resident[loaded] = dst
            loaded += 1
            streamer.n_gpu_resident = loaded
            torch.cuda.synchronize()
        except RuntimeError as exc:
            if "out of memory" not in str(exc).lower():
                raise
            torch.cuda.empty_cache()
            break
    return loaded


def pipeline_n_gpu_from_free(per_layer_gib: float, min_n: int = 2, max_n: int = 8, reserve_gib: float = 0.20) -> int:
    """Slots pipeline GPU a partir de la VRAM restante."""
    if per_layer_gib <= 0:
        return min_n
    free = max(0.0, cuda_mem_free_gib() - reserve_gib)
    slots = int(free / per_layer_gib)
    slots = max(min_n + 1, min(max_n + 1, slots))
    return slots - 1


def build_streamer(
    model_dir: str,
    dtype: torch.dtype,
    args: argparse.Namespace,
    defer_gpu_pool: bool = False,
) -> tuple[LayerStreamer, dict[str, Any]]:
    config = json.load(open(os.path.join(model_dir, "config.json"), encoding="utf-8"))
    weight_map = json.load(open(os.path.join(model_dir, "model.safetensors.index.json"), encoding="utf-8"))[
        "weight_map"
    ]

    shards = sorted(set(weight_map.values()))
    shard_headers: dict[str, Any] = {}
    shard_offsets: dict[str, int] = {}
    for shard in shards:
        shard_headers[shard], shard_offsets[shard] = parse_header(os.path.join(model_dir, shard))

    tensor_info = {
        name: (shard, shard_headers[shard][name]["data_offsets"][0], tuple(shard_headers[shard][name]["shape"]))
        for name, shard in weight_map.items()
    }

    layer0_prefix = "model.layers.0."
    block_keys = sorted(k[len(layer0_prefix) :] for k in weight_map if k.startswith(layer0_prefix))
    block_sizes = {key: math.prod(tensor_info[layer0_prefix + key][2]) for key in block_keys}

    streamer = LayerStreamer(
        model_dir=model_dir,
        tensor_info=tensor_info,
        shard_offsets=shard_offsets,
        block_keys=block_keys,
        block_sizes=block_sizes,
        dtype=dtype,
        num_layers=config["num_hidden_layers"],
        n_gpu=args.n_gpu,
        n_cpu_pinned=args.n_cpu_pinned,
        n_cpu=args.n_cpu,
        batch_gpu=args.batch_gpu,
        batch_cpu_pinned=args.batch_cpu_pinned,
        batch_cpu=args.batch_cpu,
        track_progress=False,
        defer_gpu_pool=defer_gpu_pool,
    )
    return streamer, config


@dataclass
class InferenceSession:
    model_dir: str
    args: argparse.Namespace
    dtype: torch.dtype
    streamer: LayerStreamer
    config: dict[str, Any]
    embed_weight: torch.Tensor
    norm_weight: torch.Tensor
    lm_head: torch.Tensor
    tokenizer: Any
    preset: StreamingParams


def create_session(model_dir: str, args: argparse.Namespace) -> InferenceSession:
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    with open(os.path.join(model_dir, "config.json"), encoding="utf-8") as f:
        num_layers_cfg = json.load(f)["num_hidden_layers"]
    preset = apply_streaming_profile(args, model_dir, dtype)
    ram_total, ram_avail, vram_total = hardware_snapshot()
    print(
        f"Hardware: {ram_total:.0f} Go RAM ({ram_avail:.0f} libre) | "
        f"GPU {vram_total:.0f} Go VRAM | ~{preset.per_layer_mib:.0f} MiB/couche"
    )
    print(f"Policy: {preset.note}")
    use_full_ram = preset.ram_cache_layers >= num_layers_cfg
    use_hybrid = 0 < preset.ram_cache_layers < num_layers_cfg
    if use_full_ram:
        mode = "gpu_first (RAM preload + VRAM max)"
    elif use_hybrid:
        mode = "hybrid RAM+disque"
    else:
        mode = "streaming disque"
    print(f"Pipeline: n_gpu={args.n_gpu} | mode={mode}")
    print("Chargement streamer (une fois par session)...")

    streamer, config = build_streamer(model_dir, dtype, args, defer_gpu_pool=use_full_ram)
    if (not use_full_ram) and args.progress:
        streamer.track_progress = True

    if use_hybrid:
        cache_gib = preset.ram_cache_layers * preset.per_layer_mib / 1024
        streamer.enable_hybrid_ram_cache(preset.ram_cache_layers)
        print(
            f"Cache hybrid LRU: {preset.ram_cache_layers} couches max (~{cache_gib:.1f} GiB), "
            f"remplit au fil des tokens (pas de copie disque)"
        )

    if use_full_ram and preset.ram_cache_layers >= config["num_hidden_layers"]:
        model_gib = preset.ram_cache_layers * preset.per_layer_mib / 1024
        print(f"Prechargement {config['num_hidden_layers']} couches en RAM (~{model_gib:.1f} GiB, sans VRAM)...")
        streamer.preload_layers_to_ram(show_progress=args.progress)

    embed_weight = streamer.load_static("model.embed_tokens.weight")
    norm_weight = streamer.load_static("model.norm.weight")
    lm_head = streamer.load_static("lm_head.weight")

    num_layers = config["num_hidden_layers"]
    per_layer_gib = preset.per_layer_mib / 1024

    if use_full_ram:
        reserve = args.vram_reserve_gib
        print(f"Remplissage VRAM ({cuda_mem_free_gib():.1f} GiB libre apres poids statiques)...")
        n_resident = fill_gpu_residents_greedy(streamer, num_layers, reserve_gib=reserve)
        n_gpu = pipeline_n_gpu_from_free(per_layer_gib, min_n=2, max_n=args.n_gpu if args.n_gpu else 8, reserve_gib=reserve)
        streamer.n_gpu = n_gpu
        args.n_gpu = n_gpu
        print(
            f"  -> {n_resident} couches residentes VRAM | pipeline {pool_slots(n_gpu)} slots "
            f"| {num_layers - n_resident} couches PCIe/token"
        )
        print("Initialisation pipeline GPU...")
        streamer._init_gpu_pool()
    elif not streamer._gpu_pool_initialized:
        streamer._init_gpu_pool()
        if not use_hybrid:
            disk_gib = num_layers * per_layer_gib
            print(
                f"  -> {num_layers} couches sur disque (~{disk_gib:.1f} GiB/token) | "
                f"GPU inactif = normal (attente SSD)"
            )

    tokenizer = AutoTokenizer.from_pretrained(model_dir)
    vram_used = cuda_mem_gib()
    vram_free = cuda_mem_free_gib()
    if use_full_ram and streamer.n_gpu_resident > 0:
        print(
            f"Pret | VRAM: {vram_used:.2f} GiB utilisee, {vram_free:.2f} GiB libre | "
            f"{streamer.n_gpu_resident} couches GPU + {num_layers - streamer.n_gpu_resident} PCIe/token\n"
        )
    else:
        print(f"Pret | VRAM: {vram_used:.2f} GiB utilisee, {vram_free:.2f} GiB libre\n")

    return InferenceSession(
        model_dir=model_dir,
        args=args,
        dtype=dtype,
        streamer=streamer,
        config=config,
        embed_weight=embed_weight,
        norm_weight=norm_weight,
        lm_head=lm_head,
        tokenizer=tokenizer,
        preset=preset,
    )


def generate(session: InferenceSession, messages: list[dict[str, str]]) -> str:
    args = session.args
    config = session.config
    streamer = session.streamer

    num_layers = config["num_hidden_layers"]
    num_heads = config["num_attention_heads"]
    num_kv_heads = config["num_key_value_heads"]
    head_dim = config.get("head_dim", config["hidden_size"] // num_heads)
    eps = config["rms_norm_eps"]
    rope_theta = config.get("rope_theta", 10000.0)

    text = session.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    input_ids = session.tokenizer(text, return_tensors="pt")["input_ids"].cuda()

    cos, sin = make_rope(input_ids.shape[1] + args.max_tokens, head_dim, rope_theta, session.dtype, "cuda")
    kv_cache: list[tuple[torch.Tensor, torch.Tensor] | None] = [None] * num_layers

    def layer_fn(x: torch.Tensor, w: dict[str, torch.Tensor], i: int) -> torch.Tensor:
        return forward_block(
            x=x,
            weights=w,
            kv_cache=kv_cache,
            layer_idx=i,
            num_heads=num_heads,
            num_kv_heads=num_kv_heads,
            head_dim=head_dim,
            eps=eps,
            cos=cos,
            sin=sin,
        )

    input_embeds = session.embed_weight[input_ids[0]].unsqueeze(0)
    output_tokens: list[int] = []

    if session.preset.ram_cache_layers == 0 and session.preset.per_layer_mib > 0:
        disk_gib = num_layers * session.preset.per_layer_mib / 1024
        print(f"  [disque] ~{disk_gib:.1f} GiB a lire pour ce token (barre layers ci-dessous)...", flush=True)
    elif streamer._hybrid_cache_max > 0:
        cached, maxc, _, _ = streamer.hybrid_cache_stats()
        print(
            f"  [hybrid] cache RAM {cached}/{maxc} couches — hits attendus en fin de pass",
            flush=True,
        )

    t0 = time.perf_counter()
    if streamer._hybrid_cache_max > 0:
        streamer._hybrid_hits = 0
        streamer._hybrid_misses = 0
    with torch.no_grad():
        iterator = range(args.max_tokens)
        if args.progress:
            iterator = tqdm(iterator, desc="tokens", leave=False)

        for _ in iterator:
            hidden = streamer.run_pass(input_embeds, layer_fn)
            logits = F.linear(rms_norm(hidden[:, -1], session.norm_weight, eps), session.lm_head)
            next_token = sample(logits, args.temperature, args.top_k)
            if next_token == session.tokenizer.eos_token_id:
                break
            output_tokens.append(next_token)
            input_embeds = session.embed_weight[torch.tensor(next_token, device="cuda")].unsqueeze(0).unsqueeze(0)

    elapsed = time.perf_counter() - t0
    tok_s = len(output_tokens) / elapsed if elapsed > 0 else 0.0
    extra = ""
    if streamer._hybrid_cache_max > 0:
        cached, maxc, hits, misses = streamer.hybrid_cache_stats()
        extra = f" | cache {cached}/{maxc} RAM, {hits} hits / {misses} miss"
    print(f"  -> {len(output_tokens)} tokens en {elapsed:.1f}s ({tok_s:.2f} tok/s) | VRAM {cuda_mem_gib():.2f} GiB{extra}")

    return session.tokenizer.decode(output_tokens, skip_special_tokens=True)


def generate_once(model_dir: str, messages: list[dict[str, str]], args: argparse.Namespace) -> str:
    session = create_session(model_dir, args)
    return generate(session, messages)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="WeightStream PoC — layer streaming (llm-layer-prefetch)")
    p.add_argument(
        "--model-dir",
        default="models/qwen2.5-7b-instruct",
        help="Dossier modele safetensors 7B (sharded)",
    )
    p.add_argument(
        "--repo",
        default="Qwen/Qwen2.5-7B-Instruct",
        help="Repo Hugging Face si --download",
    )
    p.add_argument("--download", action="store_true", help="Telecharger le modele si absent")
    p.add_argument("--download-only", action="store_true", help="Telecharger puis quitter")
    p.add_argument("--prompt", default="Explique en une phrase ce qu'est le streaming de poids.")
    p.add_argument("--system", default="Reply in the same language as the user. Be concise.")
    p.add_argument("--max-tokens", type=int, default=32)
    p.add_argument("--temperature", type=float, default=0.0)
    p.add_argument("--top-k", type=int, default=0)
    p.add_argument(
        "--profile",
        choices=["gpu_first", "turbo", "hybrid", "balanced", "comfort", "max", "light"],
        default="gpu_first",
        help="gpu_first=7B defaut (VRAM max); turbo=alias; autres=benchmark disque",
    )
    p.add_argument("--n-gpu", type=int, default=None, help="Override pipeline GPU")
    p.add_argument("--n-cpu-pinned", type=int, default=None, help="Override cache RAM pinnee (couches)")
    p.add_argument("--n-cpu", type=int, default=None, help="Override buffers lecture disque")
    p.add_argument("--batch-gpu", type=int, default=None)
    p.add_argument("--batch-cpu-pinned", type=int, default=None)
    p.add_argument("--batch-cpu", type=int, default=None)
    p.add_argument("--vram-reserve-gib", type=float, default=0.25, help="Marge VRAM libre (turbo, defaut 250 MiB)")
    p.add_argument("--progress", action="store_true", help="Barres tqdm (cache RAM, tokens)")
    p.add_argument("--chat", action="store_true", help="Mode interactif")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    if not torch.cuda.is_available():
        print("CUDA requis (GPU NVIDIA + PyTorch CUDA).", file=sys.stderr)
        sys.exit(1)

    ensure_model(args.model_dir, args.repo, args.download or args.download_only or args.chat)
    if args.download_only:
        print(f"Modele pret: {args.model_dir}")
        return

    if args.chat:
        print("Mode chat (layer streaming). Ctrl+C pour quitter.")
        if args.profile in ("gpu_first", "turbo"):
            print("Profil gpu_first: GPU pilote — RAM preload puis VRAM max (~1-2 min 1er lancement).\n")
        elif args.profile == "hybrid":
            print("Profil hybrid: cache RAM partiel + disque. Token 1 lent, suivants plus rapides.\n")
        else:
            print(
                f"Profil {args.profile}: streaming disque reel — chaque token relit les couches depuis le SSD."
            )
            print("Attendu: lent sur gros modele (SSD bound). 1er token = cache OS froid.\n")
        session = create_session(args.model_dir, args)
        history: list[dict[str, str]] = [{"role": "system", "content": args.system}]
        while True:
            try:
                user = input("Toi> ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                break
            if not user:
                continue
            history.append({"role": "user", "content": user})
            reply = generate(session, history)
            history.append({"role": "assistant", "content": reply})
            print("Assistant>", reply, "\n")
    else:
        messages = [
            {"role": "system", "content": args.system},
            {"role": "user", "content": args.prompt},
        ]
        print(generate_once(args.model_dir, messages, args))


if __name__ == "__main__":
    main()
