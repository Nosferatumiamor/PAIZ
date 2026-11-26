// Moniteur de la machine, pour les jauges de la nouvelle interface : processeur, mémoire vive, carte graphique (calcul + mémoire).
// Mesure légère : au plus une lecture toutes les 1,5 s, quel que soit le nombre de fenêtres qui demandent.
import os from 'node:os';
import { execFile } from 'node:child_process';

let lastCpu = null; let cache = null; let cacheAt = 0; let gpuOk = true;
function cpuPct() {
  const now = os.cpus().map((c) => c.times);
  const prev = lastCpu; lastCpu = now;
  if (!prev || prev.length !== now.length) return null;
  let idle = 0; let total = 0;
  now.forEach((t, i) => { const p = prev[i]; const d = (k) => t[k] - p[k]; const tot = d('user') + d('nice') + d('sys') + d('idle') + d('irq'); idle += d('idle'); total += tot; });
  return total > 0 ? Math.round((1 - idle / total) * 100) : null;
}
function gpu() {
  if (!gpuOk) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 3000, windowsHide: true }, (e, out) => {
      if (e) { gpuOk = false; resolve(null); return; } // pas de carte NVIDIA : on n'insiste pas
      const [util, used, total] = String(out).split('\n')[0].split(',').map((x) => Number(x.trim()));
      resolve(Number.isFinite(util) ? { util, vramUsedMb: used, vramTotalMb: total } : null);
    });
  });
}
export async function sysStats() {
  if (cache && Date.now() - cacheAt < 1500) return cache;
  const g = await gpu();
  const total = os.totalmem(); const free = os.freemem();
  cache = { cpu: cpuPct(), ram: { usedMb: Math.round((total - free) / 1048576), totalMb: Math.round(total / 1048576) }, gpu: g };
  cacheAt = Date.now();
  return cache;
}
