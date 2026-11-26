// Entretien : santé des disques, caches d'applications LLM (la « chasse d'eau »), sauvegarde des dossiers de modèles.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { getRoot, listRoots, logEvent, deleteAssetRow } from './db.js';
import { recycleToWindowsBin } from './jobs.js';
import { DATA_DIR } from './config.js';

const home = () => process.env.PAIZ_FAKE_HOME || os.homedir();
const local = () => process.env.PAIZ_FAKE_HOME ? path.join(process.env.PAIZ_FAKE_HOME, 'AppData', 'Local') : (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));

// ---------------------------------------------------------------------------
// Santé des disques (Windows : Get-PhysicalDisk + compteurs de fiabilité)
// ---------------------------------------------------------------------------
const PS_HEALTH = `
$ErrorActionPreference='SilentlyContinue'
$out=@()
foreach($d in Get-PhysicalDisk){
  $r=$d | Get-StorageReliabilityCounter
  $letters=@(Get-Disk -Number $d.DeviceId | Get-Partition | Where-Object DriveLetter | ForEach-Object { [string]$_.DriveLetter })
  $out+=[pscustomobject]@{
    name=$d.FriendlyName; media=[string]$d.MediaType; bus=[string]$d.BusType; health=[string]$d.HealthStatus; op=[string]$d.OperationalStatus; size=[int64]$d.Size
    temp=$r.Temperature; wear=$r.Wear; hours=$r.PowerOnHours; readErr=$r.ReadErrorsUncorrected; writeErr=$r.WriteErrorsUncorrected; letters=$letters }
}
$out | ConvertTo-Json -Compress -Depth 4`;

function verdict(d) {
  const notes = []; let level = 'ok';
  const bump = (l, msg) => { notes.push(msg); if (l === 'danger' || (l === 'warn' && level === 'ok')) level = l; };
  if (d.health && d.health !== 'Healthy') bump('danger', `État Windows : ${d.health}`);
  if (d.op && d.op !== 'OK') bump('warn', `Statut : ${d.op}`);
  if (d.wear != null && d.wear >= 90) bump('danger', `Usure ${d.wear} %`);
  else if (d.wear != null && d.wear >= 70) bump('warn', `Usure ${d.wear} %`);
  if ((d.readErr || 0) + (d.writeErr || 0) > 0) bump('warn', `Erreurs non corrigées : ${d.readErr || 0} lecture / ${d.writeErr || 0} écriture`);
  if (d.temp != null && d.temp >= 70) bump('warn', `Température ${d.temp} °C`);
  if (d.media === 'HDD' && d.hours != null && d.hours >= 35000) bump('warn', `${d.hours} h de fonctionnement (disque âgé)`);
  if (d.health === 'Healthy' && d.temp == null && d.wear == null && d.hours == null) notes.push('Compteurs détaillés indisponibles (boîtier USB ou droits) : seul l\'état global est connu.');
  return { level, notes };
}

export function diskHealth() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve({ supported: false, disks: [] }); return; }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_HEALTH], { timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) { resolve({ supported: true, error: err.message, disks: [] }); return; }
      let arr = [];
      try { const j = JSON.parse(stdout); arr = Array.isArray(j) ? j : [j]; } catch { /* vide */ }
      const disks = arr.map((d) => ({ ...d, letters: [].concat(d.letters || []), ...verdict(d) }));
      resolve({ supported: true, disks });
    });
  });
}

// ---------------------------------------------------------------------------
// Caches d'applications
// ---------------------------------------------------------------------------
// kind « cache » : se retélécharge tout seul au besoin. kind « library » : modèles réellement téléchargés par une appli (ils reviendront seulement en les retéléchargeant).
export function cacheTargets() {
  const h = home(); const l = local();
  const env = (k) => (process.env.PAIZ_FAKE_HOME ? null : process.env[k]);
  const hf = env('HF_HUB_CACHE') || env('HUGGINGFACE_HUB_CACHE') || (env('HF_HOME') ? path.join(env('HF_HOME'), 'hub') : path.join(h, '.cache', 'huggingface', 'hub'));
  return [
    { id: 'hf', label: 'Hugging Face (hub)', path: hf, kind: 'cache', note: 'Un dossier par dépôt. Utilisé par transformers, diffusers, ComfyUI, TTS… : ce qui sert encore sera retéléchargé au prochain lancement.' },
    { id: 'hf-xet', label: 'Hugging Face (xet)', path: path.join(h, '.cache', 'huggingface', 'xet'), kind: 'cache', note: 'Fragments de téléchargement dédupliqués.' },
    { id: 'torch', label: 'PyTorch hub', path: path.join(h, '.cache', 'torch'), kind: 'cache', note: 'Poids pré-entraînés téléchargés par torch.hub / torchvision.' },
    { id: 'modelscope', label: 'ModelScope', path: path.join(h, '.cache', 'modelscope'), kind: 'cache', note: 'Équivalent chinois de Hugging Face.' },
    { id: 'clip', label: 'CLIP / OpenCLIP', path: path.join(h, '.cache', 'clip'), kind: 'cache', note: 'Poids CLIP téléchargés par certaines applis.' },
    { id: 'whisper', label: 'Whisper', path: path.join(h, '.cache', 'whisper'), kind: 'cache', note: 'Modèles de transcription.' },
    { id: 'tts', label: 'Coqui TTS', path: path.join(l, 'tts'), kind: 'cache', note: 'Voix téléchargées par Coqui TTS.' },
    { id: 'llamacpp', label: 'llama.cpp (-hf)', path: path.join(l, 'llama.cpp'), kind: 'cache', note: 'Modèles tirés avec l\'option -hf.' },
    { id: 'keras', label: 'Keras', path: path.join(h, '.keras'), kind: 'cache', note: 'Poids Keras.' },
    { id: 'lmstudio', label: 'LM Studio', path: path.join(h, '.cache', 'lm-studio'), kind: 'library', note: 'Fichiers de l’application LM Studio (runtimes, extensions) : pas de modèles ici, mais les vider casse l’appli jusqu’à sa réinstallation.' },
    { id: 'lmstudio2', label: 'LM Studio (.lmstudio)', path: path.join(h, '.lmstudio', 'models'), kind: 'library', note: 'Nouvel emplacement de la bibliothèque LM Studio.' },
    { id: 'ollama', label: 'Ollama', path: env('OLLAMA_MODELS') || path.join(h, '.ollama', 'models'), kind: 'library', note: 'Bibliothèque d\'Ollama : modèles à retirer plutôt avec « ollama rm ».' },
    { id: 'gpt4all', label: 'GPT4All', path: path.join(l, 'nomic.ai', 'GPT4All'), kind: 'library', note: 'Modèles de GPT4All.' },
    { id: 'jan', label: 'Jan', path: path.join(h, 'jan', 'models'), kind: 'library', note: 'Modèles de Jan.' },
  ];
}

async function dirSize(p, budget = { files: 400000 }) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = await fsp.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (--budget.files <= 0) return total;
      const full = path.join(cur, e.name);
      if (e.isSymbolicLink()) continue; // les liens (HF snapshots -> blobs) ne comptent pas deux fois
      if (e.isDirectory()) stack.push(full);
      else { try { total += (await fsp.stat(full)).size; } catch { /* ignore */ } }
    }
  }
  return total;
}

async function newest(p) {
  try { const s = await fsp.stat(p); return s.mtimeMs; } catch { return 0; }
}

export async function scanCaches() {
  const out = [];
  for (const t of cacheTargets()) {
    if (!fs.existsSync(t.path)) continue;
    let names = [];
    try { names = await fsp.readdir(t.path, { withFileTypes: true }); } catch { continue; }
    const entries = [];
    for (const e of names) {
      if (e.name === 'CACHEDIR.TAG' || e.name === '.locks') continue;
      const full = path.join(t.path, e.name);
      const size = e.isDirectory() ? await dirSize(full) : (await fsp.stat(full).catch(() => ({ size: 0 }))).size;
      entries.push({ name: e.name, size, mtime: await newest(full) });
    }
    entries.sort((a, b) => b.size - a.size);
    const size = entries.reduce((s, e) => s + e.size, 0);
    if (size > 0 || entries.length) out.push({ ...t, size, entries });
  }
  return out;
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Vide un cache connu (liste blanche) : tout le contenu, ou seulement les entrées nommées. Jamais de chemin fourni par l'appelant.
export async function flushCache(db, { targetId, entries }) {
  const t = cacheTargets().find((x) => x.id === targetId);
  if (!t) throw new Error('Cache inconnu.');
  if (!fs.existsSync(t.path)) return { freed: 0, removed: [] };
  const base = await fsp.realpath(t.path);
  for (const r of listRoots(db)) { // on ne touche jamais à un dossier que PAIZ gère
    const rp = path.resolve(r.path);
    if (rp === base || inside(rp, base) || inside(base, rp)) throw new Error(`Refus : ${t.label} chevauche la racine PAIZ « ${r.name} ».`);
  }
  const names = Array.isArray(entries) && entries.length ? entries : (await fsp.readdir(base));
  let freed = 0; const removed = []; const failed = [];
  for (const n of names) {
    if (typeof n !== 'string' || n.includes('/') || n.includes('\\') || n === '..' || n === '.') continue;
    const full = path.join(base, n);
    if (!inside(base, full)) continue;
    let st; try { st = await fsp.lstat(full); } catch { continue; }
    const size = st.isDirectory() ? await dirSize(full) : st.size;
    try { await fsp.rm(full, { recursive: true, force: true, maxRetries: 2 }); freed += size; removed.push(n); } catch (e) { failed.push({ name: n, error: e.code || e.message }); }
  }
  return { freed, removed, failed };
}

// ---------------------------------------------------------------------------
// Restes oubliés : téléchargements interrompus, vieux dossiers de sauvegarde / caches inconnus, doublons au sein d'une même appli
// Rien n'est supprimé sans choix explicite ; les chemins sont toujours recalculés côté serveur (jamais pris tels quels du navigateur).
// ---------------------------------------------------------------------------
const PARTIAL_RE = /\.(tmp|part|partial|incomplete|crdownload|download|aria2)$/i;
const STALE_RE = /(backup|bak|old|ancien|copie|copy|archive|save)/i;
const SKIP_DIR = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information', '.mdisp-trash', '_paiz']);
const idOf = (p) => crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 12);

async function walkFiles(dir, visit, budget = { n: 400000 }, depth = 0) {
  let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (--budget.n <= 0) return;
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (depth < 8 && !SKIP_DIR.has(e.name.toLowerCase())) await walkFiles(full, visit, budget, depth + 1); } else await visit(full, e.name);
  }
}

export async function scanLeftovers(db) {
  const items = []; const seen = new Set();
  const add = (it) => { if (seen.has(it.path.toLowerCase())) return; seen.add(it.path.toLowerCase()); items.push({ id: idOf(it.path), ...it }); };
  const roots = listRoots(db);
  const known = cacheTargets().map((t) => path.resolve(t.path).toLowerCase());
  const cacheRoot = path.join(home(), '.cache');
  // 1) téléchargements interrompus : racines PAIZ + ~/.cache
  for (const base of [...roots.map((r) => r.path), cacheRoot]) {
    if (!fs.existsSync(base)) continue;
    await walkFiles(base, async (full, name) => {
      if (!PARTIAL_RE.test(name)) return;
      let st; try { st = await fsp.stat(full); } catch { return; }
      if (st.size < 20 * 1024 * 1024) return;
      add({ kind: 'partial', label: name, path: full, size: st.size, mtime: st.mtimeMs, isDir: false, note: 'Téléchargement interrompu ou fichier temporaire : inutilisable tel quel.' });
    });
  }
  // 2) dossiers de ~/.cache hors liste connue : vieille sauvegarde ou cache d'une appli inconnue
  if (fs.existsSync(cacheRoot)) {
    let names = []; try { names = await fsp.readdir(cacheRoot, { withFileTypes: true }); } catch { /* ignore */ }
    for (const e of names) {
      if (!e.isDirectory()) continue;
      const full = path.join(cacheRoot, e.name); const low = path.resolve(full).toLowerCase();
      if (known.some((k) => k === low || k.startsWith(low + path.sep))) continue;
      const size = await dirSize(full); if (size < 50 * 1024 * 1024) continue;
      const stale = STALE_RE.test(e.name);
      add({ kind: stale ? 'stale' : 'unknown', label: e.name, path: full, size, mtime: await newest(full), isDir: true,
        note: stale ? 'Le nom évoque une ancienne sauvegarde ou copie de cache.' : 'Cache d\'une application que PAIZ ne connaît pas : vérifie avant de supprimer.' });
    }
  }
  // 3) doublons exacts à l'intérieur d'un même repo actif / externe (même taille + même empreinte rapide)
  const rows = db.prepare(`SELECT a.id, a.abs_path, a.file_name, a.size_bytes, a.quick_hash, a.root_id, r.name AS root_name FROM assets a JOIN roots r ON r.id = a.root_id
    WHERE a.state = 'present' AND r.role IN ('active','external') AND a.quick_hash IS NOT NULL AND a.size_bytes > 1048576`).all();
  const groups = new Map();
  for (const a of rows) { const k = `${a.root_id}|${a.quick_hash}|${a.size_bytes}`; (groups.get(k) || groups.set(k, []).get(k)).push(a); }
  for (const g of groups.values()) {
    const live = g.filter((a) => fs.existsSync(a.abs_path)).sort((x, y) => x.abs_path.length - y.abs_path.length || x.abs_path.localeCompare(y.abs_path));
    for (const a of live.slice(1)) add({ kind: 'dupe', label: a.file_name, path: a.abs_path, size: a.size_bytes, mtime: await newest(a.abs_path), isDir: false, assetId: a.id,
      note: `Identique à ${live[0].abs_path} (même repo « ${a.root_name} »). Vérifie que l'appli ne cherche pas ce fichier à CET endroit.` });
  }
  return items.sort((a, b) => b.size - a.size);
}

export async function removeLeftovers(db, { ids = [], permanent = false } = {}) {
  const want = new Set(ids.map(String)); const all = await scanLeftovers(db);
  const todo = all.filter((x) => want.has(x.id)); if (!todo.length) throw new Error('Rien à supprimer : ces éléments ont disparu.');
  const roots = listRoots(db).map((r) => path.resolve(r.path));
  const freed = []; const failed = [];
  for (const x of todo) {
    try {
      const full = path.resolve(x.path);
      if (x.isDir && roots.some((r) => full === r || inside(full, r) || inside(r, full))) throw new Error('chevauche une racine PAIZ');
      if (!fs.existsSync(full)) throw new Error('déjà disparu');
      if (permanent) await fsp.rm(full, { recursive: true, force: true, maxRetries: 2 });
      else {
        const rb = await recycleToWindowsBin(full);
        if (!rb.ok) throw new Error(rb.cancelled ? 'annulé par Windows' : rb.nobin ? 'pas de corbeille sur ce disque : utilise « Effacer »' : `corbeille impossible : ${rb.reason}`);
      }
      if (x.assetId) deleteAssetRow(db, x.assetId);
      logEvent(db, 'menage', x.assetId ?? null, { path: full, kind: x.kind, size: x.size, permanent });
      try { fs.appendFileSync(path.join(DATA_DIR, 'menage-journal.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: x.kind, path: full, size: x.size, permanent }) + '\n'); } catch { /* journal facultatif */ }
      freed.push({ id: x.id, bytes: x.size });
    } catch (e) { failed.push({ id: x.id, file: x.label, error: e.message }); }
  }
  return { freed: freed.length, bytes: freed.reduce((n, f) => n + f.bytes, 0), failed };
}

// ---------------------------------------------------------------------------
// Sauvegarde d'une racine vers un autre disque (robocopy : incrémental, ne supprime rien à destination)
// ---------------------------------------------------------------------------
export const backup = { running: false, src: null, dest: null, lines: [], code: null, startedAt: null, endedAt: null };

export function startBackup(db, { rootId, dest }) {
  if (backup.running) throw new Error('Une sauvegarde est déjà en cours.');
  const root = getRoot(db, rootId);
  if (!root) throw new Error('Racine inconnue.');
  if (!dest || typeof dest !== 'string') throw new Error('Destination requise.');
  const src = path.resolve(root.path); const target = path.join(path.resolve(dest), `PAIZ-backup-${root.name.replace(/[^\w.-]+/g, '_')}`);
  if (!fs.existsSync(src)) throw new Error('Dossier source absent.');
  if (inside(src, target) || path.resolve(dest) === src) throw new Error('La destination ne peut pas être dans la source.');
  if (process.platform !== 'win32') throw new Error('Sauvegarde : Windows uniquement (robocopy) pour l\'instant.');
  Object.assign(backup, { running: true, src, dest: target, lines: [], code: null, startedAt: new Date().toISOString(), endedAt: null });
  const p = spawn('robocopy.exe', [src, target, '/E', '/XO', '/R:1', '/W:1', '/NP', '/NDL', '/MT:4', '/XD', '.mdisp-trash'], { windowsHide: true });
  const push = (b) => { for (const l of String(b).split(/\r?\n/)) if (l.trim()) backup.lines.push(l.trim()); if (backup.lines.length > 60) backup.lines = backup.lines.slice(-60); };
  p.stdout.on('data', push); p.stderr.on('data', push);
  p.on('exit', (c) => { backup.running = false; backup.code = c; backup.endedAt = new Date().toISOString(); });
  p.on('error', (e) => { backup.running = false; backup.code = -1; push(e.message); });
  return backup;
}
