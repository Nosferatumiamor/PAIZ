// Groupes de modèles (« le pack du jeu », « le pack code »…) : un ensemble nommé de modèles qu'on met en stock d'un coup (« ranger »)
// et qu'on réinvoque d'un coup (« rappeler »), chacun retournant à son adresse EXACTE d'origine, même s'ils venaient de repos différents.
// Un modèle est reconnu par nom de fichier + taille (il survit aux déplacements). L'adresse d'origine est notée au moment de ranger.
// Partage : PAIZ ne peut pas savoir ce que les autres programmes utilisent, mais il repère ce qu'il connaît (autre groupe, lien laissé
// pour une autre appli, dossier d'un programme connu). Ces modèles ne sont pas rangés sans confirmation explicite.
// Option « laisser un lien » : un lien symbolique reste à l'ancien emplacement, les autres programmes retrouvent le fichier.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getSetting, setSetting, getAsset, getRoot, listRoots, queryAssets, listLinks, addLink } from './db.js';
import { assertTransferSpace, startPlacementJob, getJob, listJobs } from './jobs.js';
import { needsOf, planMoves } from './placement.js';

const KEY = 'engine.groups';
export const itemKey = (it) => `${String(it.file_name).toLowerCase()}|${it.size_bytes}`;
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
// dossiers d'autres programmes qui lisent leurs modèles là où ils sont
const OTHER_APPS = /[\\/](\.lmstudio|lm-studio|\.ollama|\.cache[\\/]huggingface|text-generation-webui|koboldcpp|\.jan|gpt4all)([\\/]|$)/i;

const load = (db) => { try { const a = JSON.parse(getSetting(db, KEY, '[]')); return Array.isArray(a) ? a : []; } catch { return []; } };
const store = (db, list) => setSetting(db, KEY, JSON.stringify(list));
const wait = async (id) => { for (;;) { const j = getJob(id); if (!j || j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 300)); } };

// le fichier du modèle sur le disque : un seul suivi, de préférence celui qui existe
function findAsset(db, it) {
  const hits = queryAssets(db, { q: it.file_name, limit: 200 }).items.filter((a) => String(a.file_name).toLowerCase() === String(it.file_name).toLowerCase() && a.size_bytes === it.size_bytes && a.state !== 'missing' && a.root_id != null && fs.existsSync(a.abs_path));
  return hits[0] || null;
}

export function createGroup(db, { name, assetIds = [] }) {
  const items = []; const seen = new Set();
  const add = (a) => { const k = itemKey(a); if (seen.has(k)) return; seen.add(k); items.push({ file_name: a.file_name, title: a.title || '', size_bytes: a.size_bytes }); };
  for (const id of assetIds) {
    const a = getAsset(db, Number(id)); if (!a) continue;
    add(a);
    for (const n of needsOf(db, a)) { if (n.assetId) { const c = getAsset(db, n.assetId); if (c) add(c); } } // mmproj, VAE… voyagent avec lui
  }
  if (!items.length) throw new Error('Choisis au moins un modèle.');
  const now = new Date().toISOString();
  const g = { id: crypto.randomBytes(5).toString('hex'), name: String(name || '').trim().slice(0, 80) || `Groupe du ${new Date().toLocaleDateString('fr-FR')}`, createdAt: now, updatedAt: now, items, parked: null };
  const list = load(db); list.unshift(g); store(db, list);
  return g;
}
export function deleteGroup(db, id) {
  const g = load(db).find((x) => x.id === id);
  if (g?.parked) throw new Error('Ce groupe est rangé : rappelle ses modèles avant de le supprimer (sinon on perd leurs adresses d\'origine).');
  store(db, load(db).filter((x) => x.id !== id));
}
// patch : { name?, addAssetIds?: [id], remove?: [clé] }
export function updateGroup(db, id, patch = {}) {
  const list = load(db); const g = list.find((x) => x.id === id); if (!g) throw new Error('Groupe inconnu.');
  if (patch.name != null && String(patch.name).trim()) g.name = String(patch.name).trim().slice(0, 80);
  const drop = new Set(patch.remove || []);
  g.items = g.items.filter((it) => !drop.has(itemKey(it)));
  const seen = new Set(g.items.map(itemKey));
  for (const aid of patch.addAssetIds || []) {
    const a = getAsset(db, Number(aid)); if (!a) continue;
    for (const x of [a, ...needsOf(db, a).map((n) => n.assetId && getAsset(db, n.assetId)).filter(Boolean)]) {
      const k = itemKey(x); if (!seen.has(k)) { seen.add(k); g.items.push({ file_name: x.file_name, title: x.title || '', size_bytes: x.size_bytes }); }
    }
  }
  if (!g.items.length) throw new Error('Un groupe doit garder au moins un modèle (sinon supprime-le).');
  g.updatedAt = new Date().toISOString(); store(db, list); return g;
}

// état de chaque modèle : home (à sa place) / parked (rangé) / missing ; + raisons de partage possibles
export function groupStatus(db, g, all = load(db)) {
  const roots = new Map(listRoots(db).map((r) => [r.id, r]));
  const others = all.filter((x) => x.id !== g.id);
  return g.items.map((it) => {
    const key = itemKey(it); const a = findAsset(db, it);
    const entry = g.parked?.entries?.[key] || null;
    const shared = [];
    if (a) {
      const og = others.filter((x) => x.items.some((y) => itemKey(y) === key));
      if (og.length) shared.push(`aussi dans « ${og.map((x) => x.name).join('», «')} »`);
      const links = listLinks(db, a.id).filter((l) => fs.existsSync(l.path));
      if (links.length) shared.push(`un lien le rend visible à une autre appli (${links[0].path})`);
      if (OTHER_APPS.test(a.abs_path) || (entry && OTHER_APPS.test(entry.path))) shared.push("dans le dossier d'un autre programme");
    }
    let state = !a ? 'missing' : 'home';
    if (a && entry && norm(a.abs_path) !== norm(entry.path)) state = 'parked';
    const home = entry ? { path: entry.path, rootName: entry.rootName, rootExists: !!rootOf(roots, entry) } : null;
    return { key, ...it, state, shared, home, where: a ? { assetId: a.id, root: roots.get(a.root_id)?.name || '', path: a.abs_path } : null };
  });
}
const rootOf = (roots, e) => { const r = roots.get(e.rootId); return r && norm(r.path) === norm(e.rootPath) && fs.existsSync(r.path) ? r : [...roots.values()].find((x) => norm(x.path) === norm(e.rootPath) && fs.existsSync(x.path)) || null; };

export function listGroups(db) {
  const moving = listJobs().some((j) => j.status === 'running' && j.type === 'bulk-transfer'); // pendant un déplacement, rien n'a encore bougé : on n'efface pas les adresses notées
  const all = load(db); let dirty = false;
  const out = all.map((g) => {
    const state = groupStatus(db, g, all);
    if (!moving && g.parked && !state.some((s) => s.state === 'parked')) { g.parked = null; dirty = true; } // tout est revenu : rien à retenir
    return { ...g, state };
  });
  if (dirty) store(db, all);
  return out;
}

// Ranger tout le groupe dans le repo `toRoot`. allowShared : clés des modèles « peut-être partagés » qu'on accepte quand même de déplacer.
export async function parkGroup(db, { id, toRoot, allowShared = [], leaveLinks = false }) {
  const list = load(db); const g = list.find((x) => x.id === id); if (!g) throw new Error('Groupe inconnu.');
  const dest = getRoot(db, Number(toRoot));
  if (!dest || !fs.existsSync(dest.path)) throw new Error('Repo de destination introuvable.');
  const allow = new Set(allowShared); const skipped = []; const todo = [];
  for (const s of groupStatus(db, g, list)) {
    if (s.state === 'missing') { skipped.push({ key: s.key, reason: 'introuvable sur le disque' }); continue; }
    if (getAsset(db, s.where.assetId).root_id === dest.id) { skipped.push({ key: s.key, reason: 'déjà dans ce repo' }); continue; }
    if (s.shared.length && !allow.has(s.key)) { skipped.push({ key: s.key, reason: `peut être partagé : ${s.shared.join(' ; ')}`, shared: true }); continue; }
    todo.push(s);
  }
  if (!todo.length) throw new Error(skipped.length ? `Rien à ranger (${skipped.map((x) => x.reason).join(' | ')}).` : 'Rien à ranger.');
  const ids = todo.map((s) => s.where.assetId);
  await assertTransferSpace(db, ids, dest.id); // tout est vérifié avant le premier octet déplacé
  // adresses d'origine notées AVANT de bouger (un rangement interrompu reste rappelable) ; une adresse déjà notée n'est pas écrasée
  const roots = new Map(listRoots(db).map((r) => [r.id, r]));
  g.parked = g.parked || { at: new Date().toISOString(), entries: {} };
  g.parked.toRootId = dest.id; g.parked.leaveLinks = leaveLinks === true;
  for (const s of todo) {
    if (g.parked.entries[s.key]) continue;
    const a = getAsset(db, s.where.assetId); const r = roots.get(a.root_id);
    g.parked.entries[s.key] = { path: a.abs_path, rootId: r?.id ?? null, rootName: r?.name || '', rootPath: r?.path || '' };
  }
  store(db, list);
  const job = startPlacementJob(db, { moves: planMoves(db, ids, dest), label: `Ranger le groupe « ${g.name} » → ${dest.name} (${ids.length} fichier(s))` });
  if (leaveLinks) {
    (async () => {
      await wait(job.id);
      for (const s of todo) {
        const home = g.parked.entries[s.key]; const a = findAsset(db, s);
        if (!a || norm(a.abs_path) === norm(home.path) || fs.existsSync(home.path)) continue;
        try { await fsp.mkdir(path.dirname(home.path), { recursive: true }); await fsp.symlink(a.abs_path, home.path, 'file'); addLink(db, a.id, home.path, 'symlink'); } catch { /* droits insuffisants : le modèle est rangé, sans lien */ }
      }
    })().catch(() => {});
  }
  return { job, moving: ids.length, skipped };
}

// Rappeler le groupe : chaque modèle rangé retourne à son adresse exacte. keys : seulement ceux-là (sinon tous les rangés).
export async function recallGroup(db, { id, keys = null }) {
  const list = load(db); const g = list.find((x) => x.id === id); if (!g) throw new Error('Groupe inconnu.');
  const roots = new Map(listRoots(db).map((r) => [r.id, r]));
  const byRoot = new Map(); const problems = []; const only = keys ? new Set(keys) : null;
  for (const s of groupStatus(db, g, list)) {
    if (s.state !== 'parked' || (only && !only.has(s.key))) continue;
    const entry = g.parked.entries[s.key]; const r = rootOf(roots, entry);
    if (!r) { problems.push({ key: s.key, title: s.title || s.file_name, reason: `le repo d'origine « ${entry.rootName} » n'existe plus : déplace ce modèle à la main` }); continue; }
    if (!byRoot.has(r.id)) byRoot.set(r.id, []);
    byRoot.get(r.id).push({ assetId: s.where.assetId, toRoot: r.id, exactDest: entry.path, linkAt: entry.path });
  }
  if (!byRoot.size) { if (problems.length) throw new Error(problems.map((p) => p.reason).join(' | ')); throw new Error('Rien à rappeler : aucun modèle de ce groupe n\'est rangé.'); }
  for (const [rid, moves] of byRoot) await assertTransferSpace(db, moves.map((m) => m.assetId), rid);
  // un lien laissé à l'ancien emplacement est retiré juste avant que le fichier y revienne (jamais autre chose qu'un lien)
  for (const moves of byRoot.values()) for (const m of moves) {
    try { const st = await fsp.lstat(m.linkAt); if (st.isSymbolicLink()) await fsp.unlink(m.linkAt); } catch { /* pas de lien */ }
  }
  const conflicts = [];
  for (const moves of byRoot.values()) for (const m of moves) if (fs.existsSync(m.linkAt)) conflicts.push(m.linkAt);
  const total = [...byRoot.values()].reduce((n, m) => n + m.length, 0);
  (async () => {
    for (const [rid, moves] of byRoot) {
      const job = startPlacementJob(db, { moves: moves.map(({ assetId, toRoot, exactDest }) => ({ assetId, toRoot, exactDest })), label: `Rappeler le groupe « ${g.name} » → ${roots.get(rid).name} (${moves.length} fichier(s))` });
      await wait(job.id);
    }
    listGroups(db); // efface la note « rangé » quand tout est revenu
  })().catch(() => {});
  return { models: total, repos: byRoot.size, problems, conflicts };
}
