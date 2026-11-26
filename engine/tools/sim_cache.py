#!/usr/bin/env python3
"""Rejoue une trace d'accès aux experts (WS_TRACE=fichier au lancement de ws_npc_server / ws_moe_probe) et compare des politiques de cache :
LRU, LFU, et Belady (optimal : il connaît l'avenir, donc c'est le plafond de ce qu'aucune politique ne peut dépasser).

    python tools/sim_cache.py trace.bin --slots 64 128 256 512 [--max-tokens 32] [--expert-mib 12]
    python tools/sim_cache.py --synthetic            # trace synthétique (Zipf) pour tester le script

Format de la trace : suite d'enregistrements int32 little-endian [couche, n_tokens, n, expert_1..expert_n] (experts distincts d'un plan()).
Idée reprise de kimi-k3-in-c (tools/sim_cache.py + Belady vs LRU) : mesurer l'écart à l'optimal AVANT de toucher à la politique réelle.
Un « slot » = un expert d'une couche ; la clé du cache est (couche, expert)."""
from __future__ import annotations

import argparse
import io
import heapq
import random
import struct
import sys
from collections import OrderedDict, defaultdict


def read_trace(path: str, max_tokens: int):
    data = open(path, "rb").read()
    out, i, n = [], 0, len(data)
    while i + 12 <= n:
        il, ntok, k = struct.unpack_from("<iii", data, i)
        i += 12
        if k < 0 or i + 4 * k > n:
            break
        ex = struct.unpack_from(f"<{k}i", data, i)
        i += 4 * k
        if ntok <= max_tokens:
            out.append((il, ex))
    return out


def synthetic(n_layers=40, n_experts=128, topk=8, steps=600, skew=1.1, seed=1):
    rng = random.Random(seed)
    weights = [[1 / (r + 1) ** skew for r in range(n_experts)] for _ in range(n_layers)]
    for w in weights:
        rng.shuffle(w)
    recs = []
    for _ in range(steps):
        for il in range(n_layers):
            picked = set()
            while len(picked) < topk:
                picked.add(rng.choices(range(n_experts), weights[il])[0])
            recs.append((il, tuple(sorted(picked))))
    return recs


def sim_lru(recs, cap):
    cache, hit, tot = OrderedDict(), 0, 0
    for il, ex in recs:
        keys = [(il, e) for e in ex]
        for k in keys:
            tot += 1
            if k in cache:
                hit += 1
                cache.move_to_end(k)
        for k in keys:
            if k not in cache:
                while len(cache) >= cap:
                    for old in cache:                # le plus ancien qui n'est pas demandé par ce même enregistrement
                        if old not in keys:
                            del cache[old]
                            break
                    else:
                        break
                cache[k] = True
    return hit / tot if tot else 0.0


def sim_lfu(recs, cap):
    cache, freq, hit, tot = set(), defaultdict(int), 0, 0
    heap = []                                          # (frequence, cle) ; entrees perimees ignorees
    for il, ex in recs:
        keys = {(il, e) for e in ex}
        for k in keys:
            tot += 1
            freq[k] += 1
            if k in cache:
                hit += 1
                heapq.heappush(heap, (freq[k], k))
        for k in keys:
            if k in cache:
                continue
            if len(cache) >= cap:
                skipped, victim = [], None
                while heap:
                    f, c = heapq.heappop(heap)
                    if c not in cache or freq[c] != f:
                        continue
                    if c in keys:
                        skipped.append((f, c))
                        continue
                    victim = c
                    break
                for sk in skipped:
                    heapq.heappush(heap, sk)
                if victim is None:
                    continue
                cache.discard(victim)
            cache.add(k)
            heapq.heappush(heap, (freq[k], k))
    return hit / tot if tot else 0.0


def sim_belady(recs, cap):
    # prochaine utilisation de chaque clé après chaque accès
    nxt, last = [None] * len(recs), {}
    for idx in range(len(recs) - 1, -1, -1):
        il, ex = recs[idx]
        nxt[idx] = [last.get((il, e), float("inf")) for e in ex]
        for e in ex:
            last[(il, e)] = idx
    cache, hit, tot = {}, 0, 0                         # clé -> prochain accès
    heap = []                                          # (-prochain accès, clé) ; entrées périmées ignorées
    for idx, (il, ex) in enumerate(recs):
        keys = {(il, e) for e in ex}
        for j, e in enumerate(ex):
            k = (il, e)
            tot += 1
            if k in cache:
                hit += 1
            cache_next = nxt[idx][j]
            if k in cache:
                cache[k] = cache_next
                heapq.heappush(heap, (-cache_next, k))
        for j, e in enumerate(ex):
            k = (il, e)
            if k in cache:
                continue
            if len(cache) >= cap:
                skipped = []
                victim = None
                while heap:
                    neg, c = heapq.heappop(heap)
                    if c not in cache or cache[c] != -neg:
                        continue
                    if c in keys:
                        skipped.append((neg, c))
                        continue
                    victim = c
                    break
                for s in skipped:
                    heapq.heappush(heap, s)
                if victim is None:
                    continue
                del cache[victim]
            cache[k] = nxt[idx][j]
            heapq.heappush(heap, (-cache[k], k))
    return hit / tot if tot else 0.0


def main() -> int:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trace", nargs="?")
    ap.add_argument("--slots", type=int, nargs="+", default=[64, 128, 256, 512, 1024])
    ap.add_argument("--max-tokens", type=int, default=32, help="ignore les enregistrements de plus de N jetons (gros lots : cache contourné)")
    ap.add_argument("--expert-mib", type=float, default=0.0, help="taille d'un expert (Mo) pour afficher la capacité en Go")
    ap.add_argument("--synthetic", action="store_true")
    a = ap.parse_args()
    if a.synthetic:
        recs = synthetic()
    elif a.trace:
        recs = read_trace(a.trace, a.max_tokens)
    else:
        ap.error("trace ou --synthetic requis")
    if not recs:
        print("trace vide", file=sys.stderr)
        return 1
    distinct = len({(il, e) for il, ex in recs for e in ex})
    print(f"{len(recs)} enregistrements, {distinct} experts distincts touchés")
    print(f"{'slots':>7} {'Go':>7} {'LRU':>7} {'LFU':>7} {'Belady':>7}  ecart LRU-optimal")
    for cap in a.slots:
        l, f, b = sim_lru(recs, cap), sim_lfu(recs, cap), sim_belady(recs, cap)
        gb = f"{cap * a.expert_mib / 1024:.1f}" if a.expert_mib else "-"
        print(f"{cap:>7} {gb:>7} {l * 100:6.1f}% {f * 100:6.1f}% {b * 100:6.1f}%  {(b - l) * 100:+.1f} pts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
