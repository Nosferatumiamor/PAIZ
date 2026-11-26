// Small dependency-free helpers shared by the CLI, the server and the scanner.
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const APP_NAME = 'PAIZ';
export const APP_VERSION = '0.3.1';

// Files we consider "AI model" candidates while scanning.
export const MODEL_EXTENSIONS = new Set([
  '.safetensors', '.sft', '.ckpt', '.gguf', '.ggml',
  '.pt', '.pth', '.bin', '.pkl', '.onnx',
  '.tflite', '.h5', '.keras', '.pte', '.engine', '.plan', '.mlmodel',
]);

// Never descend into these folders while scanning.
export const SKIPPED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  'site-packages', '.mdisp-trash', '$recycle.bin', 'system volume information',
  'windows', 'winsxs', 'proc', 'sys', 'dev', '.cache', '.npm', '.cargo',
]);

// Extra folders ignored by the gentle all-disks scan. They are almost never
// where models live, and walking them would slow the machine down for nothing.
export const DEEP_SKIPPED_DIRS = new Set([
  ...SKIPPED_DIRS,
  'program files', 'program files (x86)', 'programdata', 'recovery', 'perflogs',
  'msocache', 'config.msi', 'windows.old', '$windows.~bt', '$windows.~ws',
  'system32', 'syswow64', 'driverstore', 'installer', 'assembly', 'servicing',
  'temp', 'tmp', 'packages', 'crashdumps', 'd3dscache', 'dxcache',
  'microsoft', 'google', 'mozilla', 'nvidia', 'amd', 'intel',
]);

// Training leftovers that look like models but are not.
export const SKIPPED_FILES = new Set([
  'optimizer.pt', 'optimizer.bin', 'scheduler.pt', 'scaler.pt', 'rng_state.pth',
  'rng_state_0.pth', 'rng_state_1.pth', 'training_args.bin', 'training_state.bin',
  'random_states_0.pkl', 'random_states_1.pkl',
]);

export const MIN_MODEL_BYTES = 64 * 1024; // 64 KiB
export const DEEP_SCAN_MIN_BYTES = 1 * 1024 * 1024; // 1 MiB for whole-disk discovery
export const DEEP_SCAN_MAX_DEPTH = 20;
export const DEEP_SCAN_PACE_MS = 2; // yield between directory batches

export function humanBytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits).replace('.', ',')} ${units[i]}`;
}

export function parseBytes(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'number') return value;
  const m = String(value).trim().match(/^([0-9]+(?:[.,][0-9]+)?)\s*(o|b|ko|kb|mo|mb|go|gb|to|tb)?$/i);
  if (!m) return fallback;
  const mult = { o: 1, b: 1, ko: 1024, kb: 1024, mo: 1024 ** 2, mb: 1024 ** 2, go: 1024 ** 3, gb: 1024 ** 3, to: 1024 ** 4, tb: 1024 ** 4 };
  return Math.round(parseFloat(m[1].replace(',', '.')) * (mult[(m[2] || 'o').toLowerCase()] || 1));
}

export function humanDate(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('fr-FR', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function humanDateTime(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function normalizeDir(p) {
  let r = path.resolve(p);
  if (/^[A-Za-z]:[\\/]?$/.test(r)) return `${r.slice(0, 2)}\\`;
  r = r.replace(/[\\/]+$/, '');
  return r;
}

export function volumeOf(p) {
  const root = path.parse(path.resolve(p)).root;
  return root.replace(/[\\/]+$/, '') || '/';
}

export function isSubPath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function safeFileName(name) {
  return String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'fichier';
}

export async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

export async function fileSize(p) {
  try { return (await fsp.stat(p)).size; } catch { return null; }
}

export async function readJsonSafe(p, maxBytes = 2 * 1024 * 1024) {
  try {
    const st = await fsp.stat(p);
    if (!st.isFile() || st.size > maxBytes) return null;
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Fast identity hash: size + first/last 256 KiB.
 * Two files sharing this hash are almost certainly the same model,
 * even across disks, without reading 20 GB.
 */
export async function quickHashFile(absPath, size) {
  const chunk = 256 * 1024;
  const fh = await fsp.open(absPath, 'r');
  try {
    const h = createHash('sha256');
    const headLen = Math.min(chunk, size);
    const head = Buffer.alloc(headLen);
    if (headLen) await fh.read(head, 0, headLen, 0);
    h.update(head);
    h.update(`|${size}|`);
    if (size > chunk * 2) {
      const tailLen = Math.min(chunk, size - chunk);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      h.update(tail);
    }
    return `q1:${h.digest('hex')}`;
  } finally {
    await fh.close();
  }
}

export async function fullHashFile(absPath, onProgress = null) {
  const h = createHash('sha256');
  const fh = await fsp.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      h.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
      if (onProgress) onProgress(pos);
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

export async function freeSpace(p) {
  if (process.env.PAIZ_TEST_FREE) return { free: Number(process.env.PAIZ_TEST_FREE), total: Number(process.env.PAIZ_TEST_FREE) }; // tests seulement
  try {
    const st = await fsp.statfs(p);
    return { free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) };
  } catch {
    return null;
  }
}

/** Run async fn over items with a concurrency limit. Returns results in input order. */
export async function mapPool(items, limit, fn, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const width = Math.max(1, Math.min(limit, items.length || 1));
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = { __error: err };
      }
      done++;
      if (onProgress) onProgress(done, items.length, items[i]);
    }
  }
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

export function nowIso() {
  return new Date().toISOString();
}

export function cleanTitle(fileName) {
  return String(fileName)
    .replace(/\.(safetensors|sft|ckpt|gguf|ggml|pt|pth|bin|pkl|onnx)$/i, '')
    .replace(/[_.]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function uniqueBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
