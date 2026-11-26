#!/bin/bash
# Speed vs memory sweep: VRAM expert cache x WeightStream RAM tier. Usage: sweep-moe.sh model.gguf outdir [n_tokens]
# ws-ram-mib 0 = stock llama.cpp (no WeightStream). Results: outdir/summary.txt (one line per run).
M="$1"; OUT="$2"; N="${3:-160}"
BIN="$(dirname "$0")/../build-llama/bin"
mkdir -p "$OUT"; : > "$OUT/summary.txt"
P="Ecris en C++ un programme complet qui lit un fichier texte, compte la frequence de chaque mot, et affiche les dix mots les plus frequents. Explique ton code."
for V in 2000 4000 6000 7500; do
  for R in 0 3000 6000; do
    f="$OUT/v${V}_r${R}.txt"
    if [ "$R" = 0 ]; then "$BIN/ws_moe_probe.exe" -m "$M" -p "$P" -n "$N" --cache-mib $V --ubatch 32 > "$f" 2>&1
    else "$BIN/ws_moe_probe.exe" -m "$M" -p "$P" -n "$N" --cache-mib $V --ubatch 32 --ws-ram-mib $R > "$f" 2>&1; fi
    echo "vram=$V ram=$R | $(grep -E 'ws_moe_probe\] load' "$f") | $(grep -E 'WeightStream: ' "$f")" >> "$OUT/summary.txt"
  done
done
echo DONE >> "$OUT/summary.txt"
