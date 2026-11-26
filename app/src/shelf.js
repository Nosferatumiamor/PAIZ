// Étagère : ranger un modèle ailleurs en gardant en mémoire d'où il vient et ses « connexions » (liens vers lui), pour le restaurer à l'identique.
//  - ranger : déplacement vérifié vers une racine d'archive ; les liens existants sont repointés vers le nouvel emplacement
//    (les applis qui passent par un lien retrouvent le fichier, plus lentement) et, si demandé, un lien est laissé à l'ancien emplacement.
//  - restaurer : retour sur la racine d'origine, liens repointés vers l'emplacement d'origine, lien temporaire retiré.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getAsset, getRoot, getSetting, listLinks, setSetting, addLink, logEvent } from './db.js';
import { getJob, startTransferJob } from './jobs.js';

const KEY = 'shelf.items';
export const shelfState = { step: 'idle', message: '', jobId: null, error: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function listShelf(db) {
  try { return JSON.parse(getSetting(db, KEY, '[]')); } catch { return []; }
}
const save = (db, items) => setSetting(db, KEY, JSON.stringify(items));

async function waitJob(id) {
  for (;;) {
    const j = getJob(id);
    if (!j) throw new Error('Tâche introuvable');
    if (j.status === 'done') return j;
    if (j.status !== 'running') throw new Error(j.error || `Tâche ${j.status}`);
    await sleep(500);
  }
}

async function isLink(p) { try { return (await fsp.lstat(p)).isSymbolicLink(); } catch { return false; } }

// recrée un lien symbolique `linkPath` -> `target` (ne touche qu'à un lien existant, jamais à un vrai fichier)
async function pointLink(linkPath, target) {
  if (fs.existsSync(linkPath) || await isLink(linkPath)) {
    if (!(await isLink(linkPath))) return `existe déjà et n'est pas un lien : ${linkPath}`;
    await fsp.unlink(linkPath);
  }
  await fsp.mkdir(path.dirname(linkPath), { recursive: true });
  try { await fsp.symlink(target, linkPath, 'file'); return null; } catch (e) { return `lien non créé (${e.code || e.message}) : ${linkPath}`; }
}

const busy = () => !['idle', 'done', 'error'].includes(shelfState.step);

// opts : { assetId, toRoot (id|nom), folder? (sous-dossier dédié dans la racine), leaveLink? (défaut true) }
export function shelve(db, opts) {
  if (busy()) throw new Error('Une opération d\'étagère est déjà en cours.');
  const asset = getAsset(db, opts.assetId);
  if (!asset) throw new Error('Modèle inconnu du catalogue.');
  const dest = getRoot(db, opts.toRoot);
  if (!dest) throw new Error('Racine de destination inconnue.');
  if (asset.root_id === dest.id) throw new Error('Le modèle est déjà dans cette racine.');
  Object.assign(shelfState, { step: 'move', message: `Déplacement de ${asset.file_name} vers ${dest.name}…`, jobId: null, error: null });
  const origin = { path: asset.abs_path, rootId: asset.root_id, rootName: asset.root_name, links: listLinks(db, asset.id).map((l) => ({ path: l.path, kind: l.kind })) };
  (async () => {
    try {
      const job = startTransferJob(db, { assetId: asset.id, toRoot: dest.id, mode: 'move', folder: opts.folder || null });
      shelfState.jobId = job.id;
      await waitJob(job.id);
      const moved = getAsset(db, asset.id);
      const notes = [];
      for (const l of origin.links) { const n = await pointLink(l.path, moved.abs_path); if (n) notes.push(n); }
      if (opts.leaveLink !== false && !origin.links.some((l) => l.path.toLowerCase() === origin.path.toLowerCase())) {
        const n = await pointLink(origin.path, moved.abs_path);
        if (n) notes.push(n); else { addLink(db, asset.id, origin.path, 'symlink'); origin.tempLink = true; }
      }
      const items = listShelf(db);
      items.push({ id: `${asset.id}-${Date.now()}`, assetId: asset.id, fileName: asset.file_name, title: asset.title, size: asset.size_bytes, origin, shelvedTo: { path: moved.abs_path, rootId: dest.id, rootName: dest.name }, at: new Date().toISOString(), notes });
      save(db, items);
      logEvent(db, 'shelve', asset.id, { from: origin.path, to: moved.abs_path });
      Object.assign(shelfState, { step: 'done', message: 'Modèle rangé.' });
    } catch (e) { Object.assign(shelfState, { step: 'error', error: e.message, message: e.message }); }
  })();
  return shelfState;
}

export function restore(db, id) {
  if (busy()) throw new Error('Une opération d\'étagère est déjà en cours.');
  const items = listShelf(db);
  const it = items.find((x) => x.id === id);
  if (!it) throw new Error('Entrée d\'étagère inconnue.');
  const root = getRoot(db, it.origin.rootId);
  if (!root) throw new Error(`La racine d'origine (« ${it.origin.rootName} ») n'existe plus dans PAIZ.`);
  Object.assign(shelfState, { step: 'move', message: `Retour de ${it.fileName} vers ${root.name}…`, jobId: null, error: null });
  (async () => {
    try {
      // un lien temporaire laissé à l'ancien emplacement gênerait le retour : on le retire (seulement si c'est un lien)
      if (await isLink(it.origin.path)) await fsp.unlink(it.origin.path);
      const job = startTransferJob(db, { assetId: it.assetId, toRoot: root.id, mode: 'move', folder: path.relative(root.path, path.dirname(it.origin.path)) || '.' });
      shelfState.jobId = job.id;
      await waitJob(job.id);
      const back = getAsset(db, it.assetId);
      const notes = [];
      for (const l of it.origin.links) { if (l.path.toLowerCase() === it.origin.path.toLowerCase()) continue; const n = await pointLink(l.path, back.abs_path); if (n) notes.push(n); }
      save(db, listShelf(db).filter((x) => x.id !== id));
      logEvent(db, 'unshelve', it.assetId, { to: back.abs_path, expected: it.origin.path, notes });
      Object.assign(shelfState, { step: 'done', message: back.abs_path.toLowerCase() === it.origin.path.toLowerCase() ? 'Modèle restauré à son emplacement d\'origine.' : `Modèle restauré dans ${root.name} (${back.abs_path}).` });
    } catch (e) { Object.assign(shelfState, { step: 'error', error: e.message, message: e.message }); }
  })();
  return shelfState;
}
