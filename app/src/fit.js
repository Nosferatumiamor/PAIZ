// « Ça passe sur ma machine ? » pour un fichier GGUF, en tenant compte du streaming d'experts de WeightStream (pas seulement de llama.cpp).
// Estimation, pas une mesure : les chiffres viennent du journal du projet (engine/Docs/HANDOFF_2026-11.md, sections 26 et 36-37) :
//  - poids non-experts (attention, embeddings, experts partagés) ≈ 8 % du fichier ; ils restent en mémoire (RAM : +1 Go, VRAM : 0,8 x eux + 0,7 Go) ;
//  - les experts sont lus sur le SSD à travers un cache RAM (plafonné par la RAM de la machine, ~40 %) puis un cache VRAM (ce que la carte garde de libre) ;
//  - mesuré : Qwen3-Coder-Next 48 Go, 12 Go de VRAM, 32 Go de RAM : cache 8 Go RAM + 5 Go VRAM (≈ 27 % des experts) = ~5,5 jetons/s.
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const GB = 1073741824;
let spec = null; let specAt = 0;
export function machineSpecs() {
  if (spec && Date.now() - specAt < 60000) return spec;
  let vram = 0; let name = '';
  try {
    const r = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    const line = String(r.stdout || '').split('\n')[0].trim();
    if (line.includes(',')) { const [n, m] = line.split(','); name = n.trim(); vram = Number(m) * 1048576; }
  } catch { /* pas de carte NVIDIA */ }
  spec = { ramBytes: os.totalmem(), vramBytes: vram || 0, gpu: name }; specAt = Date.now();
  return spec;
}

const MOE_ARCH = /moe|mixtral|qwen3next|qwen3_next|gpt-?oss|deepseek[23]|llama4|dbrx|jamba|arctic|bailing|dots1|hunyuan|minimax|grove|smallthinker|olmoe|ernie4_5/i;
export const isMoe = (arch, id = '') => (arch ? MOE_ARCH.test(arch) : /moe|-a\d+b\b/i.test(id));

// size : octets du fichier. Retourne { tier: 'vram'|'ram'|'stream-ok'|'stream-slow'|'too-big'|'dense-slow', label, detail, cachePct }
export function estimateFit(size, { moe, machine = machineSpecs() }) {
  const ram = machine.ramBytes; const vram = machine.vramBytes;
  const kv = 1.5 * GB; // contexte 16k + tampons de calcul
  if (size + kv <= vram) return { tier: 'vram', label: 'tient en VRAM', detail: `Tout le modèle tient dans la carte graphique (${(size / GB).toFixed(1)} Go sur ${(vram / GB).toFixed(0)} Go) : vitesse maximale, WeightStream n'a rien à streamer.`, cachePct: 100 };
  if (!moe) {
    if (size + kv <= ram - 6 * GB + vram * 0.8) return { tier: 'ram', label: 'GPU + RAM (lent)', detail: 'Modèle dense : WeightStream ne streame que les experts des modèles MoE. Il tournera avec llama.cpp classique, réparti entre la carte et la RAM, donc assez lent.', cachePct: null };
    return { tier: 'dense-slow', label: 'trop gros (dense)', detail: 'Modèle dense plus gros que la RAM + VRAM utilisables : le streaming d\'experts ne s\'applique pas à lui. Il faudrait le lire en continu sur le SSD (extrêmement lent).', cachePct: null };
  }
  const N = size * 0.08; const E = size - N; // non-experts / experts
  const vramNeed = 0.8 * N + 0.7 * GB + kv; const ramNeed = N + 1 * GB;
  if (vram && vramNeed > vram) return { tier: 'too-big', label: 'trop gros', detail: `Même en streamant les experts, les poids non-experts (~${(N / GB).toFixed(1)} Go) ne tiennent pas dans la carte graphique.`, cachePct: 0 };
  if (ramNeed > ram - 6 * GB) return { tier: 'too-big', label: 'trop gros', detail: 'Les poids non-experts ne tiennent pas dans la RAM une fois la marge de sécurité réservée.', cachePct: 0 };
  const vramCache = Math.max(0, vram - vramNeed); const ramCache = Math.max(0, Math.min(ram * 0.4, ram - 8 * GB - ramNeed));
  const pct = Math.min(100, Math.round(((vramCache + ramCache) / E) * 100));
  const base = `cache d'experts ≈ ${(ramCache / GB).toFixed(0)} Go RAM + ${(vramCache / GB).toFixed(0)} Go VRAM, soit ~${pct} % des experts (${(E / GB).toFixed(0)} Go)`;
  const where = `${base} ; le reste est lu sur le SSD`;
  if (pct >= 100) return { tier: 'ram', label: 'tout en mémoire (rapide)', detail: `Les experts tiennent entièrement dans les caches : ${base}.`, cachePct: pct };
  if (pct >= 25) return { tier: 'stream-ok', label: `streamé · cache ${pct} %`, detail: `${where}. Repère mesuré ici : Qwen3-Coder-Next 48 Go avec 27 % de cache ≈ 5,5 jetons/s. Plus le cache est grand, plus c'est rapide.`, cachePct: pct };
  return { tier: 'stream-slow', label: `streamé · cache ${pct} % (lent)`, detail: `${where}. Il tournera et le texte sera identique, mais la plupart des experts viennent du SSD : lent.`, cachePct: pct };
}
