// Fusion de doublons exacts par lien dur NTFS : les deux chemins restent valides (ComfyUI, SwarmUI… ne voient rien), le disque ne stocke le fichier qu'une fois.
// Sûr : même disque obligatoire, contenu comparé octet par octet (SHA-256 complet), lien créé à côté puis posé par renommage atomique.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { getAsset, logEvent, listRoots, getSetting, queryAssets, duplicateGroups } from './db.js';
import { startJob, recycleToWindowsBin } from './jobs.js';
import { detectPrograms } from './components.js';

const st = (p) => fs.statSync(p, { bigint: true });
export const inodeKey = (p) => { try { const s = st(p); return `${s.dev}:${s.ino}`; } catch { return null; } };
const sha = (p) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256'); const s = fs.createReadStream(p);
  s.on('data', (b) => h.update(b)); s.on('end', () => resolve(h.digest('hex'))); s.on('error', reject);
});

/** Marque, pour chaque groupe de doublons, les copies déjà fusionnées (même fichier physique) et ce qui reste vraiment récupérable. */
export function annotateGroups(groups) {
  return groups.map((g) => {
    const keys = g.items.map((i) => inodeKey(i.abs_path));
    const distinct = new Set(keys.filter(Boolean));
    const items = g.items.map((i, n) => ({ ...i, physical: keys[n] }));
    const physicalCopies = distinct.size || g.items.length;
    return { ...g, items, merged: physicalCopies <= 1, physicalCopies, wasted: Math.max(0, physicalCopies - 1) * (g.size || 0) + (g.size || 0) };
  });
}

/** Fusionne les copies `ids` (la première est conservée). Renvoie un rapport par copie. */
export async function mergeCopies(db, ids) {
  const items = ids.map((id) => getAsset(db, id)).filter(Boolean);
  if (items.length < 2) throw new Error('Il faut au moins deux copies.');
  const keep = items[0];
  if (!fs.existsSync(keep.abs_path)) throw new Error(`Fichier absent : ${keep.abs_path}`);
  const kst = st(keep.abs_path); let keepHash = null; const report = [];
  for (const o of items.slice(1)) {
    const r = { id: o.id, path: o.abs_path, status: '', saved: 0 };
    try {
      if (!fs.existsSync(o.abs_path)) { r.status = 'absente'; report.push(r); continue; }
      const ost = st(o.abs_path);
      if (ost.dev === kst.dev && ost.ino === kst.ino) { r.status = 'déjà fusionnée'; report.push(r); continue; }
      if (ost.dev !== kst.dev) { r.status = 'autre disque : un lien dur est impossible'; report.push(r); continue; }
      if (ost.size !== kst.size) { r.status = 'taille différente : pas un doublon'; report.push(r); continue; }
      keepHash ||= await sha(keep.abs_path);
      if (await sha(o.abs_path) !== keepHash) { r.status = 'contenu différent : ignorée'; report.push(r); continue; }
      const tmp = `${o.abs_path}.paiz-lien`;
      try { fs.rmSync(tmp, { force: true }); fs.linkSync(keep.abs_path, tmp); fs.renameSync(tmp, o.abs_path); }
      catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* rien à nettoyer */ } throw e; }
      r.status = 'fusionnée'; r.saved = Number(ost.size);
      logEvent(db, 'dedupe', o.id, { keep: keep.abs_path, path: o.abs_path });
    } catch (e) { r.status = `échec : ${e.message}`; }
    report.push(r);
  }
  return { keep: keep.abs_path, report, saved: report.reduce((n, r) => n + r.saved, 0) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Fusion intelligente : PAIZ choisit la copie à garder et ce qu'il fait de chaque autre copie, avec des garde-fous.
//  • copie gardée : celle chargée dans le moteur, sinon celle d'un dossier « prêts à lancer », puis du dossier le plus actif
//    (modèle utilisé ou ajouté le plus récemment), puis le fichier le plus récent ;
//  • même disque : lien dur (le chemin reste valide pour tous les programmes, la place est rendue) ;
//  • autre disque : gardée si un programme l'attend là (ComfyUI, SwarmUI…), si elle est hors des dossiers PAIZ ou si elle sert
//    de sauvegarde (prête à lancer d'un côté, réserve de l'autre) ; sinon corbeille Windows (récupérable), seulement sur demande ;
//  • rien n'est touché sans comparaison complète du contenu (SHA-256) avec la copie gardée, jamais la copie chargée dans le
//    moteur, jamais la dernière copie.
const ROLE_RANK = { active: 3, store: 2, external: 1 };
const ROLE_FR = { active: 'prêts à lancer', store: 'réserve', external: 'dossier externe' };
const under = (p, dir) => { const a = path.resolve(p).toLowerCase(); const b = path.resolve(dir).toLowerCase().replace(/[\\/]+$/, ''); return a.startsWith(b + '\\') || a.startsWith(b + '/'); };
const sameFile = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function context(db) {
  const roots = new Map(listRoots(db).map((r) => [r.id, r]));
  let usage = {}; try { usage = JSON.parse(getSetting(db, 'models.usage', '{}')) || {}; } catch { /* illisible */ }
  const act = new Map(); // dossier -> date de la dernière activité (modèle utilisé ou ajouté)
  for (const a of queryAssets(db, { limit: 5000 }).items) {
    if (a.root_id == null) continue;
    const u = usage[`${String(a.file_name).toLowerCase()}|${a.size_bytes}`];
    const t = Math.max(u ? Date.parse(u.last) || 0 : 0, Date.parse(a.first_seen_at || '') || 0);
    if (t > (act.get(a.root_id) || 0)) act.set(a.root_id, t);
  }
  let programs = [];
  try { programs = JSON.parse(getSetting(db, 'components.programs', '[]')).filter((p) => p.status !== 'ignored'); } catch { /* aucun */ }
  // détectés automatiquement : seulement les programmes reconnus (ComfyUI, SwarmUI…), pas un dossier de modèles qui a des sous-dossiers clip/vae
  try { programs = programs.concat(detectPrograms(db).filter((p) => p.name && p.name !== path.basename(p.dir))); } catch { /* détection impossible */ }
  return { roots, act, programs };
}
const programOf = (ctx, p) => ctx.programs.find((x) => under(p, x.dir))?.name || null;

/** Plan pour un groupe de copies identiques. keepId : la copie à garder choisie à la main (sinon PAIZ choisit). */
export function planGroup(db, group, { loaded = null, keepId = null, ctx = context(db) } = {}) {
  const items = group.items.filter((i) => fs.existsSync(i.abs_path)).map((i) => {
    const r = ctx.roots.get(i.root_id) || null;
    let mt = 0; try { mt = fs.statSync(i.abs_path).mtimeMs; } catch { /* absent */ }
    return { ...i, role: r?.role || null, rootName: r?.name || null, activity: ctx.act.get(i.root_id) || 0, mt, program: programOf(ctx, i.abs_path), loaded: !!(loaded && sameFile(loaded, i.abs_path)), physical: inodeKey(i.abs_path) };
  });
  if (items.length < 2) return { ...group, items, keep: items[0] || null, keepWhy: [], actions: [], saves: 0, trashSaves: 0 };
  const rank = (x) => [x.id === Number(keepId) ? 1 : 0, x.loaded ? 1 : 0, ROLE_RANK[x.role] || 0, x.activity, x.mt];
  items.sort((a, b) => { const ra = rank(a); const rb = rank(b); for (let k = 0; k < ra.length; k++) if (ra[k] !== rb[k]) return rb[k] - ra[k]; return a.abs_path.length - b.abs_path.length; });
  const keep = items[0];
  const keepWhy = [];
  if (keep.id === Number(keepId)) keepWhy.push('choisie par toi');
  if (keep.loaded) keepWhy.push('chargée dans le moteur');
  if (keep.role) keepWhy.push(`dans « ${keep.rootName} » (${ROLE_FR[keep.role] || keep.role})`);
  if (items.slice(1).some((x) => (ROLE_RANK[x.role] || 0) === (ROLE_RANK[keep.role] || 0) && x.root_id !== keep.root_id && x.activity < keep.activity)) keepWhy.push('dossier le plus actif');
  if (!keepWhy.length) keepWhy.push('fichier le plus récent');
  let keepDev = null; try { keepDev = fs.statSync(keep.abs_path).dev; } catch { /* absent */ }
  const actions = items.slice(1).map((x) => {
    let dev = null; try { dev = fs.statSync(x.abs_path).dev; } catch { /* absent */ }
    const base = { id: x.id, path: x.abs_path };
    if (x.physical && x.physical === keep.physical) return { ...base, action: 'done', why: 'déjà fusionnée : même fichier sur le disque' };
    if (x.loaded) return { ...base, action: 'keep', why: 'chargée dans le moteur en ce moment' };
    if (dev === keepDev) return { ...base, action: 'link', why: 'même disque : lien dur, ce chemin continue de marcher', saves: x.size_bytes };
    if (x.program) return { ...base, action: 'keep', why: `autre disque, et ${x.program} l’attend à cet endroit` };
    if (!x.role) return { ...base, action: 'keep', why: 'autre disque, hors de tes dossiers PAIZ : un programme l’attend peut-être là' };
    if (x.role !== keep.role) return { ...base, action: 'keep', why: `autre disque : sert de sauvegarde (${ROLE_FR[x.role] || x.role})` };
    return { ...base, action: 'trash', why: `copie en trop sur un autre disque (${ROLE_FR[x.role] || x.role}) : corbeille Windows, récupérable`, saves: x.size_bytes };
  });
  return { ...group, items, keep, keepWhy, actions,
    saves: actions.filter((a) => a.action === 'link').reduce((n, a) => n + (a.saves || 0), 0),
    trashSaves: actions.filter((a) => a.action === 'trash').reduce((n, a) => n + (a.saves || 0), 0) };
}

export function planAll(db, { loaded = null, keep = {} } = {}) {
  const ctx = context(db);
  return annotateGroups(duplicateGroups(db)).map((g) => planGroup(db, g, { loaded, ctx, keepId: keep[g.hash] }));
}

/** Applique les plans des groupes `hashes` (keep : { hash: id } pour un choix à la main). trash : retire aussi les copies en trop sur un autre disque. */
export function startSmartMerge(db, { hashes = [], keep = {}, trash = false, loaded = () => null } = {}) {
  const want = new Set(hashes);
  const ctx = context(db);
  const groups = annotateGroups(duplicateGroups(db)).filter((g) => want.has(g.hash));
  if (!groups.length) throw new Error('Plus de doublon à fusionner.');
  return startJob('dedupe', `Fusion de ${groups.length} doublon(s)`, { hashes: groups.map((g) => g.hash), trash }, async (job) => {
    const done = []; const skipped = []; let saved = 0;
    job.progress.total = groups.length;
    for (const g0 of groups) {
      if (job.cancelled) break;
      const g = planGroup(db, g0, { loaded: loaded(), keepId: keep[g0.hash], ctx });
      job.progress.current = g.keep?.file_name || g0.hash;
      const todo = g.actions.filter((a) => a.action === 'link' || (trash && a.action === 'trash'));
      for (const a of g.actions) if (!todo.includes(a) && a.action !== 'done') skipped.push({ path: a.path, why: a.why });
      if (!todo.length) { job.progress.done++; continue; }
      try {
        // garde-fou 1 : contenu complet de la copie gardée, comparé à chaque copie avant d'y toucher
        if (!g.keep || !fs.existsSync(g.keep.abs_path)) throw new Error('la copie à garder a disparu');
        const keepHash = await sha(g.keep.abs_path);
        for (const a of todo) {
          try {
            const cur = loaded();
            if (cur && sameFile(cur, a.path)) { skipped.push({ path: a.path, why: 'chargée dans le moteur' }); continue; } // garde-fou 2
            if (!fs.existsSync(a.path)) { skipped.push({ path: a.path, why: 'absente' }); continue; }
            if (fs.statSync(a.path).size !== fs.statSync(g.keep.abs_path).size) { skipped.push({ path: a.path, why: 'taille différente : pas un doublon' }); continue; }
            if (await sha(a.path) !== keepHash) { skipped.push({ path: a.path, why: 'contenu différent : pas un doublon, rien touché' }); continue; }
            if (!fs.existsSync(g.keep.abs_path)) throw new Error('la copie à garder a disparu'); // garde-fou 3 : jamais la dernière copie
            const size = fs.statSync(a.path).size;
            if (a.action === 'link') {
              const tmp = `${a.path}.paiz-lien`;
              try { fs.rmSync(tmp, { force: true }); fs.linkSync(g.keep.abs_path, tmp); fs.renameSync(tmp, a.path); }
              catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* rien */ } throw e; }
              logEvent(db, 'dedupe', a.id, { keep: g.keep.abs_path, path: a.path, how: 'lien dur' });
            } else {
              const rb = await recycleToWindowsBin(a.path);
              if (!rb.ok) { skipped.push({ path: a.path, why: rb.nobin ? 'disque sans corbeille Windows : gardée' : `corbeille impossible : ${rb.reason}` }); continue; }
              db.prepare("UPDATE assets SET state = 'missing' WHERE id = ?").run(a.id);
              logEvent(db, 'dedupe', a.id, { keep: g.keep.abs_path, path: a.path, how: 'corbeille Windows' });
            }
            saved += size; done.push({ path: a.path, how: a.action });
          } catch (e) { skipped.push({ path: a.path, why: `échec : ${e.message}` }); }
        }
        db.prepare('UPDATE assets SET sha256 = ? WHERE id = ?').run(keepHash, g.keep.id);
      } catch (e) { skipped.push({ path: g.keep?.abs_path || '', why: e.message }); }
      job.progress.done++;
    }
    return { done, skipped, saved };
  });
}
