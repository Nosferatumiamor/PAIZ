#!/bin/bash
# Budget ladder: for each (VRAM expert cache, RAM left available) row, run stock llama.cpp and WeightStream
# on the same prompt and record speed, peak RAM, peak VRAM and a hash of the generated text.
# Usage: ladder-moe.sh model.gguf outdir [n_tokens]      RAM "none" = no limiter (whatever is free now)
M="$1"; OUT="$2"; N="${3:-128}"
BIN="$(cd "$(dirname "$0")/../build-llama/bin" && pwd)"
mkdir -p "$OUT"; SUM="$OUT/summary.tsv"
printf 'vram_cache_mib\tram_avail_mib\tmode\tws_ram_mib\tprompt_tps\tgen_tps\tpeak_ws_mib\tpeak_vram_mib\ttext_hash\tstatus\n' > "$SUM"
P_DEFAULT="Ecris en C++ un programme complet qui lit un fichier texte, compte la frequence de chaque mot, et affiche les dix mots les plus frequents. Explique ton code."
P="$P_DEFAULT"; [ -n "$PROMPT_FILE" ] && P="$(cat "$PROMPT_FILE")"
ROWS="${ROWS:-6000:none 4000:none 6000:8000 4000:8000 3000:6000 2000:4500 4000:4500}"
for row in $ROWS; do
  V=${row%%:*}; A=${row##*:}
  taskkill //F //IM ws_mem_hog.exe > /dev/null 2>&1
  if [ "$A" != none ] && { [ -z "$CAPPED" ] || [ -n "$HOGTOO" ]; }; then
    "$BIN/ws_mem_hog.exe" --leave-mib "$A" > "$OUT/hog_$A.log" 2>&1 &
    for i in $(seq 1 60); do grep -q "available now\|nothing to lock" "$OUT/hog_$A.log" 2>/dev/null && break; sleep 1; done
    sleep 6; cat "$OUT/hog_$A.log" >> "$OUT/hog_all.log"
  fi
  for mode in stock ws; do
    f="$OUT/v${V}_a${A}_${mode}.txt"; R=0
    args=(-m "$M" -p "$P" -n "$N" --cache-mib "$V" --ubatch 32)
    if [ "$mode" = ws ]; then
      if [ "$A" = none ]; then R=6000; else R=$(( A - ${RSUB:-3500} )); [ $R -lt ${RMIN:-500} ] && R=${RMIN:-500}; fi
      args+=(--ws-ram-mib "$R")
    fi
    ( while :; do nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits; sleep 0.5; done ) > "$OUT/vram.tmp" 2>/dev/null &
    SP=$!
    CAPCMD=(); [ -n "$CAPPED" ] && [ "$A" != none ] && CAPCMD=("$BIN/ws_run_capped.exe" --max-mib "$A" --)
    timeout 480 "${CAPCMD[@]}" "$BIN/ws_moe_probe.exe" "${args[@]}" > "$f" 2>&1; rc=$?
    kill $SP 2>/dev/null; wait $SP 2>/dev/null
    PV=$(sort -n "$OUT/vram.tmp" | tail -1)
    st=ok; [ $rc -ne 0 ] && st="rc=$rc"
    pp=$(grep -oE 'prompt [0-9]+ tok in [0-9.]+ s \([0-9.]+' "$f" | grep -oE '[0-9.]+$')
    tg=$(grep -oE 'gen [0-9]+ tok in [0-9.]+ s \([0-9.]+' "$f" | grep -oE '[0-9.]+$')
    pw=$(grep -oE 'peak working set [0-9]+' "$f" | grep -oE '[0-9]+$')
    hh=$(grep -oE 'text hash [0-9a-f]+' "$f" | awk '{print $3}')
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$V" "$A" "$mode" "$R" "$pp" "$tg" "$pw" "$PV" "$hh" "$st" >> "$SUM"
  done
  taskkill //F //IM ws_mem_hog.exe > /dev/null 2>&1
done
echo DONE >> "$SUM"
