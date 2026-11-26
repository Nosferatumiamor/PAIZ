// Long-running operations: scan, copy, move, link, trash, restore.
// Jobs live in memory so the web UI can follow their progress.
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getAsset, getRoot, logEvent, upsertAsset, getSetting } from './db.js';
import { noteMove } from './origins.js';
import { traceAfterMove } from './ecurie.js';
import { scanPath } from './scanner.js';
import { listScanTargets } from './volumes.js';
import {
  DEEP_SCAN_MAX_DEPTH, DEEP_SCAN_MIN_BYTES, DEEP_SCAN_PACE_MS,
  humanBytes, normalizeDir, nowIso, quickHashFile, safeFileName, volumeOf, freeSpace, pathExists, fullHashFile,
} from './util.js';

export const jobs = new Map();
const MAX_JOBS = 80;

const CATEGORY_FOLDERS = {
  checkpoint: 'checkpoints',
  lora: 'loras',
  controlnet: 'controlnet',
  vae: 'vae',
  embedding: 'embeddings',
  upscaler: 'upscalers',
  clip: 'clip',
  ipadapter: 'ipadapters',
  faceid: 'faceid',
  motion: 'motion',
  llm: 'llm',
  onnx: 'onnx',
  other: 'autres',
};

function trimJobs() {
  if (jobs.size <= MAX_JOBS) return;
  const finished = [...jobs.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  while (jobs.size > MAX_JOBS && finished.length) jobs.delete(finished.shift().id);
}

export function getJob(id) {
  return jobs.get(String(id)) || null;
}

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function cancelJob(id) {
  const job = getJob(id);
  if (job && job.status === 'running') {
    job.cancelled = true;
    job.progress.phase = 'cancel';
    return true;
  }
  return false;
}

export function startJob(type, label, meta, fn) {
  const job = {
    id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    type,
    label,
    status: 'running',
    cancelled: false,
    startedAt: nowIso(),
    endedAt: null,
    progress: { phase: 'start', done: 0, total: 0, bytes: 0, totalBytes: 0, current: null },
    meta: meta || {},
    result: null,
    error: null,
  };
  jobs.set(job.id, job);
  trimJobs();
  (async () => {
    try {
      job.result = await fn(job) ?? null;
      job.status = job.cancelled ? 'cancelled' : 'done';
    } catch (err) {
      if (job.cancelled || err?.code === 'CANCELLED') {
        job.status = 'cancelled';
        job.error = 'Opération annulée';
      } else {
        job.status = 'error';
        job.error = err?.message || String(err);
      }
    } finally {
      job.endedAt = nowIso();
      job.progress.current = null;
    }
  })();
  return job;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export function startScanJob(db, { dir, rootId = null, maxDepth = 16, minBytes = null, force = false, label = null } = {}) {
  const target = normalizeDir(dir);
  return startJob('scan', label || `Scan de ${target}`, { dir: target, rootId }, async (job) => {
    const res = await scanPath(db, {
      dir: target,
      rootId,
      maxDepth,
      minBytes,
      force,
      cancelSignal: () => job.cancelled,
      onProgress: (p) => {
        job.progress.phase = p.phase;
        job.progress.total = p.found || 0;
        job.progress.done = p.processed || 0;
        job.progress.current = p.current || null;
      },
    });
    logEvent(db, 'scan', null, { path: target, ...res, errors: undefined });
    return res;
  });
}

/**
 * Gentle whole-machine discovery: local volumes + known model caches, sequential,
 * low file concurrency, 1 MiB minimum, system folders skipped. Files inside an
 * existing root stay attached to that root; the rest become "unmanaged".
 */
export function startScanAllJob(db, {
  includeRemovable = true,
  includeCaches = true,
  minBytes = DEEP_SCAN_MIN_BYTES,
  maxDepth = DEEP_SCAN_MAX_DEPTH,
  paceMs = DEEP_SCAN_PACE_MS,
  force = false,
  only = null, // liste de disques / dossiers à scanner (ex. ['C:\', 'F:\']) ; null = tous
} = {}) {
  return startJob('scan-all', only ? 'Scan des disques choisis' : 'Scan de tous les disques', { includeRemovable, includeCaches, minBytes, maxDepth, paceMs, only }, async (job) => {
    const startedAt = Date.now();
    const norm = (p) => String(p).replace(/[\/]+$/, '').toLowerCase();
    const wanted = Array.isArray(only) ? new Set(only.map(norm)) : null;
    const targets = (await listScanTargets({ includeRemovable, includeCaches })).filter((t) => !wanted || wanted.has(norm(t.path)));
    if (!targets.length) throw new Error(wanted ? 'Aucun des disques choisis n’est disponible.' : 'Aucun disque local détecté.');

    job.meta.targets = targets.map((t) => t.path);
    job.progress.volumeCount = targets.length;
    const aggregate = {
      added: 0, updated: 0, unchanged: 0, skipped: 0,
      found: 0, total: 0, bytes: 0, dirs: 0, seenFiles: 0,
      errors: [],
    };
    const volumes = [];

    for (let i = 0; i < targets.length; i++) {
      if (job.cancelled) break;
      const target = targets[i];
      job.progress.phase = 'discover';
      job.progress.volume = target.path;
      job.progress.volumeKind = target.kind;
      job.progress.volumeIndex = i + 1;
      job.progress.volumeCount = targets.length;
      job.progress.done = 0;
      job.progress.total = 0;
      job.progress.current = target.path;
      job.progress.dirs = 0;
      job.progress.seenFiles = 0;

      let res;
      try {
        res = await scanPath(db, {
          dir: target.path,
          perFileRoot: true,
          deep: true,
          force,
          minBytes,
          maxDepth,
          paceMs,
          fileConcurrency: 2,
          cancelSignal: () => job.cancelled,
          onProgress: (p) => {
            job.progress.phase = p.phase === 'walk' ? 'discover' : 'scan';
            job.progress.total = p.found || 0;
            job.progress.done = p.processed || 0;
            job.progress.current = p.current || target.path;
            if (p.dirs != null) job.progress.dirs = p.dirs;
            if (p.seen != null) job.progress.seenFiles = p.seen;
          },
        });
      } catch (err) {
        res = {
          added: 0, updated: 0, unchanged: 0, skipped: 0,
          found: 0, total: 0, bytes: 0, dirs: 0, seenFiles: 0,
          errors: [{ path: target.path, error: err.message }],
          cancelled: job.cancelled,
          durationMs: 0,
        };
      }

      for (const key of ['added', 'updated', 'unchanged', 'skipped', 'found', 'total', 'bytes', 'dirs', 'seenFiles']) {
        aggregate[key] += res[key] || 0;
      }
      if (res.errors?.length) aggregate.errors.push(...res.errors);
      volumes.push({
        path: target.path,
        kind: target.kind,
        added: res.added,
        updated: res.updated,
        unchanged: res.unchanged,
        skipped: res.skipped,
        found: res.found,
        total: res.total,
        bytes: res.bytes,
        dirs: res.dirs,
        seenFiles: res.seenFiles,
        errors: res.errors?.length || 0,
        cancelled: Boolean(res.cancelled),
        durationMs: res.durationMs,
      });
      if (job.cancelled) break;
    }

    aggregate.errors = aggregate.errors.slice(0, 200);
    const result = {
      ...aggregate,
      volumes,
      cancelled: job.cancelled,
      durationMs: Date.now() - startedAt,
      minBytes,
      maxDepth,
    };
    logEvent(db, 'scan-all', null, { ...result, errors: undefined, volumes: volumes.length });
    return result;
  });
}

// ---------------------------------------------------------------------------
// Transfer helpers
// ---------------------------------------------------------------------------

function meansMove(mode) { return mode !== 'copy'; }

function uniqueDestination(dest) {
  if (!existsSync(dest)) return dest;
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const base = path.basename(dest, ext);
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Impossible de trouver un nom libre pour ${dest}`);
}

function planDestination(asset, destRoot, organize = false, folder = null) {
  let rel;
  if (folder) {
    rel = path.join(String(folder).replace(/[:*?"<>|]/g, '_'), asset.file_name); // dossier dédié choisi par l'appelant
  } else if (asset.rel_path && asset.root_id && !organize) {
    rel = asset.rel_path;
  } else {
    rel = path.join(CATEGORY_FOLDERS[asset.category] || 'autres', asset.file_name);
  }
  const dest = path.join(destRoot.path, rel);
  if (dest.toLowerCase() === asset.abs_path.toLowerCase()) {
    throw new Error('La source et la destination sont identiques.');
  }
  return { dest, rel };
}

async function copyWithProgress(src, dest, job, size) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  // gros blocs (16 Mio) : avec les 64 Kio par défaut de Node, un disque dur externe écrit 2 à 3 fois moins vite (mesuré sur F: : 12 contre 27 Mo/s)
  const BLOCK = 16 * 1024 * 1024;
  const rs = createReadStream(src, { highWaterMark: BLOCK });
  const ws = createWriteStream(dest, { flags: 'wx', highWaterMark: BLOCK });
  let copied = 0;
  const srcHash = createHash('sha256');
  rs.on('data', (chunk) => {
    srcHash.update(chunk);
    copied += chunk.length;
    job.progress.bytes = copied;
    job.progress.totalBytes = size;
    if (job.cancelled) rs.destroy(new Error('CANCELLED'));
  });
  try {
    await pipeline(rs, ws);
  } catch (err) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw err;
  }
  job.srcSha = srcHash.digest('hex'); // empreinte complète de ce qui a été LU à la source (gratuite : calculée pendant la copie)
  const st = await fsp.stat(src);
  await fsp.utimes(dest, new Date(), st.mtime).catch(() => {});
  return copied;
}

// Compare des morceaux de la source et de la copie aux mêmes positions (répartis sur tout le fichier). Vrai si tous identiques.
async function sampleEqual(src, dst, size, job, n = 64, chunk = 1024 * 1024) {
  const a = await fsp.open(src, 'r'); const b = await fsp.open(dst, 'r');
  try {
    const ba = Buffer.alloc(chunk); const bb = Buffer.alloc(chunk);
    const span = Math.max(0, size - chunk);
    for (let i = 0; i < n; i++) {
      if (job.cancelled) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
      const pos = n === 1 ? 0 : Math.floor((span * i) / (n - 1));
      const [ra, rb] = await Promise.all([a.read(ba, 0, chunk, pos), b.read(bb, 0, chunk, pos)]);
      if (ra.bytesRead !== rb.bytesRead || !ba.subarray(0, ra.bytesRead).equals(bb.subarray(0, rb.bytesRead))) return false;
      job.progress.bytes = Math.round((size * (i + 1)) / n);
    }
    return true;
  } finally { await a.close(); await b.close(); }
}

const spaceMargin = (bytes) => Math.max(256 * 1024 * 1024, Math.round(bytes * 0.01));

// Contrôle PRÉALABLE (avant de créer la tâche) : le disque cible a-t-il la place ? Un déplacement sur le même disque est un simple renommage (0 octet requis).
export async function checkTransferSpace(db, assetIds, toRoot) {
  const dest = getRoot(db, toRoot);
  if (!dest) throw new Error(`Racine inconnue: ${toRoot}`);
  const vol = volumeOf(dest.path).toLowerCase();
  let needed = 0;
  for (const id of [].concat(assetIds)) {
    const a = getAsset(db, id);
    if (!a || a.root_id === dest.id) continue;
    if (volumeOf(a.abs_path).toLowerCase() !== vol) needed += a.size_bytes;
  }
  if (!needed) return { ok: true, needed: 0, free: null };
  const space = await freeSpace(dest.path);
  const required = needed + spaceMargin(needed);
  if (space && space.free < required) {
    return { ok: false, needed: required, free: space.free, root: dest.name, volume: vol.toUpperCase(),
      message: `Pas assez de place sur « ${dest.name} » (${vol.toUpperCase()}) : ${humanBytes(space.free)} libres, ${humanBytes(required)} nécessaires (marge incluse). Libère de la place ou choisis un autre emplacement : rien n'a été déplacé.` };
  }
  return { ok: true, needed: required, free: space?.free ?? null };
}
export async function assertTransferSpace(db, assetIds, toRoot) {
  const r = await checkTransferSpace(db, assetIds, toRoot);
  if (!r.ok) throw Object.assign(new Error(r.message), { code: 'NO_SPACE', details: r });
  return r;
}

async function transferOne(db, job, assetId, destRoot, mode, opts = {}) {
  const asset = getAsset(db, assetId);
  if (!asset) throw new Error(`Modèle #${assetId} introuvable dans l'index.`);
  if (!(await pathExists(asset.abs_path))) {
    db.prepare("UPDATE assets SET state = 'missing' WHERE id = ?").run(asset.id);
    throw new Error(`Fichier absent du disque: ${asset.abs_path}`);
  }
  if (destRoot.id === asset.root_id) throw new Error('Le modèle est déjà dans cette racine.');

  const srcRoot = asset.root_id ? getRoot(db, asset.root_id) : null;
  // exactDest : retour à l'adresse précise d'où le modèle était parti (doit rester dans le repo cible)
  const { dest: planned, rel } = opts.exactDest ? { dest: path.resolve(opts.exactDest), rel: path.relative(destRoot.path, path.resolve(opts.exactDest)) } : planDestination(asset, destRoot, opts.organize === true, opts.folder || null);
  if (opts.exactDest && planned.toLowerCase() === asset.abs_path.toLowerCase()) throw new Error('La source et la destination sont identiques.');
  const dest = uniqueDestination(planned);
  // If the index still knows a row for this destination but no file exists there,
  // drop it so the UNIQUE(abs_path) constraint cannot fire after the transfer.
  db.prepare('DELETE FROM assets WHERE abs_path = ? COLLATE NOCASE AND id <> ?').run(dest, asset.id);

  const volumeSrc = volumeOf(asset.abs_path);
  const volumeDst = volumeOf(destRoot.path);
  const sameVolume = volumeSrc.toLowerCase() === volumeDst.toLowerCase();

  if (meansMove(mode) && sameVolume) {
    // Instant rename: no copy, no extra space needed.
    job.progress.phase = 'move';
    job.progress.current = asset.file_name;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(asset.abs_path, dest);
    const newRel = path.relative(destRoot.path, dest);
    db.prepare('UPDATE assets SET abs_path = ?, rel_path = ?, root_id = ?, managed = 1, state = \'present\', last_seen_at = ? WHERE id = ?')
      .run(dest, newRel, destRoot.id, nowIso(), asset.id);
    logEvent(db, 'move', asset.id, { from: asset.abs_path, to: dest, mode: 'rename' });
    noteMove(db, asset, srcRoot, destRoot);
    return { assetId: asset.id, path: dest, rootId: destRoot.id, mode: 'move', bytes: asset.size_bytes };
  }

  const space = await freeSpace(destRoot.path);
  if (space && space.free < asset.size_bytes + spaceMargin(asset.size_bytes)) {
    throw Object.assign(new Error(`Espace insuffisant sur ${volumeDst} : ${humanBytes(space.free)} libres, ${humanBytes(asset.size_bytes + spaceMargin(asset.size_bytes))} nécessaires (marge incluse). Rien n'a été déplacé.`), { code: 'NO_SPACE' });
  }

  job.progress.phase = meansMove(mode) ? 'move' : 'copy';
  job.progress.current = asset.file_name;
  const copied = await copyWithProgress(asset.abs_path, dest, job, asset.size_bytes);

  // Vérification AVANT toute suppression : taille exacte + SHA-256 complet relu sur la DESTINATION (le fichier est relu depuis le disque cible),
  // comparé à l'empreinte de ce qui a été lu à la source. Au moindre écart : la copie est effacée et la source reste intacte.
  job.progress.phase = 'verify';
  job.progress.bytes = 0;
  job.progress.current = `Vérification de ${asset.file_name}`;
  const dstStat = await fsp.stat(dest);
  // Vérification. Par défaut « échantillons » : 64 morceaux de 1 Mio répartis sur tout le fichier (début et fin compris), relus sur la copie
  // et comparés octet par octet à la source : quelques secondes au lieu de relire tout le fichier (des dizaines de minutes sur un disque lent).
  // L'écriture elle-même est déjà contrôlée par le système ; réglage transfer.verify = 'full' pour relire et hacher toute la copie.
  const full = getSetting(db, 'transfer.verify', 'sample') === 'full';
  const fail = async (e) => { await fsp.rm(dest, { force: true }).catch(() => {}); throw e; };
  let destSha = null;
  if (dstStat.size === copied) {
    if (full) destSha = await fullHashFile(dest, (pos) => { job.progress.bytes = pos; if (job.cancelled) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }); }).catch(fail);
    else destSha = (await sampleEqual(asset.abs_path, dest, copied, job).catch(fail)) ? job.srcSha : null;
  }
  if (destSha === null || destSha !== job.srcSha || copied !== asset.size_bytes) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw new Error('Vérification échouée : le fichier copié ne correspond pas à la source (taille ou SHA-256). La copie a été effacée, la source est intacte.');
  }
  const check = await quickHashFile(dest, copied);

  if (meansMove(mode)) {
    await fsp.unlink(asset.abs_path);
    const newRel = path.relative(destRoot.path, dest);
    db.prepare('UPDATE assets SET abs_path = ?, rel_path = ?, root_id = ?, managed = 1, state = \'present\', last_seen_at = ?, sha256 = ? WHERE id = ?')
      .run(dest, newRel, destRoot.id, nowIso(), destSha, asset.id);
    logEvent(db, 'move', asset.id, { from: asset.abs_path, to: dest, mode: 'copy+delete' });
    noteMove(db, asset, srcRoot, destRoot);
    return { assetId: asset.id, path: dest, rootId: destRoot.id, mode: 'move', bytes: copied };
  }

  // Copy mode: register the new copy as its own asset.
  const newRel = path.relative(destRoot.path, dest);
  const res = upsertAsset(db, {
    root_id: destRoot.id,
    abs_path: dest,
    rel_path: newRel,
    file_name: path.basename(dest),
    ext: path.extname(dest).toLowerCase(),
    category: asset.category,
    base_model: asset.base_model,
    base_family: asset.base_family,
    title: asset.title,
    version: asset.version,
    format: asset.format,
    size_bytes: copied,
    mtime: (await fsp.stat(dest)).mtime.toISOString(),
    quick_hash: check,
    sha256: destSha,
    meta: asset.meta_json ? safeJson(asset.meta_json) : null,
    tags: asset.tags_json ? safeJson(asset.tags_json) : null,
  });
  logEvent(db, 'copy', res.id, { from: asset.abs_path, to: dest });
  return { assetId: res.id, sourceAssetId: asset.id, path: dest, rootId: destRoot.id, mode: 'copy', bytes: copied };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export function startTransferJob(db, { assetId, toRoot, mode = 'move', organize = false, folder = null } = {}) {
  const destRoot = getRoot(db, toRoot);
  if (!destRoot) throw new Error(`Racine inconnue: ${toRoot}`);
  const asset = getAsset(db, assetId);
  const label = `${mode === 'copy' ? 'Copie' : 'Déplacement'} de ${asset?.file_name || `#${assetId}`} → ${destRoot.name}`;
  return startJob('transfer', label, { assetId, toRoot: destRoot.id, mode, toRole: destRoot.role }, async (job) => {
    const res = await transferOne(db, job, assetId, destRoot, mode, { organize, folder });
    return res;
  });
}

export function startBulkMoveJob(db, { assetIds = [], toRoot, mode = 'move' } = {}) {
  const destRoot = getRoot(db, toRoot);
  if (!destRoot) throw new Error(`Racine inconnue: ${toRoot}`);
  return startJob('bulk-transfer', `Déplacement de ${assetIds.length} modèle(s) → ${destRoot.name}`, { assetIds, toRoot: destRoot.id, mode, toRole: destRoot.role }, async (job) => {
    const done = [];
    const failed = [];
    job.progress.total = assetIds.length;
    job.progress.totalBytes = assetIds.reduce((sum, id) => sum + (getAsset(db, id)?.size_bytes || 0), 0);
    for (const id of assetIds) {
      if (job.cancelled) break;
      job.progress.phase = 'move';
      job.progress.current = getAsset(db, id)?.file_name || `#${id}`;
      try {
        done.push(await transferOne(db, job, id, destRoot, mode));
      } catch (err) {
        failed.push({ assetId: id, error: err.message });
      }
      job.progress.done++;
    }
    return { moved: done.length, failed, done };
  });
}

// Déplacements précis (chacun vers son repo, éventuellement à son adresse exacte d'origine), enchaînés dans une seule tâche.
export function startPlacementJob(db, { moves = [], label = 'Déplacement' } = {}) {
  const roles = new Set(moves.map((m) => getRoot(db, m.toRoot ?? m.toRootId)?.role).filter(Boolean));
  return startJob('bulk-transfer', label, { moves, toRole: roles.size === 1 ? [...roles][0] : null }, async (job) => {
    const done = []; const failed = [];
    job.progress.total = moves.length;
    job.progress.totalBytes = moves.reduce((sum, m) => sum + (getAsset(db, m.assetId)?.size_bytes || 0), 0);
    for (const m of moves) {
      if (job.cancelled) break;
      const destRoot = getRoot(db, m.toRoot);
      job.progress.phase = 'move';
      job.progress.current = getAsset(db, m.assetId)?.file_name || `#${m.assetId}`;
      try { done.push(await transferOne(db, job, m.assetId, destRoot, 'move', { exactDest: m.exactDest || null })); } catch (err) { failed.push({ assetId: m.assetId, error: err.message }); }
      job.progress.done++;
    }
    try { traceAfterMove(db, [...done.map((d) => d.rootId), ...moves.map((m) => m.toRoot)]); } catch { /* la trace ne doit jamais faire échouer un déplacement */ }
    if (failed.length && !done.length) throw new Error(failed.map((f) => f.error).join(' | '));
    return { moved: done.length, failed, done };
  });
}

// ---------------------------------------------------------------------------
// Link (symlink / hardlink) — lets another app find the model in place
// ---------------------------------------------------------------------------

export function startLinkJob(db, { assetId, linkPath, kind = 'symlink' } = {}) {
  const asset = getAsset(db, assetId);
  if (!asset) throw new Error(`Modèle #${assetId} introuvable.`);
  if (!linkPath) throw new Error('Chemin du lien manquant.');
  const target = path.resolve(linkPath);
  return startJob('link', `Lien ${kind} → ${path.basename(target)}`, { assetId, linkPath: target, kind }, async () => {
    const exists = await pathExists(target);
    if (exists) {
      const st = await fsp.lstat(target);
      if (!st.isSymbolicLink()) throw new Error(`Le chemin existe déjà: ${target}`);
      await fsp.unlink(target);
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });

    const sameVolume = volumeOf(asset.abs_path).toLowerCase() === volumeOf(target).toLowerCase();
    if (kind === 'hardlink' && !sameVolume) {
      throw new Error('Un lien physique (hardlink) n\'est possible que sur le même disque. Utilise un lien symbolique.');
    }

    try {
      if (kind === 'hardlink') {
        await fsp.link(asset.abs_path, target);
      } else {
        await fsp.symlink(asset.abs_path, target, 'file');
      }
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        throw new Error('Windows refuse la création du lien symbolique. Active le "Mode développeur" (Paramètres > Système > Pour les développeurs) ou lance le terminal en administrateur.');
      }
      throw err;
    }
    db.prepare('INSERT INTO links (asset_id, path, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(asset.id, target, kind, nowIso());
    logEvent(db, 'link', asset.id, { path: target, kind });
    return { assetId: asset.id, path: target, kind };
  });
}

// ---------------------------------------------------------------------------
// Trash / restore (never hard-delete from the UI)
// ---------------------------------------------------------------------------

// Corbeille WINDOWS : le fichier part dans la corbeille de l'explorateur (restaurable par Windows ; pour l'effacer vraiment, on vide la
// corbeille Windows). Garde-fous : disques fixes seulement (les clés USB, disques amovibles et réseaux n'ont pas de corbeille, Windows y
// effacerait pour de bon : ils gardent le dossier .mdisp-trash) ; et sans AUCUNE option « sans confirmation » : si le fichier est trop gros
// pour la corbeille du disque, Windows demande lui-même « supprimer définitivement ? » et un refus annule tout.
export function recycleToWindowsBin(absPath) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve({ ok: false, nobin: true, reason: 'pas Windows' }); return; }
    if (process.env.PAIZ_TRASH === 'folder') { resolve({ ok: false, nobin: true, reason: 'forcé : dossier .mdisp-trash' }); return; } // tests : ne pas remplir la vraie corbeille
    const esc = (v) => String(v).replace(/'/g, "''");
    const script = `$ErrorActionPreference='Stop'; $p='${esc(absPath)}';
      try { if ([System.IO.DriveInfo]::new($p.Substring(0,1)).DriveType -ne 'Fixed') { 'NOBIN'; exit 0 } } catch { 'NOBIN'; exit 0 }
      Add-Type -AssemblyName Microsoft.VisualBasic;
      try { if ((Get-Item -LiteralPath $p -Force).PSIsContainer) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'AllDialogs', 'SendToRecycleBin', 'ThrowException') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'AllDialogs', 'SendToRecycleBin', 'ThrowException') }; if (Test-Path -LiteralPath $p) { 'FAILED' } else { 'OK' } } catch [System.OperationCanceledException] { 'CANCELLED' } catch { 'ERR ' + $_.Exception.Message }`;
    const ps = spawn('powershell', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (b) => { out += String(b); });
    const t = setTimeout(() => { try { ps.kill(); } catch { /* fini */ } resolve({ ok: false, reason: 'délai dépassé' }); }, 15 * 60 * 1000);
    ps.on('close', () => {
      clearTimeout(t);
      const r = out.trim().split(/\r?\n/).pop() || '';
      if (r === 'OK') resolve({ ok: true });
      else if (r === 'NOBIN') resolve({ ok: false, nobin: true, reason: 'disque sans corbeille Windows' });
      else if (r === 'CANCELLED') resolve({ ok: false, cancelled: true, reason: 'annulé dans Windows' });
      else resolve({ ok: false, reason: r || 'échec' });
    });
  });
}

// permanent = true : effacement direct (comme Maj+Suppr), sans corbeille, irréversible. Sinon corbeille Windows (disques fixes seulement : une clé USB,
// un disque amovible ou réseau n'a pas de corbeille, on refuse plutôt que de créer un dossier .mdisp-trash).
export function startTrashJob(db, { assetIds = [], permanent = false, keepLast = false } = {}) {
  if (!assetIds.length) throw new Error('Aucun modèle sélectionné.');
  const spared = [];
  if (keepLast) {
    // écran Doublons : si la sélection contient TOUTES les copies d'un fichier, la plus récente est épargnée
    const want = new Set(assetIds.map(Number)); const seen = new Set();
    for (const id of want) {
      const a = getAsset(db, id); if (!a?.quick_hash || seen.has(a.quick_hash)) continue; seen.add(a.quick_hash);
      const all = db.prepare("SELECT id, mtime FROM assets WHERE quick_hash = ? AND size_bytes = ? AND state = 'present' ORDER BY mtime DESC").all(a.quick_hash, a.size_bytes);
      if (all.length && all.every((x) => want.has(x.id))) { want.delete(all[0].id); spared.push(all[0].id); }
    }
    assetIds = [...want];
    if (!assetIds.length) throw new Error('Ce serait la dernière copie : PAIZ la garde.');
  }
  return startJob('trash', `${permanent ? 'Effacement' : 'Corbeille'}: ${assetIds.length} fichier(s)`, { assetIds, permanent }, async (job) => {
    const trashed = [];
    const failed = [];
    job.progress.total = assetIds.length;
    for (const id of assetIds) {
      if (job.cancelled) break;
      try {
        const asset = getAsset(db, id);
        if (!asset) throw new Error('introuvable');
        job.progress.current = asset.file_name;
        if (permanent) {
          await fsp.unlink(asset.abs_path);
          db.prepare("UPDATE assets SET state = 'missing', last_seen_at = ? WHERE id = ?").run(nowIso(), asset.id);
          logEvent(db, 'erase', asset.id, { from: asset.abs_path });
          trashed.push({ assetId: asset.id, path: 'effacé' });
          job.progress.done++;
          continue;
        }
        const rb = await recycleToWindowsBin(asset.abs_path);
        if (rb.ok) {
          db.prepare("UPDATE assets SET state = 'missing', last_seen_at = ? WHERE id = ?").run(nowIso(), asset.id);
          logEvent(db, 'trash', asset.id, { from: asset.abs_path, to: 'corbeille Windows' });
          trashed.push({ assetId: asset.id, path: 'corbeille Windows' });
          job.progress.done++;
          continue;
        }
        if (rb.cancelled) throw new Error('annulé (Windows a demandé confirmation)');
        if (!rb.nobin) throw new Error(`corbeille Windows impossible : ${rb.reason}`);
        if (process.env.PAIZ_TRASH !== 'folder') throw new Error('ce disque n\'a pas de corbeille Windows (USB, amovible ou réseau) : utilise « Effacer » pour le supprimer pour de bon');
        const baseDir = asset.root_path ? path.join(asset.root_path, '.mdisp-trash') : path.join(path.dirname(asset.abs_path), '.mdisp-trash');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = path.join(baseDir, `${stamp}__${safeFileName(asset.file_name)}`);
        await fsp.mkdir(baseDir, { recursive: true });
        job.progress.current = asset.file_name;
        try {
          await fsp.rename(asset.abs_path, target);
        } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          await copyWithProgress(asset.abs_path, target, job, asset.size_bytes);
          await fsp.unlink(asset.abs_path);
        }
        db.prepare("UPDATE assets SET state = 'trashed', trashed_from = ?, abs_path = ?, rel_path = NULL, last_seen_at = ? WHERE id = ?")
          .run(asset.abs_path, target, nowIso(), asset.id);
        logEvent(db, 'trash', asset.id, { from: asset.abs_path, to: target });
        trashed.push({ assetId: asset.id, path: target });
      } catch (err) {
        failed.push({ assetId: id, error: err.message });
      }
      job.progress.done++;
    }
    return { trashed: trashed.length, failed, items: trashed, spared };
  });
}

export function startRestoreJob(db, { assetIds = [] } = {}) {  if (!assetIds.length) throw new Error('Aucun modèle sélectionné.');
  return startJob('restore', `Restauration: ${assetIds.length} fichier(s)`, { assetIds }, async (job) => {
    const restored = [];
    const failed = [];
    job.progress.total = assetIds.length;
    for (const id of assetIds) {
      if (job.cancelled) break;
      try {
        const asset = getAsset(db, id);
        if (!asset || asset.state !== 'trashed' || !asset.trashed_from) throw new Error('pas dans la corbeille');
        await fsp.mkdir(path.dirname(asset.trashed_from), { recursive: true });
        job.progress.current = asset.file_name;
        const target = uniqueDestination(asset.trashed_from);
        try {
          await fsp.rename(asset.abs_path, target);
        } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          await copyWithProgress(asset.abs_path, target, job, asset.size_bytes);
          await fsp.unlink(asset.abs_path);
        }
        db.prepare("UPDATE assets SET state = 'present', abs_path = ?, trashed_from = NULL, last_seen_at = ? WHERE id = ?")
          .run(target, nowIso(), asset.id);
        logEvent(db, 'restore', asset.id, { to: target });
        restored.push({ assetId: asset.id, path: target });
      } catch (err) {
        failed.push({ assetId: id, error: err.message });
      }
      job.progress.done++;
    }
    return { restored: restored.length, failed, items: restored };
  });
}

// ---------------------------------------------------------------------------
// Full SHA-256 (slow, opt-in)
// ---------------------------------------------------------------------------

export function startHashJob(db, { assetIds = [], full = true } = {}) {
  if (!assetIds.length) throw new Error('Aucun mod�le s�lectionn�.');
  return startJob('hash', `Calcul d'empreinte: ${assetIds.length} fichier(s)`, { assetIds, full }, async (job) => {
    const done = [];
    const failed = [];
    job.progress.total = assetIds.length;
    for (const id of assetIds) {
      if (job.cancelled) break;
      try {
        const asset = getAsset(db, id);
        if (!asset) throw new Error('introuvable');
        job.progress.current = asset.file_name;
        job.progress.phase = 'hash';
        const hash = full ? await fullHashFile(asset.abs_path) : await quickHashFile(asset.abs_path, asset.size_bytes);
        db.prepare('UPDATE assets SET sha256 = ? WHERE id = ?').run(hash, asset.id);
        logEvent(db, 'hash', asset.id, { sha256: hash });
        done.push({ assetId: asset.id, hash });
      } catch (err) {
        failed.push({ assetId: id, error: err.message });
      }
      job.progress.done++;
    }
    return { hashed: done.length, failed, items: done };
  });
}
