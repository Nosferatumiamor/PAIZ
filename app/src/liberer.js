// « Libérer » : un modèle d'un repo ACTIF dont une copie IDENTIQUE dort déjà dans un repo de stockage n'a pas besoin d'occuper la place deux fois.
// On vérifie d'abord que les deux copies sont strictement identiques (SHA-256 complet des deux fichiers), on retient l'adresse exacte du fichier actif
// sur la copie de stockage (pour pouvoir l'« invoquer » d'un clic, pile au même endroit), puis on retire la copie active (corbeille ou effacement).
// Si la moindre vérification échoue, RIEN n'est retiré.
import fs from 'node:fs';
import { getAsset, getRoot, queryAssets, logEvent, deleteAssetRow } from './db.js';
import { startJob, recycleToWindowsBin } from './jobs.js';
import { setOrigin, clearOrigin } from './origins.js';
import { fullHashFile, nowIso } from './util.js';

// paires (copie active, copie de stockage) : même taille et même empreinte rapide
export function listLiberables(db) {
  const all = queryAssets(db, { limit: 5000 }).items.filter((a) => a.root_id != null && a.quick_hash);
  const stores = new Map();
  for (const a of all) if (a.root_role === 'store') { const k = `${a.quick_hash}|${a.size_bytes}`; if (!stores.has(k)) stores.set(k, []); stores.get(k).push(a); }
  const out = [];
  for (const a of all) {
    if (a.root_role !== 'active') continue;
    const twin = (stores.get(`${a.quick_hash}|${a.size_bytes}`) || []).find((s) => fs.existsSync(s.abs_path));
    if (!twin || !fs.existsSync(a.abs_path)) continue;
    out.push({ id: a.id, name: a.title || a.file_name, file: a.file_name, size: a.size_bytes, category: a.category, activeRoot: a.root_name, path: a.abs_path,
      store: { id: twin.id, root: twin.root_name, path: twin.abs_path } });
  }
  return { items: out.sort((x, y) => y.size - x.size), bytes: out.reduce((n, x) => n + x.size, 0) };
}

// permanent = false : corbeille Windows (la place n'est rendue qu'en la vidant) ; true : effacement direct, place rendue tout de suite
export function startLiberateJob(db, { ids = [], permanent = false } = {}) {
  const want = new Set(ids.map(Number)); const pairs = listLiberables(db).items.filter((x) => want.has(x.id));
  if (!pairs.length) throw new Error('Rien à libérer : plus de copie identique en stockage.');
  return startJob('liberate', `Libérer ${pairs.length} fichier(s) déjà rangés en stockage`, { ids: pairs.map((p) => p.id), permanent }, async (job) => {
    const freed = []; const failed = [];
    job.progress.total = pairs.length; job.progress.totalBytes = pairs.reduce((n, p) => n + p.size * 2, 0); let base = 0;
    for (const p of pairs) {
      if (job.cancelled) break;
      job.progress.current = p.file; job.progress.phase = 'verify';
      let marked = null;
      try {
        const a = getAsset(db, p.id); const s = getAsset(db, p.store.id);
        if (!a || !s || !fs.existsSync(a.abs_path) || !fs.existsSync(s.abs_path)) throw new Error('un des deux fichiers a disparu');
        if (fs.statSync(a.abs_path).size !== fs.statSync(s.abs_path).size) throw new Error('tailles différentes');
        const h1 = await fullHashFile(a.abs_path, (n) => { job.progress.bytes = base + n; });
        const h2 = await fullHashFile(s.abs_path, (n) => { job.progress.bytes = base + a.size_bytes + n; });
        base += a.size_bytes * 2;
        if (h1 !== h2) throw new Error('les deux copies ne sont PAS identiques : rien n\'a été touché');
        job.progress.phase = 'remove';
        // retiré seulement APRÈS avoir retenu l'adresse exacte (si le retrait échoue, on la rétablit)
        const root = getRoot(db, a.root_id);
        marked = s; setOrigin(db, s, { path: a.abs_path, rootId: root.id, rootName: root.name, rootPath: root.path, at: nowIso() });
        db.prepare('UPDATE assets SET sha256 = ? WHERE id IN (?, ?)').run(h1, a.id, s.id);
        if (permanent) fs.unlinkSync(a.abs_path);
        else {
          const rb = await recycleToWindowsBin(a.abs_path);
          if (!rb.ok) throw new Error(rb.cancelled ? 'annulé (Windows a demandé confirmation)' : rb.nobin ? 'ce disque n\'a pas de corbeille Windows : utilise l\'effacement' : `corbeille impossible : ${rb.reason}`);
        }
        deleteAssetRow(db, a.id);
        logEvent(db, 'liberate', s.id, { removed: a.abs_path, keptCopy: s.abs_path, permanent });
        freed.push({ id: p.id, bytes: p.size });
      } catch (err) {
        const still = getAsset(db, p.id); if (marked && still && fs.existsSync(still.abs_path)) clearOrigin(db, marked); // rien n'a été retiré : on ne laisse pas une fausse adresse d'origine
        failed.push({ id: p.id, file: p.file, error: err.message });
      }
      job.progress.done++;
    }
    return { freed: freed.length, bytes: freed.reduce((n, f) => n + f.bytes, 0), failed };
  });
}
