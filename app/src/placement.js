// Placement des modèles : fichiers associés (mmproj, VAE, encodeurs…), retour à l'endroit d'origine, déplacement groupé.
// Un modèle « a besoin » des fichiers rangés à côté de lui ; ce lien est mémorisé (origins.js) pour pouvoir dire « ce modèle a besoin de tel fichier ».
import fs from 'node:fs';
import path from 'node:path';
import { getAsset, getRoot, listRoots, queryAssets } from './db.js';
import { assertTransferSpace, startPlacementJob } from './jobs.js';
import { getNeeds, getOrigin, modelKey, setNeeds, allOrigins } from './origins.js';
import { cleanDestFor, activeDestFor } from './ecurie.js';

const dirOf = (p) => path.dirname(p).toLowerCase();
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const alnum = (s) => String(s).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/^mmproj[-_.]?/, '').replace(/[^a-z0-9]/g, '');
const prefixLen = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

export const isCompanion = (a) => a.category === 'vae' || a.category === 'clip' || /mmproj/i.test(a.file_name) || /(^|[-_. ])(vae|clip_?[lg]|t5xxl|umt5|text_?encoder)([-_. ]|\.|$)/i.test(a.file_name);
const roleOf = (a) => (/mmproj/i.test(a.file_name) ? 'mmproj' : a.category === 'vae' || /vae/i.test(a.file_name) ? 'VAE' : a.category === 'clip' || /clip|t5|encoder/i.test(a.file_name) ? 'encodeur' : 'associé');
const isModelFile = (a) => /\.(gguf|safetensors|ckpt)$/i.test(a.file_name);

// index du catalogue : tous les fichiers gérés, par dossier et par clé
function buildIndex(db) {
  const all = queryAssets(db, { limit: 5000 }).items.filter((a) => a.root_id != null);
  const byDir = new Map(); const byKey = new Map();
  for (const a of all) {
    const d = dirOf(a.abs_path); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(a);
    const k = modelKey(a); if (!byKey.has(k) || a.root_role === 'active') byKey.set(k, a);
  }
  return { byDir, byKey, roots: new Map(listRoots(db).map((r) => [r.id, r])) };
}

// fichiers rangés à côté du modèle et qui lui servent (mmproj, VAE…). Plusieurs modèles dans le dossier : on apparie par le début du nom.
function detect(idx, a) {
  if (isCompanion(a)) return [];
  const sibs = (idx.byDir.get(dirOf(a.abs_path)) || []).filter((x) => x.id !== a.id);
  const cands = sibs.filter(isCompanion);
  const others = sibs.filter((x) => !isCompanion(x) && isModelFile(x));
  if (!others.length) return cands;
  return cands.filter((c) => prefixLen(alnum(a.file_name), alnum(c.file_name)) >= 8);
}

// besoins du modèle (détectés + mémorisés), chacun avec sa situation : avec lui / ailleurs / introuvable
export function needsOf(db, a, idx = buildIndex(db)) {
  const out = new Map();
  for (const c of detect(idx, a)) out.set(modelKey(c), { file_name: c.file_name, size_bytes: c.size_bytes, role: roleOf(c) });
  for (const n of getNeeds(db, a)) if (!out.has(modelKey(n))) out.set(modelKey(n), n);
  const mine = idx.roots.get(a.root_id);
  return [...out.values()].map((n) => {
    const hit = idx.byKey.get(modelKey(n));
    if (!hit || !fs.existsSync(hit.abs_path)) return { ...n, where: 'missing', assetId: null };
    const together = dirOf(hit.abs_path) === dirOf(a.abs_path);
    const sameSide = (idx.roots.get(hit.root_id)?.role === 'active') === (mine?.role === 'active');
    return { ...n, assetId: hit.id, where: together ? 'together' : 'apart', sameSide, location: { root: hit.root_name || idx.roots.get(hit.root_id)?.name || '', path: hit.abs_path } };
  });
}

// état du repo d'origine d'un modèle rangé
export function originState(db, a, idx = buildIndex(db)) {
  const o = getOrigin(db, a); if (!o) return { state: 'none' };
  const r = idx.roots.get(o.rootId) || [...idx.roots.values()].find((x) => norm(x.path) === norm(o.rootPath));
  const state = !r || !fs.existsSync(r.path) ? 'gone' : r.role !== 'active' ? 'not-active' : 'ok';
  return { state, path: o.path, rootId: r?.id ?? null, rootName: o.rootName, rootPath: o.rootPath, at: o.at };
}

// pour l'écran : origine + besoins de chaque modèle .gguf
export function linksForAll(db) {
  const idx = buildIndex(db); const links = {};
  for (const [, list] of idx.byDir) for (const a of list) {
    if (!/\.gguf$/i.test(a.file_name) || isCompanion(a)) continue;
    const needs = needsOf(db, a, idx); const origin = originState(db, a, idx);
    if (needs.length || origin.state !== 'none') links[a.id] = { needs, origin };
  }
  return links;
}
export function moveInfo(db, assetId) {
  const a = getAsset(db, assetId); if (!a) throw new Error('Modèle inconnu.');
  const idx = buildIndex(db);
  return { origin: originState(db, a, idx), needs: needsOf(db, a, idx) };
}

// déplacements à faire pour mettre `ids` dans destRoot : chacun retourne à son adresse EXACTE d'origine si destRoot est son repo d'origine
export function planMoves(db, ids, destRoot) {
  return ids.map((id) => {
    const a = getAsset(db, id); const o = a && getOrigin(db, a);
    const inside = o && norm(o.path).startsWith(norm(destRoot.path) + '/');
    // adresse d'origine exacte si connue ; sinon rangement propre (vers une écurie propre) ou dossier habituel du repo actif (retour d'une écurie propre)
    const exact = o && o.rootId === destRoot.id && inside ? o.path : (a ? (cleanDestFor(db, a, destRoot) || activeDestFor(db, a, destRoot)) : null);
    return { assetId: id, toRoot: destRoot.id, exactDest: exact };
  });
}

// modèle + fichiers associés cochés, vers un repo ; le lien « ce modèle a besoin de… » est mémorisé
export async function moveModel(db, { assetId, toRoot, companionIds = [] }) {
  const a = getAsset(db, assetId); const dest = getRoot(db, toRoot);
  if (!a) throw new Error('Modèle inconnu.'); if (!dest) throw new Error('Repo de destination inconnu.');
  const needs = needsOf(db, a);
  setNeeds(db, a, needs.map(({ file_name, size_bytes, role }) => ({ file_name, size_bytes, role })));
  const allowed = new Set(needs.map((n) => n.assetId).filter(Boolean));
  const ids = [assetId, ...companionIds.map(Number).filter((id) => allowed.has(id) && id !== assetId)].filter((id) => getAsset(db, id)?.root_id !== dest.id);
  if (!ids.length) throw new Error('Le modèle est déjà dans ce repo.');
  await assertTransferSpace(db, ids, dest.id);
  const job = startPlacementJob(db, { moves: planMoves(db, ids, dest), label: `Déplacement de ${a.title || a.file_name}${ids.length > 1 ? ` + ${ids.length - 1} fichier(s) associé(s)` : ''} → ${dest.name}` });
  return { job, files: ids.length };
}
// Fusionne un dossier dans un autre : tous ses modèles partent dans le dossier cible ; si celui-ci est une écurie propre, ils y sont
// rangés par type/famille au passage (planMoves). Même disque : renommages ; autre disque : copie vérifiée puis suppression de l'original.
export async function mergeRoots(db, fromId, intoId) {
  const from = getRoot(db, fromId); const into = getRoot(db, intoId);
  if (!from || !into) throw new Error('Dossier inconnu.'); if (from.id === into.id) throw new Error('Choisis deux dossiers différents.');
  const ids = queryAssets(db, { rootId: from.id, limit: 20000 }).items.filter((a) => a.root_id === from.id && a.state !== 'missing').map((a) => a.id);
  if (!ids.length) throw new Error('Ce dossier ne contient aucun modèle suivi.');
  await assertTransferSpace(db, ids, into.id);
  const job = startPlacementJob(db, { moves: planMoves(db, ids, into), label: `Déplacement de ${ids.length} modèle(s) de ${from.name} → ${into.name}` });
  return { job, files: ids.length };
}
export { allOrigins };
