// Premier lancement : état de la machine pour l'assistant de démarrage (dossiers SSD / réserve, OpenCode, modèles conseillés),
// et installation d'OpenCode Desktop (son installeur officiel, lancé visible : l'utilisateur le voit et le valide).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getSetting, setSetting, listRoots, queryAssets } from './db.js';
import { diskHealth } from './maintenance.js';
import { opencodeExe } from './engine.js';
import { listLocalVolumes } from './volumes.js';

// Modèles proposés à l'installation (fichiers vérifiés sur Hugging Face le 2026-11-25).
export const STARTER_MODELS = [
  { key: 'gemma', id: 'unsloth/gemma-4-26B-A4B-it-GGUF', file: 'gemma-4-26B-A4B-it-UD-Q4_K_M.gguf', size: 16947541728, recommended: true,
    label: 'Gemma 4 26B-A4B (Q4_K_M)', note: 'Premier modèle conseillé : discussion, écriture, code léger. Tourne dès ~4 Go de VRAM.' },
  { key: 'qwen', id: 'unsloth/Qwen3-Coder-Next-GGUF', file: 'Qwen3-Coder-Next-Q4_K_M.gguf', size: 48528320544, recommended: false,
    label: 'Qwen3-Coder-Next (Q4_K_M)', note: 'Gros modèle de code pour les tâches de fond. Lent (≈ 5 jetons/s avec 12 Go de VRAM et 32 Go de RAM) ; 32 Go de RAM conseillés.' },
];
const OPENCODE_URL = 'https://opencode.ai/update/api/latest/desktop/opencode/opencode-desktop-win-x64.exe';

export const setupDone = (db) => getSetting(db, 'setup.done', false) === true || getSetting(db, 'setup.done', '') === 'true';
export function markSetupDone(db) { setSetting(db, 'setup.done', true); return { done: true }; }

/** Tout ce que l'assistant affiche : disques (type, place), dossiers déjà suivis, OpenCode, modèles conseillés déjà présents. */
export async function setupState(db) {
  const health = await diskHealth().catch(() => ({ disks: [] }));
  const media = new Map();
  for (const d of health.disks || []) for (const l of d.letters || []) media.set(String(l).toUpperCase(), { media: String(d.media || ''), bus: String(d.bus || ''), name: d.name || '' });
  const drives = [];
  for (const v of await listLocalVolumes({ includeRemovable: true }).catch(() => [])) {
    const p = typeof v === 'string' ? v : v.path; const letter = p.slice(0, 1).toUpperCase();
    try {
      const st = await fsp.statfs(p); const m = media.get(letter) || {};
      const ssd = /ssd/i.test(m.media) || /nvme/i.test(m.bus); const hdd = /hdd/i.test(m.media);
      drives.push({ path: `${letter}:`, free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize), kind: ssd ? 'ssd' : hdd ? 'hdd' : 'unknown', nvme: /nvme/i.test(m.bus), usb: /usb/i.test(m.bus), name: m.name || '' });
    } catch { /* lecteur illisible */ }
  }
  const have = (file) => queryAssets(db, { q: file.replace(/\.gguf$/i, ''), limit: 5 }).items.some((a) => a.file_name.toLowerCase() === file.toLowerCase() && a.state !== 'missing');
  return {
    done: setupDone(db),
    drives,
    roots: listRoots(db).map((r) => ({ id: r.id, name: r.name, path: r.path, role: r.role })),
    opencode: { installed: !!opencodeExe(), path: opencodeExe() },
    machine: { ramGb: Math.round(os.totalmem() / 1e9) },
    models: STARTER_MODELS.map((m) => ({ ...m, present: have(m.file) })),
  };
}

let ocJob = null;
/** Télécharge l'installeur officiel d'OpenCode Desktop puis le lance (fenêtre visible). */
export function installOpencode() {
  if (process.platform !== 'win32') throw new Error('Installation automatique disponible sous Windows seulement : voir https://opencode.ai/download');
  if (ocJob?.state === 'download') return ocJob;
  ocJob = { state: 'download', bytes: 0, total: 0, error: '' };
  (async () => {
    try {
      const dest = path.join(os.tmpdir(), 'opencode-desktop-win-x64.exe');
      const r = await fetch(OPENCODE_URL, { redirect: 'follow' });
      if (!r.ok || !r.body) throw new Error(`Téléchargement refusé (HTTP ${r.status})`);
      ocJob.total = Number(r.headers.get('content-length')) || 0;
      const body = Readable.fromWeb(r.body); body.on('data', (c) => { ocJob.bytes += c.length; });
      await pipeline(body, fs.createWriteStream(dest));
      ocJob.state = 'installer';
      spawn('cmd.exe', ['/c', 'start', '""', dest], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (e) { ocJob.state = 'error'; ocJob.error = String(e.message || e); }
  })();
  return ocJob;
}
export const opencodeJob = () => ({ ...(ocJob || { state: 'idle' }), installed: !!opencodeExe() });
