// Disk walking + registration of model files.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { analyzeFile } from './detect.js';
import { findRootForPath, listRoots, markMissing, touchRootScan, upsertAsset } from './db.js';
import {
  DEEP_SKIPPED_DIRS, MODEL_EXTENSIONS, SKIPPED_DIRS, SKIPPED_FILES, MIN_MODEL_BYTES,
  isSubPath, mapPool, quickHashFile, volumeOf,
} from './util.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bestRootFor(absPath, roots) {
  let best = null;
  for (const root of roots) {
    if (isSubPath(root.path, absPath) && (!best || root.path.length > best.path.length)) best = root;
  }
  return best;
}

async function walk(dir, opts, state) {
  if (state.cancelled()) return;
  state.dirs++;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    state.errors.push({ path: dir, error: err.code || err.message });
    return;
  }
  state.seen += entries.length;
  const skippedDirs = opts.deep ? DEEP_SKIPPED_DIRS : SKIPPED_DIRS;
  if (opts.onProgress && (state.dirs === 1 || state.dirs % 25 === 0)) {
    opts.onProgress({ phase: 'walk', dirs: state.dirs, seen: state.seen, found: state.files.length, current: dir });
  }
  for (const ent of entries) {
    if (state.cancelled()) return;
    const abs = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      if (state.depth >= opts.maxDepth) continue;
      if (skippedDirs.has(ent.name.toLowerCase())) continue;
      state.depth++;
      await walk(abs, opts, state);
      state.depth--;
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!MODEL_EXTENSIONS.has(ext)) continue;
    if (SKIPPED_FILES.has(ent.name.toLowerCase())) continue;
    state.files.push({ abs, ext });
    if (state.files.length % 200 === 0 && opts.onProgress) {
      opts.onProgress({ phase: 'walk', dirs: state.dirs, seen: state.seen, found: state.files.length, current: abs });
    }
  }
  // Gentle mode: regularly give the event loop and the disks a breather.
  if (opts.paceMs && state.dirs % 20 === 0) await sleep(opts.paceMs);
}

/**
 * Scan a directory (or a single file) and register every model found.
 *
 * opts: { dir, rootId, maxDepth, minBytes, onProgress, cancelSignal }
 * Returns { added, updated, unchanged, found, errors, cancelled, rootId }
 */
export async function scanPath(db, opts = {}) {
  const startedAt = Date.now();
  const target = path.resolve(opts.dir);
  const st = await fsp.stat(target).catch(() => null);
  if (!st) throw new Error(`Chemin introuvable: ${target}`);

  let root = null;
  if (opts.rootId != null) {
    root = db.prepare('SELECT * FROM roots WHERE id = ?').get(Number(opts.rootId)) || null;
  } else {
    root = findRootForPath(db, target);
  }

  const state = {
    files: [],
    errors: [],
    depth: 0,
    dirs: 0,
    seen: 0,
    cancelled: () => {
      try { return Boolean(opts.cancelSignal?.()); } catch { return false; }
    },
  };
  const allRoots = opts.perFileRoot ? listRoots(db).filter((r) => r.enabled) : [];

  if (st.isFile()) {
    const ext = path.extname(target).toLowerCase();
    if (MODEL_EXTENSIONS.has(ext)) state.files.push({ abs: target, ext });
    if (root && !isSubPath(root.path, target)) root = null;
  } else {
    await walk(target, {
      maxDepth: opts.maxDepth ?? 16,
      deep: opts.deep === true,
      paceMs: Math.max(Number(opts.paceMs) || 0, 0),
      onProgress: opts.onProgress,
    }, state);
  }

  const minBytes = Number(opts.minBytes ?? MIN_MODEL_BYTES);
  const fileConcurrency = Math.max(1, Math.min(Number(opts.fileConcurrency) || 4, 8));
  const seenIds = [];
  const counts = { added: 0, updated: 0, unchanged: 0, skipped: 0, found: state.files.length, errors: state.errors.length, bytes: 0 };
  let totalBytes = 0;

  let processed = 0;
  const results = await mapPool(state.files, fileConcurrency, async ({ abs, ext }) => {
    if (state.cancelled()) return null;
    let info;
    try {
      info = await fsp.stat(abs);
    } catch (err) {
      state.errors.push({ path: abs, error: err.code || err.message });
      return null;
    }
    if (!info.isFile() || info.size < minBytes) return null;

    const existing = db.prepare('SELECT id, size_bytes, mtime, quick_hash, state FROM assets WHERE abs_path = ? COLLATE NOCASE').get(abs);
    const same = existing && existing.size_bytes === info.size && existing.mtime === info.mtime.toISOString();

    const fileRoot = opts.perFileRoot ? bestRootFor(abs, allRoots) : root;
    let relPath = null;
    if (fileRoot) {
      const rel = path.relative(fileRoot.path, abs);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) relPath = rel;
    }

    const base = {
      root_id: fileRoot?.id ?? null,
      abs_path: abs,
      rel_path: relPath,
      file_name: path.basename(abs),
      ext,
      size_bytes: info.size,
      mtime: info.mtime.toISOString(),
      quick_hash: same && existing.quick_hash ? existing.quick_hash : await quickHashFile(abs, info.size),
    };

    // Fast path: known file, untouched. Only refresh location/bookkeeping.
    if (!opts.force && same && existing.state === 'present' && existing.quick_hash) {
      const res = upsertAsset(db, base);
      totalBytes += info.size;
      seenIds.push(res.id);
      return res;
    }

    const analysis = await analyzeFile({ absPath: abs, size: info.size, ext });
    const res = upsertAsset(db, {
      ...base,
      ...analysis,
      meta: analysis.meta,
      tags: analysis.tags,
    });
    totalBytes += info.size;
    seenIds.push(res.id);
    return res;
  }, () => {
    processed++;
    if (opts.onProgress && (processed % 10 === 0 || processed === state.files.length)) {
      opts.onProgress({
        phase: 'scan',
        found: state.files.length,
        processed,
        current: state.files[Math.min(processed, state.files.length) - 1]?.abs || null,
      });
    }
  });

  for (const r of results) {
    if (!r) { counts.skipped++; continue; }
    if (r.__error) { counts.errors++; state.errors.push({ error: r.__error.message }); continue; }
    if (r.status === 'added') counts.added++;
    else if (r.status === 'updated') counts.updated++;
    else counts.unchanged++;
  }

  if (root && !state.cancelled()) {
    // Only mark missing when we actually scanned the whole root (not a subfolder),
    // and only when the root is reachable (an unplugged disk must not hide its assets).
    const scanCoversRoot = st.isDirectory() && target.toLowerCase() === root.path.toLowerCase();
    const rootExists = scanCoversRoot || await fsp.access(root.path).then(() => true).catch(() => false);
    if (rootExists && scanCoversRoot) markMissing(db, root.id, seenIds);
    touchRootScan(db, root.id);
  }

  return {
    ...counts,
    bytes: totalBytes,
    total: seenIds.length,
    rootId: root?.id ?? null,
    rootName: root?.name ?? null,
    volume: volumeOf(target),
    dirs: state.dirs,
    seenFiles: state.seen,
    errors: state.errors.slice(0, 200),
    cancelled: state.cancelled(),
    durationMs: Date.now() - startedAt,
  };
}
