#!/bin/bash
# Footprint squeeze: no RAM limiter. Each config "cache_mib:ws_ram_mib:ubatch" is run once and reports the real
# process footprint (peak working set, peak private commit, GPU memory used minus the idle baseline), the speed it
# costs, and a hash of the generated text.
# Usage: squeeze-moe.sh model.gguf outdir n_tokens prompt_file "cache:ws:ub cache:ws:ub ..."
# ws = 0 runs llama.cpp alone (no WeightStream); EXTRA="..." adds probe flags to every run (e.g. CPU streaming).
M="$1"; OUT="$2"; N="$3"; PF="$4"; CFGS="$5"
BIN="$(cd "$(dirname "$0")/../build-llama/bin" && pwd)"
mkdir -p "$OUT"; SUM="$OUT/summary.tsv"; P="$(cat "$PF")"
printf 'cache_mib\tws_ram_mib\tubatch\tprompt_s\tgen_tps\treply40_s\tpeak_ws_mib\tpeak_commit_mib\tvram_delta_mib\ttext_hash\tstatus\tfallback\n' > "$SUM"
for c in $CFGS; do
  IFS=: read V R U <<< "$c"; f="$OUT/c${V}_r${R}_u${U}.txt"
  sleep 3; BASE=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -1)
  ( while :; do nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits; sleep 0.4; done ) > "$OUT/vram.tmp" 2>/dev/null & SP=$!
  WSARG=(); [ "$R" != 0 ] && WSARG=(--ws-ram-mib "$R")
  # shellcheck disable=SC2086
  timeout 900 "$BIN/ws_moe_probe.exe" -m "$M" -p "$P" -n "$N" --cache-mib "$V" --ubatch "$U" "${WSARG[@]}" $EXTRA > "$f" 2>&1; rc=$?
  kill $SP 2>/dev/null; wait $SP 2>/dev/null
  PV=$(sort -n "$OUT/vram.tmp" | tail -1); D=$(( PV - BASE ))
  ps=$(grep -oE 'prompt [0-9]+ tok in [0-9.]+' "$f" | grep -oE '[0-9.]+$')
  tg=$(grep -oE 'gen [0-9]+ tok in [0-9.]+ s \([0-9.]+' "$f" | grep -oE '[0-9.]+$')
  pw=$(grep -oE 'peak working set [0-9]+' "$f" | grep -oE '[0-9]+$')
  pc=$(grep -oE 'peak commit [0-9]+' "$f" | grep -oE '[0-9]+$')
  hh=$(grep -oE 'text hash [0-9a-f]+' "$f" | awk '{print $3}')
  fb=no; grep -q "falling back to mmap" "$f" && fb=yes
  e40=$(python -c "print(round(float('${ps:-0}')+40/float('${tg:-1}'),1))" 2>/dev/null)
  st=ok; [ $rc -ne 0 ] && st="rc=$rc"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$V" "$R" "$U" "$ps" "$tg" "$e40" "$pw" "$pc" "$D" "$hh" "$st" "$fb" >> "$SUM"
done
echo DONE >> "$SUM"
