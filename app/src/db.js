import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH } from './config.js';
import { nowIso, volumeOf } from './util.js';
let dbInstance = null;

export function openDb() {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 10000;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  dbInstance = db;
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      path TEXT NOT NULL COLLATE NOCASE,
      role TEXT NOT NULL DEFAULT 'store',
      volume TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL,
      last_scan_at TEXT
    );

    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root_id INTEGER REFERENCES roots(id) ON DELETE SET NULL,
      abs_path TEXT NOT NULL COLLATE NOCASE UNIQUE,
      rel_path TEXT,
      file_name TEXT NOT NULL,
      ext TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      base_model TEXT,
      base_family TEXT,
      title TEXT,
      version TEXT,
      format TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      mtime TEXT,
      quick_hash TEXT,
      sha256 TEXT,
      meta_json TEXT,
      tags_json TEXT,
      managed INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'present',
      trashed_from TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(quick_hash);
    CREATE INDEX IF NOT EXISTS idx_assets_root ON assets(root_id);
    CREATE INDEX IF NOT EXISTS idx_assets_cat ON assets(category);
    CREATE INDEX IF NOT EXISTS idx_assets_state ON assets(state);

    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      path TEXT NOT NULL COLLATE NOCASE,
      kind TEXT NOT NULL DEFAULT 'symlink',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      asset_id INTEGER,
      detail TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

export function listRoots(db) {
  return db.prepare('SELECT * FROM roots ORDER BY name COLLATE NOCASE').all();
}

export function getRoot(db, idOrName) {
  if (idOrName == null) return null;
  const asNumber = Number(idOrName);
  if (Number.isInteger(asNumber) && String(idOrName).trim() !== '') {
    const row = db.prepare('SELECT * FROM roots WHERE id = ?').get(asNumber);
    if (row) return row;
  }
  return db.prepare('SELECT * FROM roots WHERE name = ? COLLATE NOCASE').get(String(idOrName)) || null;
}

export function findRootForPath(db, absPath) {
  const roots = listRoots(db).filter((r) => r.enabled);
  let best = null;
  for (const root of roots) {
    const rel = path.relative(root.path, absPath);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      if (!best || root.path.length > best.path.length) best = root;
    }
  }
  return best;
}

export function addRoot(db, { name, path: rootPath, role = 'store', notes = null }) {
  const now = nowIso();
  const stmt = db.prepare(`
    INSERT INTO roots (name, path, role, volume, enabled, notes, created_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(name) DO UPDATE SET path = excluded.path, role = excluded.role, volume = excluded.volume, notes = excluded.notes
  `);
  stmt.run(name, rootPath, role, volumeOf(rootPath), notes, now);
  return getRoot(db, name);
}

export function removeRoot(db, id) {
  db.prepare('DELETE FROM roots WHERE id = ?').run(id);
}

export function touchRootScan(db, id) {
  db.prepare('UPDATE roots SET last_scan_at = ? WHERE id = ?').run(nowIso(), id);
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export function getAsset(db, id) {
  return db.prepare(`
    SELECT a.*, r.name AS root_name, r.path AS root_path, r.role AS root_role
    FROM assets a LEFT JOIN roots r ON r.id = a.root_id
    WHERE a.id = ?
  `).get(Number(id)) || null;
}

export function getAssetByPath(db, absPath) {
  return db.prepare('SELECT * FROM assets WHERE abs_path = ? COLLATE NOCASE').get(absPath) || null;
}

export function upsertAsset(db, input) {
  const now = nowIso();
  const existing = getAssetByPath(db, input.abs_path);
  const relPath = input.rel_path ?? null;
  const rootId = input.root_id ?? null;
  const managed = rootId ? 1 : 0;
  const metaJson = input.meta ? JSON.stringify(input.meta) : null;
  const tagsJson = input.tags ? JSON.stringify(input.tags) : null;

  if (existing) {
    const unchanged = existing.size_bytes === input.size_bytes
      && existing.mtime === input.mtime
      && existing.quick_hash
      && existing.state === 'present';
    if (unchanged) {
      db.prepare(`
        UPDATE assets SET root_id = ?, rel_path = ?, managed = ?, last_seen_at = ?, state = 'present'
        WHERE id = ?
      `).run(rootId, relPath, managed, now, existing.id);
      return { id: existing.id, status: 'unchanged' };
    }
    db.prepare(`
      UPDATE assets SET
        root_id = ?, rel_path = ?, file_name = ?, ext = ?, category = ?, base_model = ?,
        base_family = ?, title = ?, version = ?, format = ?, size_bytes = ?, mtime = ?,
        quick_hash = ?, meta_json = ?, tags_json = ?, managed = ?, state = 'present',
        last_seen_at = ?, notes = COALESCE(?, notes)
      WHERE id = ?
    `).run(
      rootId, relPath, input.file_name, input.ext, input.category, input.base_model,
      input.base_family, input.title, input.version, input.format, input.size_bytes, input.mtime,
      input.quick_hash, metaJson, tagsJson, managed, now, input.notes ?? null, existing.id,
    );
    return { id: existing.id, status: 'updated' };
  }

  const res = db.prepare(`
    INSERT INTO assets (
      root_id, abs_path, rel_path, file_name, ext, category, base_model, base_family,
      title, version, format, size_bytes, mtime, quick_hash, sha256, meta_json, tags_json,
      managed, state, first_seen_at, last_seen_at, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'present', ?, ?, ?)
  `).run(
    rootId, input.abs_path, relPath, input.file_name, input.ext, input.category, input.base_model,
    input.base_family, input.title, input.version, input.format, input.size_bytes, input.mtime,
    input.quick_hash, input.sha256 ?? null, metaJson, tagsJson, managed, now, now,
    input.notes ?? null,
  );
  return { id: Number(res.lastInsertRowid), status: 'added' };
}

export function markMissing(db, rootId, seenIds) {
  if (!seenIds.length) {
    db.prepare("UPDATE assets SET state = 'missing' WHERE root_id = ? AND state = 'present'").run(rootId);
    return;
  }
  const placeholders = seenIds.map(() => '?').join(',');
  db.prepare(`
    UPDATE assets SET state = 'missing'
    WHERE root_id = ? AND state = 'present' AND id NOT IN (${placeholders})
  `).run(rootId, ...seenIds);
}

export function updateAsset(db, id, fields) {
  const allowed = ['title', 'category', 'base_model', 'base_family', 'version', 'notes', 'tags_json', 'state', 'root_id', 'managed', 'rel_path', 'abs_path'];
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    sets.push(`${key} = ?`);
    params.push(value);
  }
  if (sets.length) db.prepare(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`).run(...params, Number(id));
  return getAsset(db, id);
}

export function deleteAssetRow(db, id) {
  db.prepare('DELETE FROM assets WHERE id = ?').run(Number(id));
}

export function listLinks(db, assetId) {
  return db.prepare('SELECT * FROM links WHERE asset_id = ? ORDER BY created_at DESC').all(Number(assetId));
}

export function addLink(db, assetId, linkPath, kind = 'symlink') {
  db.prepare('INSERT INTO links (asset_id, path, kind, created_at) VALUES (?, ?, ?, ?)')
    .run(Number(assetId), linkPath, kind, nowIso());
}

export function removeLink(db, id) {
  db.prepare('DELETE FROM links WHERE id = ?').run(Number(id));
}

export function allAssets(db) {
  return db.prepare(`
    SELECT a.*, r.name AS root_name, r.path AS root_path, r.role AS root_role
    FROM assets a LEFT JOIN roots r ON r.id = a.root_id
    ORDER BY a.id ASC
  `).all();
}

const SORT_COLUMNS = {
  name: 'a.file_name',
  size: 'a.size_bytes',
  date: 'a.mtime',
  category: 'a.category',
  base: 'a.base_model',
  seen: 'a.last_seen_at',
  path: 'a.abs_path',
  root: 'r.name',
};

export function queryAssets(db, filters = {}) {
  const where = [];
  const params = [];

  const state = filters.state || 'present';
  if (state === 'all') {
    // no state filter
  } else if (state === 'missing') {
    where.push("a.state = 'missing'");
  } else if (state === 'trashed') {
    where.push("a.state = 'trashed'");
  } else {
    where.push("a.state = 'present'");
  }

  if (filters.q) {
    const like = `%${String(filters.q).trim()}%`;
    where.push('(a.file_name LIKE ? OR a.title LIKE ? OR a.abs_path LIKE ? OR a.base_model LIKE ?)');
    params.push(like, like, like, like);
  }
  if (filters.category && filters.category !== 'all') {
    where.push('a.category = ?');
    params.push(String(filters.category));
  }
  if (filters.base && filters.base !== 'all') {
    if (filters.base.includes(':')) {
      where.push('a.base_family = ?');
      params.push(String(filters.base).split(':')[1]);
    } else {
      where.push('a.base_model = ?');
      params.push(String(filters.base));
    }
  }
  if (filters.rootId && filters.rootId !== 'all') {
    where.push('a.root_id = ?');
    params.push(Number(filters.rootId));
  }
  if (filters.role === 'active' || filters.role === 'store') {
    where.push('r.role = ?');
    params.push(filters.role);
  }
  if (filters.volume) {
    where.push('r.volume = ?');
    params.push(String(filters.volume));
  }
  if (filters.unmanaged === true || filters.unmanaged === '1') where.push('a.managed = 0');
  if (filters.minSize) {
    where.push('a.size_bytes >= ?');
    params.push(Number(filters.minSize));
  }
  if (filters.maxSize) {
    where.push('a.size_bytes <= ?');
    params.push(Number(filters.maxSize));
  }
  if (Array.isArray(filters.ids) && filters.ids.length) {
    where.push(`a.id IN (${filters.ids.map(() => '?').join(',')})`);
    params.push(...filters.ids.map(Number));
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortCol = SORT_COLUMNS[filters.sort] || SORT_COLUMNS.size;
  const dir = String(filters.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 5000);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM assets a LEFT JOIN roots r ON r.id = a.root_id ${whereSql}`).get(...params).n;
  const items = db.prepare(`
    SELECT a.id, a.root_id, a.abs_path, a.rel_path, a.file_name, a.ext, a.category,
           a.base_model, a.base_family, a.title, a.version, a.format, a.size_bytes,
           a.mtime, a.quick_hash, a.sha256, a.tags_json, a.managed, a.state, a.notes,
           a.first_seen_at, a.last_seen_at, a.trashed_from,
           r.name AS root_name, r.path AS root_path, r.role AS root_role, r.volume
    FROM assets a LEFT JOIN roots r ON r.id = a.root_id
    ${whereSql}
    ORDER BY ${sortCol} ${dir}, a.id ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return { items, total, limit, offset };
}

export function stats(db) {
  const totals = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
    FROM assets WHERE state = 'present'
  `).get();
  const byCategory = db.prepare(`
    SELECT category, COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
    FROM assets WHERE state = 'present' GROUP BY category ORDER BY bytes DESC
  `).all();
  const byBase = db.prepare(`
    SELECT base_model, base_family, COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
    FROM assets WHERE state = 'present' AND base_model IS NOT NULL
    GROUP BY base_model ORDER BY bytes DESC
  `).all();
  const byRoot = db.prepare(`
    SELECT r.id, r.name, r.volume, COUNT(a.id) AS count, COALESCE(SUM(a.size_bytes), 0) AS bytes
    FROM roots r LEFT JOIN assets a ON a.root_id = r.id AND a.state = 'present'
    GROUP BY r.id ORDER BY r.name COLLATE NOCASE
  `).all();
  const missing = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE state = 'missing'").get().n;
  const unmanaged = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE state = 'present' AND managed = 0").get().n;
  const duplicates = db.prepare(`
    SELECT COUNT(*) AS groups FROM (
      SELECT quick_hash FROM assets WHERE state = 'present' AND quick_hash IS NOT NULL
      GROUP BY quick_hash HAVING COUNT(*) > 1
    )
  `).get().groups;
  return { totals, byCategory, byBase, byRoot, missing, unmanaged, duplicateGroups: duplicates };
}

export function duplicateGroups(db) {
  const groups = db.prepare(`
    SELECT quick_hash AS hash, MIN(size_bytes) AS size, COUNT(*) AS count, SUM(size_bytes) AS wasted
    FROM assets WHERE state = 'present' AND quick_hash IS NOT NULL
    GROUP BY quick_hash HAVING COUNT(*) > 1
    ORDER BY wasted DESC
  `).all();
  const itemsStmt = db.prepare(`
    SELECT a.id, a.abs_path, a.file_name, a.size_bytes, a.mtime, a.root_id, a.managed,
           r.name AS root_name, r.volume
    FROM assets a LEFT JOIN roots r ON r.id = a.root_id
    WHERE a.quick_hash = ? AND a.state = 'present'
    ORDER BY a.mtime ASC
  `);
  return groups.map((g) => ({ ...g, items: itemsStmt.all(g.hash) }));
}

export function logEvent(db, type, assetId, detail) {
  try {
    db.prepare('INSERT INTO events (at, type, asset_id, detail) VALUES (?, ?, ?, ?)')
      .run(nowIso(), type, assetId ?? null, detail ? JSON.stringify(detail) : null);
  } catch {
    // Logging must never break an operation.
  }
}

export function listEvents(db, limit = 50) {
  const rows = db.prepare(`
    SELECT e.*, a.file_name AS file_name
    FROM events e LEFT JOIN assets a ON a.id = e.asset_id
    ORDER BY e.id DESC LIMIT ?
  `).all(Math.min(Math.max(Number(limit) || 50, 1), 500));
  return rows.map((r) => {
    let detail = null;
    if (r.detail) { try { detail = JSON.parse(r.detail); } catch { detail = r.detail; } }
    return { ...r, detail };
  });
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
