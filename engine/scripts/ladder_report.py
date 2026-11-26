#!/usr/bin/env python3
"""Median table over one or more ladder summary.tsv files, with estimated response times.
Usage: ladder_report.py summary1.tsv [summary2.tsv ...]
Time for an answer of N tokens ~ prompt_tokens/prompt_tps + N/gen_tps (prompt assumed 40 tokens)."""
import csv, statistics, sys
from collections import defaultdict

P_TOK = 40
rows = defaultdict(lambda: defaultdict(list))
hashes = set()
for path in sys.argv[1:]:
    for r in csv.DictReader(open(path, encoding="utf-8"), delimiter="\t"):
        if r["status"] != "ok":
            continue
        k = (int(r["vram_cache_mib"]), r["ram_avail_mib"])
        for f in ("prompt_tps", "gen_tps", "peak_ws_mib", "peak_vram_mib"):
            rows[(k, r["mode"])][f].append(float(r[f]))
        hashes.add(r["text_hash"])

def med(k, mode, f):
    return statistics.median(rows[(k, mode)][f]) if rows[(k, mode)][f] else None

def fmt(sec):
    sec = int(round(sec))
    return f"{sec // 60}:{sec % 60:02d}"

def eta(k, mode, n):
    p, g = med(k, mode, "prompt_tps"), med(k, mode, "gen_tps")
    return fmt(P_TOK / p + n / g) if p and g else "-"

keys = sorted({k for (k, _m) in rows}, key=lambda k: (k[1] == "none", -(int(k[1]) if k[1] != "none" else 0), -k[0]))
print("| VRAM cache | RAM dispo | mode | gen tok/s | 100 tok | 300 tok | 1000 tok | pic RAM | pic VRAM |")
print("|---|---|---|---|---|---|---|---|---|")
for k in keys:
    for mode in ("stock", "ws"):
        if (k, mode) not in rows:
            continue
        print(f"| {k[0]/1000:.1f} Go | {'libre' if k[1]=='none' else str(round(int(k[1])/1000,1))+' Go'} | "
              f"{'llama.cpp' if mode=='stock' else 'WeightStream'} | {med(k,mode,'gen_tps'):.1f} | "
              f"{eta(k,mode,100)} | {eta(k,mode,300)} | {eta(k,mode,1000)} | "
              f"{med(k,mode,'peak_ws_mib')/1024:.1f} Go | {med(k,mode,'peak_vram_mib')/1024:.1f} Go |")
print(f"\nempreintes de texte distinctes : {len(hashes)} (1 = tous les essais produisent le même texte)")
