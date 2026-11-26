// Découvrir : parcourir Hugging Face (recherche, tri par téléchargements/likes, fichiers GGUF avec tailles) et télécharger vers une racine PAIZ.
// Seuls les termes de recherche et les identifiants de modèles quittent la machine ; aucun téléchargement ne démarre sans une action explicite.
import { recordSource } from './usage.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getRoot } from './db.js';
import { provision } from './components.js';
import { assertProjectAllowed } from './guard.js';
import { rememberOrigin } from './confs.js';
import { startJob } from './jobs.js';
import { scanPath } from './scanner.js';
import { fullHashFile, freeSpace, safeFileName } from './util.js';

const HF = 'https://huggingface.co';
const UA = { 'User-Agent': 'PAIZ-WeightStream' };
const ID_RE = /^[\w.-]+\/[\w.-]+$/;

// Un fichier de même nom ET de même taille est déjà au catalogue : on ne le re-télécharge pas, on le relie (lien dur ou symbolique) à l'endroit voulu.
function findSameFile(db, name, size) {
  if (!(size > 0)) return null;
  for (const r of db.prepare("SELECT abs_path FROM assets WHERE state = 'present' AND file_name = ? COLLATE NOCASE AND size_bytes = ?").all(name, size)) {
    try { if (fs.statSync(r.abs_path).size === size) return r.abs_path; } catch { /* disparu depuis le dernier scan */ }
  }
  return null;
}

export async function searchModels({ q = '', sort = 'downloads', gguf = true, limit = 30, task = '' }) {
  const sortKey = { downloads: 'downloads', likes: 'likes', recent: 'lastModified', trending: 'trendingScore' }[sort] || 'downloads';
  const p = new URLSearchParams({ sort: sortKey, direction: '-1', limit: String(Math.min(Math.max(Number(limit) || 30, 1), 100)) });
  if (q) p.set('search', String(q).slice(0, 200));
  if (gguf) p.set('filter', 'gguf');
  if (task) p.set('pipeline_tag', String(task).slice(0, 60));
  const r = await fetch(`${HF}/api/models?${p}`, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Hugging Face : HTTP ${r.status}`);
  const rows = await r.json();
  return rows.map((m) => ({
    id: m.id, downloads: m.downloads ?? 0, likes: m.likes ?? 0, updated: m.lastModified || null, gated: !!m.gated,
    tags: (m.tags || []).filter((t) => !/^(region:|endpoints_|base_model:|license:)/.test(t)).slice(0, 8),
  }));
}

// fourchette de poids des fichiers GGUF d'un dépôt (plus petite et plus grosse quantification), gardée 15 min
const sizeCache = new Map();
export async function modelSizeRange(id) {
  const c = sizeCache.get(id); if (c && Date.now() - c.at < 900000) return c.v;
  const files = (await modelFiles(id)).filter((f) => !/mmproj/i.test(f.name) && f.size > 50 * 1048576); // ni un mmproj ni un fichier minuscule (tête de brouillon, etc.) : pas le modèle
  const v = files.length ? { min: files[0].size, max: files.at(-1).size, n: files.length } : { min: 0, max: 0, n: 0 };
  sizeCache.set(id, { at: Date.now(), v }); return v;
}

// architecture déclarée dans les métadonnées GGUF du dépôt (ex. qwen3moe) : sert à savoir si c'est un MoE (streaming d'experts possible)
export async function repoArch(id) {
  if (!ID_RE.test(id)) return '';
  try {
    const r = await fetch(`${HF}/api/models/${id}?expand%5B%5D=gguf`, { headers: UA, signal: AbortSignal.timeout(15000) });
    return r.ok ? ((await r.json()).gguf?.architecture || '') : '';
  } catch { return ''; }
}

const QUANT = /(IQ\d_[A-Z0-9_]+|Q\d(?:_[A-Z0-9]+)+|MXFP4(?:_MOE)?|BF16|F16|F32|Q\d)/i;
const PART = /-(\d{5})-of-(\d{5})\.gguf$/i;

export async function modelFiles(id) {
  if (!ID_RE.test(id)) throw new Error('Identifiant de modèle invalide.');
  const r = await fetch(`${HF}/api/models/${id}/tree/main?recursive=true`, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (r.status === 401 || r.status === 403) throw new Error('Modèle à accès restreint (compte Hugging Face requis).');
  if (!r.ok) throw new Error(`Hugging Face : HTTP ${r.status}`);
  const tree = await r.json();
  // un modèle « en plusieurs parties » (…-00001-of-00008.gguf) devient UNE entrée : taille totale, toutes les parties à télécharger
  const groups = new Map();
  for (const f of tree) {
    if (f.type !== 'file' || !/\.gguf$/i.test(f.path)) continue;
    const part = { path: f.path, size: f.lfs?.size ?? f.size ?? 0, sha256: f.lfs?.oid || null };
    const key = f.path.replace(PART, '.gguf');
    const g = groups.get(key) || { name: key, quant: (path.basename(f.path).match(QUANT) || [''])[0].toUpperCase(), size: 0, parts: [] };
    g.parts.push(part);
    g.size += part.size;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, parts: g.parts.sort((a, b) => a.path.localeCompare(b.path)) })).sort((a, b) => a.size - b.size);
}

// Télécharge un modèle (un ou plusieurs fichiers GGUF), reprise possible via .part ; vérifie taille + SHA-256 publié par Hugging Face de CHAQUE fichier
// avant de le renommer, puis l'inscrit au catalogue. La place du disque cible est contrôlée pour le TOTAL avant le moindre octet.
export function startDownload(db, { id, files, toRoot, toDir, folder }) {
  if (!ID_RE.test(id || '')) throw new Error('Modèle invalide.');
  if (!Array.isArray(files) || !files.length || files.some((f) => !/\.gguf$/i.test(f.path || ''))) throw new Error('Fichiers invalides.');
  let root = null; let base;
  if (toDir) { // projet actif ou dossier au choix : jamais la racine d'un disque, le dossier personnel ni un dossier protégé (mêmes règles que les projets)
    base = path.resolve(String(toDir));
    assertProjectAllowed(db, base);
  } else {
    root = getRoot(db, toRoot);
    if (!root) throw new Error('Racine de destination inconnue.');
    base = root.path;
  }
  const where = root ? root.name : base;
  const sub = String(folder || '').replace(/[:*?"<>|\\/]/g, '_').replace(/^\.+$/, ''); // pas de « .. » : le sous-dossier reste dans la destination
  const dir = path.join(base, sub);
  const total = files.reduce((s, f) => s + (Number(f.size) || 0), 0);
  const label = path.basename(files[0].path).replace(PART, '.gguf');
  return startJob('download', `Téléchargement de ${label}${files.length > 1 ? ` (${files.length} parties)` : ''} → ${where}`, { id, toRoot: root?.id ?? null, toDir: root ? null : base }, async (job) => {
    await fsp.mkdir(dir, { recursive: true });
    const todo = files.map((f) => ({ ...f, name: safeFileName(path.basename(f.path)), size: Number(f.size) || 0 }));
    for (const f of todo) {
      f.dest = path.join(dir, f.name);
      f.part = `${f.dest}.part`;
      if (fs.existsSync(f.dest)) throw new Error(`Le fichier existe déjà : ${f.dest}`);
      const same = findSameFile(db, f.name, f.size);
      if (same) { try { provision(db, same, f.dest); f.reused = same; f.have = f.size; } catch { /* lien impossible : on télécharge normalement */ } }
      if (!f.reused) f.have = fs.existsSync(f.part) ? (await fsp.stat(f.part)).size : 0;
    }
    const remaining = todo.reduce((s, f) => s + (f.size - f.have), 0);
    const space = await freeSpace(dir);
    const margin = Math.max(256 * 1024 * 1024, total * 0.01);
    if (space && space.free < remaining + margin) {
      throw Object.assign(new Error(`Pas assez de place sur « ${where} » : ${(space.free / 1e9).toFixed(1)} Go libres, ${((remaining + margin) / 1e9).toFixed(1)} Go nécessaires. Rien n'a été téléchargé : fais de la place ou choisis une autre destination.`), { code: 'NO_SPACE' });
    }
    job.progress.totalBytes = total;
    let done = todo.reduce((s, f) => s + f.have, 0);
    job.progress.bytes = done;
    job.progress.total = todo.length;
    for (const f of todo) {
      if (f.reused) { job.progress.done++; continue; } // déjà au catalogue : relié, pas re-téléchargé
      job.progress.phase = 'download';
      job.progress.current = f.name;
      const url = `${HF}/${id}/resolve/main/${f.path.split('/').map(encodeURIComponent).join('/')}`;
      const res = await fetch(url, { headers: { ...UA, ...(f.have ? { Range: `bytes=${f.have}-` } : {}) }, redirect: 'follow' });
      if (res.status === 416 && f.have) { // « plage non satisfaisable » : si le partiel a déjà la taille complète annoncée, il est fini
        const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
        if (m && Number(m[1]) === f.have) { f.expected = f.have; await res.body?.cancel?.().catch(() => {}); } else throw new Error('Téléchargement refusé : HTTP 416');
      } else if (!(res.status === 200 || res.status === 206)) throw new Error(`Téléchargement refusé : HTTP ${res.status}`);
      if (res.status === 200 && f.have) { done -= f.have; f.have = 0; } // le serveur ne reprend pas : on repart de zéro pour ce fichier
      if (res.status !== 416) { // taille attendue = celle annoncée par le serveur (celle de l'appelant peut être approximative)
        const len = Number(res.headers.get('content-length')) || 0;
        if (len) f.expected = res.status === 206 ? f.have + len : len;
      }
      const ws = fs.createWriteStream(f.part, { flags: res.status === 206 ? 'a' : 'w' });
      const src = res.status === 416 ? Readable.from([]) : Readable.fromWeb(res.body);
      src.on('data', (c) => {
        done += c.length;
        job.progress.bytes = done;
        if (job.cancelled) src.destroy(Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }));
      });
      await pipeline(src, ws); // annulation ou erreur : les .part sont gardés pour reprendre
      const st = await fsp.stat(f.part);
      const want = f.expected || f.size;
      if (want && st.size !== want) throw new Error(`Taille inattendue pour ${f.name} (${st.size} au lieu de ${want}) : partiel gardé pour reprise.`);
      if (f.sha256) {
        job.progress.phase = 'verify';
        const base = job.progress.bytes;
        const h = await fullHashFile(f.part, (pos) => { job.progress.current = `Vérification de ${f.name} (${Math.round(100 * pos / st.size)} %)`; });
        job.progress.bytes = base;
        if (h !== f.sha256) {
          await fsp.rm(f.part, { force: true });
          throw new Error(`SHA-256 de ${f.name} différent de celui publié par Hugging Face : fichier supprimé, relance le téléchargement.`);
        }
      }
      await fsp.rename(f.part, f.dest);
      job.progress.done++;
    }
    if (root) await scanPath(db, { dir, rootId: root.id, maxDepth: 1 }).catch(() => {}); // hors écurie : pas inscrit au catalogue
    for (const f of todo) recordSource(db, f.dest, { repo: id }); // origine + date, pour le suivi des modèles
    rememberOrigin(db, id, todo.map((f) => f.name)); // pour pouvoir le re-télécharger depuis une configuration sauvegardée
    return { dir, files: todo.map((f) => f.dest), reused: todo.filter((f) => f.reused).map((f) => ({ file: f.dest, from: f.reused })), bytes: total, verified: todo.every((f) => !!f.sha256) };
  });
}
