// Configurations de modèles (« save conf » / « load conf ») : un instantané de la liste des modèles ACTIFS, avec les repos où ils étaient.
// Recharger une configuration = déplacer vers les repos actifs ceux qui sont encore dans un repo (stock), jamais de copie en double.
// Un modèle est reconnu par nom de fichier + taille (et l'empreinte si elle est connue) : il peut avoir changé de dossier depuis la sauvegarde.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { getSetting, setSetting, listRoots, queryAssets } from './db.js';
import { assertTransferSpace, startPlacementJob, getJob } from './jobs.js';
import { needsOf, planMoves } from './placement.js';
import { getAsset } from './db.js';

const KEY = 'engine.confs';
const ORIGINS = 'hub.origins'; // nom de fichier -> dépôt Hugging Face d'où il a été téléchargé par PAIZ (pour le re-télécharger)

export const itemKey = (it) => `${String(it.file_name).toLowerCase()}|${it.size_bytes}`;
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function load(db) { try { const a = JSON.parse(getSetting(db, KEY, '[]')); return Array.isArray(a) ? a : []; } catch { return []; } }
const store = (db, list) => setSetting(db, KEY, JSON.stringify(list));

export function rememberOrigin(db, hfId, fileNames) {
  let o = {}; try { o = JSON.parse(getSetting(db, ORIGINS, '{}')) || {}; } catch { /* vide */ }
  for (const n of fileNames) o[String(n).toLowerCase()] = hfId;
  setSetting(db, ORIGINS, JSON.stringify(o));
}
const origins = (db) => { try { return JSON.parse(getSetting(db, ORIGINS, '{}')) || {}; } catch { return {}; } };

// modèles .gguf actuellement dans un repo actif (hors mmproj : module d'image d'un modèle)
export function activeModels(db) {
  return queryAssets(db, { q: '.gguf', limit: 5000 }).items.filter((a) => /\.gguf$/i.test(a.file_name) && !/mmproj/i.test(a.file_name) && a.root_role === 'active');
}

export function saveConf(db, { name }) {
  const items = activeModels(db);
  if (!items.length) throw new Error("Aucun modèle actif à sauvegarder.");
  const roots = new Map(listRoots(db).map((r) => [r.id, r]));
  const now = new Date();
  const conf = {
    id: crypto.randomBytes(5).toString('hex'),
    name: String(name || '').trim().slice(0, 80) || `Configuration du ${now.toLocaleDateString('fr-FR')} ${now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`,
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    items: items.map((a) => {
      const r = roots.get(a.root_id);
      return { file_name: a.file_name, title: a.title || '', size_bytes: a.size_bytes, hash: a.sha256 || a.quick_hash || null, repo: r ? { id: r.id, name: r.name, path: r.path, volume: r.volume || '' } : null, rel_path: a.rel_path || '' };
    }),
  };
  const list = load(db); list.unshift(conf); store(db, list);
  return conf;
}
export function deleteConf(db, id) { store(db, load(db).filter((c) => c.id !== id)); }

// patch : { name?, remove?: [clé], repos?: { clé: idDuRepo } } — mise à jour d'une sauvegarde (retirer des modèles, re-indiquer un repo)
export function updateConf(db, id, patch = {}) {
  const list = load(db); const c = list.find((x) => x.id === id);
  if (!c) throw new Error('Configuration inconnue.');
  const roots = new Map(listRoots(db).map((r) => [r.id, r]));
  if (patch.name != null && String(patch.name).trim()) c.name = String(patch.name).trim().slice(0, 80);
  const drop = new Set(patch.remove || []);
  c.items = c.items.filter((it) => !drop.has(itemKey(it)));
  for (const [k, rid] of Object.entries(patch.repos || {})) {
    const it = c.items.find((x) => itemKey(x) === k); const r = roots.get(Number(rid));
    if (it && r) it.repo = { id: r.id, name: r.name, path: r.path, volume: r.volume || '' };
  }
  if (!c.items.length) throw new Error('Une configuration doit garder au moins un modèle (sinon supprime-la).');
  c.updatedAt = new Date().toISOString();
  store(db, list); return c;
}

// état de chaque modèle et de son repo d'origine
export function confStatus(db, conf) {
  const roots = listRoots(db).map((r) => ({ ...r, exists: fs.existsSync(r.path) }));
  const byPath = (p) => roots.find((r) => norm(r.path) === norm(p));
  const org = origins(db);
  const find = db.prepare("SELECT a.*, r.name AS root_name, r.role AS root_role, r.path AS root_path FROM assets a LEFT JOIN roots r ON r.id = a.root_id WHERE a.file_name = ? COLLATE NOCASE AND a.size_bytes = ? AND a.state = 'present'");
  return conf.items.map((it) => {
    const hits = find.all(it.file_name, it.size_bytes).filter((a) => fs.existsSync(a.abs_path));
    const hit = hits.find((a) => a.root_role === 'active') || hits.find((a) => a.root_id != null) || hits[0] || null;
    const status = !hit ? 'missing' : hit.root_role === 'active' ? 'active' : hit.root_id == null ? 'unmanaged' : 'stock';
    let repoState = 'none'; let targetRootId = null;
    if (it.repo) {
      const r = roots.find((x) => x.id === it.repo.id && norm(x.path) === norm(it.repo.path)) || byPath(it.repo.path);
      if (!r || !r.exists) repoState = 'gone';
      else if (r.role !== 'active') repoState = 'not-active';
      else { repoState = 'ok'; targetRootId = r.id; }
    }
    return { key: itemKey(it), ...it, status, where: hit ? { root: hit.root_name || null, path: hit.abs_path, assetId: hit.id } : null, repoState, targetRootId, hfId: org[String(it.file_name).toLowerCase()] || null };
  });
}

export function listConfs(db) {
  return load(db).map((c) => ({ ...c, state: confStatus(db, c) }));
}

// picks : [{ key, toRoot }] — déplace vers les repos actifs choisis ceux qui sont en stock ; les groupes (un par repo cible) sont enchaînés
export async function loadConf(db, { id, picks }) {
  const conf = load(db).find((c) => c.id === id);
  if (!conf) throw new Error('Configuration inconnue.');
  const state = new Map(confStatus(db, conf).map((s) => [s.key, s]));
  const roots = new Map(listRoots(db).map((r) => [r.id, r]));
  const groups = new Map(); let skipped = 0;
  for (const p of picks || []) {
    const s = state.get(p.key); if (!s) continue;
    if (s.status === 'active') { skipped++; continue; }
    if (s.status !== 'stock') throw new Error(`« ${s.title || s.file_name} » n'est pas disponible (${s.status === 'missing' ? 'disparu' : 'non géré'}).`);
    const r = roots.get(Number(p.toRoot));
    if (!r || r.role !== 'active' || !fs.existsSync(r.path)) throw new Error(`Choisis un repo actif existant pour « ${s.title || s.file_name} ».`);
    if (!groups.has(r.id)) groups.set(r.id, []);
    const a = getAsset(db, s.where.assetId); const g = groups.get(r.id); g.push(s.where.assetId);
    for (const n of needsOf(db, a)) if (n.assetId && n.where !== 'missing' && !n.sameSide && !g.includes(n.assetId)) g.push(n.assetId); // ses fichiers associés restés en stock voyagent avec lui
  }
  for (const [rid, ids] of groups) await assertTransferSpace(db, ids, rid); // tout est vérifié avant le premier octet déplacé
  const total = [...groups.values()].reduce((n, g) => n + g.length, 0);
  (async () => {
    for (const [rid, ids] of groups) {
      const job = startPlacementJob(db, { moves: planMoves(db, ids, roots.get(rid)), label: `Chargement de la configuration « ${conf.name} » → ${roots.get(rid).name} (${ids.length} fichier(s))` });
      for (;;) { const j = getJob(job.id); if (!j || j.status !== 'running') break; await new Promise((r) => setTimeout(r, 500)); }
    }
  })().catch(() => {});
  return { models: total, repos: groups.size, skipped };
}
