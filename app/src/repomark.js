// Dossiers de modèles qu'on peut déplacer : chaque dossier suivi par PAIZ contient un petit fichier visible, PAIZ-repo.json,
// qui dit « je suis un dossier PAIZ, prêts à lancer (active) ou réserve (store) ». Si le dossier change de place (autre disque,
// autre nom), PAIZ le retrouve en cherchant ce fichier et met à jour l'adresse du dossier et de tous ses modèles.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { listRoots, getRoot, logEvent } from './db.js';
import { listLocalVolumes } from './volumes.js';

export const MARKER = 'PAIZ-repo.json';
const ROLE_LABEL = { active: 'ready to launch (fast disk)', store: 'reserve (storage)', external: 'external folder' };
const SKIP_DIRS = /^(\$recycle\.bin|system volume information|windows|program files|program files \(x86\)|programdata|recovery|perflogs|appdata|node_modules|\.git|\.cache|msocache|config\.msi|intel|amd|nvidia|windows\.old|site-packages|__pycache__|venv|env|\.venv|dist-packages|winsxs|installer)$/i;

function ensureUid(db) {
  try { db.exec('ALTER TABLE roots ADD COLUMN uid TEXT'); } catch { /* déjà là */ }
}

/** Écrit (ou met à jour) le repère d'un dossier suivi. Sans effet si le dossier est absent ou en lecture seule. */
export function writeMarker(db, root) {
  ensureUid(db);
  let uid = db.prepare('SELECT uid FROM roots WHERE id = ?').get(root.id)?.uid;
  const file = path.join(root.path, MARKER);
  try { const cur = JSON.parse(fs.readFileSync(file, 'utf8')); if (!uid && cur?.id) uid = cur.id; } catch { /* pas encore de repère */ }
  if (!uid) uid = crypto.randomUUID();
  db.prepare('UPDATE roots SET uid = ? WHERE id = ?').run(uid, root.id);
  const body = { paiz: 'repo', id: uid, role: root.role, name: root.name, means: `PAIZ model folder — ${ROLE_LABEL[root.role] || root.role}. Keep this file: it lets PAIZ find this folder again if you move it.`, written: new Date().toISOString() };
  try { if (fs.existsSync(root.path)) fs.writeFileSync(file, JSON.stringify(body, null, 2)); } catch { /* lecture seule : tant pis */ }
  return uid;
}
export function markAll(db) { for (const r of listRoots(db)) writeMarker(db, r); }

/** Change l'adresse d'un dossier suivi (il a été déplacé) : le dossier et tous ses modèles. */
export function relocateRoot(db, id, newPath) {
  const r = getRoot(db, id); if (!r) throw new Error('Unknown folder.');
  const norm = path.resolve(newPath);
  db.prepare('UPDATE roots SET path = ?, volume = ? WHERE id = ?').run(norm, /^[A-Za-z]:/.test(norm) ? norm.slice(0, 2).toUpperCase() : null, id);
  const rows = db.prepare('SELECT id, abs_path, rel_path FROM assets WHERE root_id = ?').all(id);
  const up = db.prepare("UPDATE assets SET abs_path = ?, state = CASE WHEN state = 'missing' THEN 'present' ELSE state END WHERE id = ?");
  for (const a of rows) {
    const rel = a.rel_path || (a.abs_path.toLowerCase().startsWith(r.path.toLowerCase()) ? a.abs_path.slice(r.path.length).replace(/^[\\/]+/, '') : null);
    if (rel) up.run(path.join(norm, rel), a.id);
  }
  logEvent(db, 'root-moved', null, { name: r.name, from: r.path, to: norm, models: rows.length });
  return { from: r.path, to: norm, models: rows.length };
}

// Parcours en largeur, borné (nombre de dossiers lus par disque) ; on ne descend pas dans un dossier PAIZ (ses sous-dossiers sont des modèles).
async function walk(top, depth, out, { maxDirs = 6000, maxFound = 200 } = {}) {
  let level = [top]; let seen = 0;
  for (let d = 0; d <= depth && level.length; d++) {
    const next = [];
    for (let i = 0; i < level.length; i += 32) {
      const lists = await Promise.all(level.slice(i, i + 32).map((dir) => fsp.readdir(dir, { withFileTypes: true }).then((e) => [dir, e], () => [dir, []])));
      for (const [dir, entries] of lists) {
        if (++seen > maxDirs || out.length >= maxFound) return;
        if (entries.some((e) => e.isFile() && e.name === MARKER)) { out.push(dir); continue; }
        if (d < depth) for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.test(e.name) && !e.name.startsWith('.') && !e.name.startsWith('$')) next.push(path.join(dir, e.name));
      }
    }
    level = next;
  }
}

/** Cherche les dossiers PAIZ sur les disques locaux (jusqu'à 4 niveaux sous la racine de chaque disque) et les rattache :
 *  un dossier connu qui a bougé est relocalisé ; un dossier PAIZ inconnu (autre machine, base réinstallée) est ajouté avec son rôle. */
export async function findRepos(db, { depth = 4, apply = true, tops: only = null } = {}) {
  ensureUid(db);
  const vols = only ? [] : await listLocalVolumes({ includeRemovable: true }).catch(() => []);
  const tops = only || vols.map((v) => v.mount || v.path || v.root || v).filter((p) => typeof p === 'string');
  const known = listRoots(db).map((r) => ({ ...r, uid: db.prepare('SELECT uid FROM roots WHERE id = ?').get(r.id)?.uid }));
  // les dossiers connus encore en place ne sont pas cherchés
  const dirs = [];
  const per = await Promise.all(tops.map(async (t) => { const o = []; await walk(t, depth, o); return o; }));
  for (const o of per) dirs.push(...o);
  const res = [];
  for (const d of dirs) {
    let m; try { m = JSON.parse(fs.readFileSync(path.join(d, MARKER), 'utf8')); } catch { continue; }
    if (m?.paiz !== 'repo' || !m.id) continue;
    const k = known.find((r) => r.uid === m.id);
    if (k && path.resolve(k.path).toLowerCase() === path.resolve(d).toLowerCase()) { res.push({ path: d, name: k.name, role: k.role, status: 'in-place' }); continue; }
    if (k) {
      if (fs.existsSync(k.path) && fs.existsSync(path.join(k.path, MARKER))) { res.push({ path: d, name: k.name, role: k.role, status: 'copy' }); continue; } // une copie : on ne touche à rien
      if (apply) relocateRoot(db, k.id, d);
      res.push({ path: d, from: k.path, name: k.name, role: k.role, status: 'moved' });
      continue;
    }
    let name = String(m.name || path.basename(d)).slice(0, 60); let n = 2;
    while (listRoots(db).some((r) => r.name.toLowerCase() === name.toLowerCase())) name = `${String(m.name || path.basename(d)).slice(0, 55)} ${n++}`;
    if (apply) {
      db.prepare("INSERT INTO roots (name, path, role, volume, enabled, created_at, uid) VALUES (?, ?, ?, ?, 1, ?, ?)").run(name, d, ['active', 'store', 'external'].includes(m.role) ? m.role : 'store', /^[A-Za-z]:/.test(d) ? d.slice(0, 2).toUpperCase() : null, new Date().toISOString(), m.id);
      logEvent(db, 'root-found', null, { name, path: d, role: m.role });
    }
    res.push({ path: d, name, role: m.role, status: 'added' });
  }
  const missing = listRoots(db).filter((r) => !fs.existsSync(r.path)).map((r) => ({ name: r.name, path: r.path, role: r.role }));
  return { found: res, missing };
}
