// « Écurie propre » : un repo de stockage rangé par type / base, avec ses traces.
//   <repo>/LLM/<famille>/<modèle>/…   <repo>/LoRA/<base>/…   <repo>/Checkpoints/<base>/…   <repo>/VAE/…   etc.
//   <repo>/_PAIZ/trace.json     : pour chaque fichier, d'où il vient (repo actif d'origine), taille, empreinte, base, titre…
//   <repo>/_PAIZ/configs/*.json : copie des listes de configuration (indications seulement, pas de modèles)
//   <repo>/_PAIZ/journal-*.json : journal de chaque rangement de l'existant, pour pouvoir l'annuler
// Rien n'est jamais effacé ici : on ne fait que déplacer (renommage sur le même disque, instantané) et on garde le journal.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getAsset, getRoot, listRoots, queryAssets, getSetting, setSetting, logEvent, deleteAssetRow } from './db.js';
import { MARKER } from './repomark.js';
import { allOrigins, modelKey } from './origins.js';
import { baseLabel } from './detect.js';
import { nowIso, fullHashFile } from './util.js';

export const META_DIR = '_PAIZ';
const CAT_DIR = { llm: 'LLM', checkpoint: 'Checkpoints', lora: 'LoRA', vae: 'VAE', controlnet: 'ControlNet', ipadapter: 'IP-Adapter', upscaler: 'Upscalers', clip: 'Encodeurs', embedding: 'Embeddings', faceid: 'FaceID', motion: 'Motion', onnx: 'ONNX', other: 'Autres' };
// dossiers « standard » d'une installation Stable Diffusion (SwarmUI) quand le repo actif n'a encore rien de ce type
const SD_STD = { checkpoint: 'Stable-Diffusion', lora: 'Lora', vae: 'VAE', controlnet: 'controlnet', clip: 'clip', upscaler: 'upscale_models', ipadapter: 'ipadapter', embedding: 'Embeddings' };
const IMAGE_CATS = new Set(Object.keys(SD_STD));

const safe = (s) => String(s ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const jget = (db, k, fb) => { try { const v = getSetting(db, k, null); return v == null ? fb : JSON.parse(v); } catch { return fb; } };
const jset = (db, k, v) => setSetting(db, k, JSON.stringify(v));

export const cleanRootIds = (db) => (jget(db, 'ecurie.clean', []) || []).map(Number);
export const isCleanRoot = (db, rootId) => cleanRootIds(db).includes(Number(rootId));
export function setCleanRoot(db, rootId, on) {
  const root = getRoot(db, rootId); if (!root) throw new Error('Repo inconnu.');
  if (on && root.role !== 'store') throw new Error('Seul un repo de stockage peut être une écurie propre.');
  const set = new Set(cleanRootIds(db)); if (on) set.add(root.id); else set.delete(root.id);
  jset(db, 'ecurie.clean', [...set]);
  return { rootId: root.id, clean: on };
}

// nom du modèle sans quantification ni numéro de morceau : les fichiers d'un même modèle (morceaux, mmproj) vont dans le même dossier
export function modelStem(fileName) {
  let s = String(fileName).replace(/\.[a-z0-9]+$/i, '');
  s = s.replace(/-\d{3,5}-of-\d{3,5}$/i, '').replace(/^mmproj[-_.]?/i, '');
  s = s.replace(/[-_.](?:UD[-_])?(?:I?Q\d(?:[-_][A-Z0-9]+)*|MXFP4(?:[-_]MOE)?|BF16|F16|F32|fp16|fp8)$/i, '');
  return safe(s) || safe(fileName);
}
// famille d'un LLM d'après l'architecture lue dans son en-tête GGUF (cache « models.moe ») quand le nom ne la dit pas
const ARCH_FAM = [[/^gemma/i, 'Gemma'], [/^qwen/i, 'Qwen'], [/^gpt-?oss/i, 'GPT-OSS'], [/^llama/i, 'Llama'], [/^mistral|^mixtral/i, 'Mistral'], [/^phi/i, 'Phi'], [/^deepseek/i, 'DeepSeek'], [/^glm|^chatglm/i, 'GLM'], [/^granite/i, 'Granite'], [/^olmo/i, 'OLMo'], [/^command|^cohere/i, 'Command'], [/^minimax/i, 'MiniMax'], [/^kimi/i, 'Kimi']];
const archFamily = (arch) => (arch ? (ARCH_FAM.find(([r]) => r.test(arch)) || [])[1] || null : null);
const withArch = (db, a) => { if (a.category !== 'llm' || a._arch) return a; const m = jget(db, 'models.moe', {})[`${String(a.file_name).toLowerCase()}|${a.size_bytes}`]; return m?.arch ? { ...a, _arch: m.arch } : a; };
const famOf = (a) => safe(baseLabel(a.base_model) || baseLabel(a.base_family) || a.base_model || a.base_family || 'Divers');

// Rangement d'une écurie propre (v2) :
//   LLM/<famille>/<modèle>/…                       un dossier par modèle (morceaux et mmproj ensemble)
//   Images/<Checkpoints|LoRA|VAE|…>/<base>/…        Stable Diffusion, Flux, Qwen-Image…
//   Video/<famille>/<type>/…                         Wan, LTX, Hunyuan…
//   Composants/<Encodeurs|ONNX>/…                    encodeurs de texte, CLIP, ONNX
//   Applis/<dossier de l'appli>/…                    fichiers d'une appli (Wan2GP…) qui attend SES sous-dossiers : structure gardée
//   A-trier/…                                        ce que PAIZ ne sait pas classer avec certitude (jamais deviné)
const IMG_DIR = { checkpoint: 'Checkpoints', lora: 'LoRA', vae: 'VAE', controlnet: 'ControlNet', ipadapter: 'IP-Adapter', upscaler: 'Upscalers', embedding: 'Embeddings', faceid: 'FaceID', motion: 'Motion' };
const VIDEO_FAM = /^(wan|ltx|hunyuan|mochi|cogvideo|svd|animatediff)/i;
const APP_TOP = /^(Autres|Applis)$/i;
const keepStructure = (a) => {
  const parts = String(a.rel_path || '').split(/[\\/]/).filter(Boolean);
  while (parts.length > 1 && (APP_TOP.test(parts[0]) || /^(installed-\d+|AI-MODELS)$/i.test(parts[0]))) parts.shift(); // anciens conteneurs
  return path.join('Applis', ...parts.map(safe));
};
export function cleanRel(a) {
  if (a.category === 'other' && /[\\/]/.test(String(a.rel_path || '').replace(/^(Autres|Applis)[\\/]/i, ''))) return keepStructure(a);
  const fam = famOf(a);
  if (a.category === 'llm') return path.join('LLM', fam === 'Divers' ? (archFamily(a._arch) || fam) : fam, modelStem(a.file_name), a.file_name);
  if (IMG_DIR[a.category]) {
    if (VIDEO_FAM.test(String(a.base_family || a.base_model || ''))) return path.join('Video', fam, IMG_DIR[a.category], a.file_name);
    return path.join('Images', IMG_DIR[a.category], fam, a.file_name);
  }
  if (a.category === 'clip') return path.join('Composants', 'Encodeurs', fam, a.file_name);
  if (a.category === 'onnx') return path.join('Composants', 'ONNX', a.file_name);
  return path.join('A-trier', a.file_name);
}

// où remettre un modèle de l'écurie propre dans un repo actif qui n'a pas gardé son adresse : le dossier que ce repo utilise déjà pour ce type
export function learnedDir(db, activeRoot, category) {
  const counts = new Map();
  for (const x of queryAssets(db, { rootId: String(activeRoot.id), category, limit: 5000 }).items) {
    const seg = String(x.rel_path || '').split(/[\\/]/); if (seg.length < 2) continue;
    counts.set(seg[0], (counts.get(seg[0]) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : (SD_STD[category] || null);
}
// destination exacte à imposer pour un modèle venant d'une écurie propre vers un repo actif (image seulement ; sinon null = comportement habituel)
export function activeDestFor(db, a, destRoot) {
  if (!a.root_id || !isCleanRoot(db, a.root_id) || destRoot?.role !== 'active') return null;
  if (a.category === 'llm') return path.join(destRoot.path, modelStem(a.file_name), a.file_name); // un dossier par modèle (les morceaux restent ensemble)
  if (a.category === 'other') {
    const parts = String(a.rel_path || '').split(/[\\/]/).filter(Boolean); if (APP_TOP.test(parts[0] || '')) parts.shift();
    if (/^wan2gp-ckpts$/i.test(parts[0] || '') && /(^|[\\/])ckpts$/i.test(destRoot.path)) parts.shift(); // le dossier « ckpts » de Wan2GP est déjà ce conteneur
    return parts.length ? path.join(destRoot.path, ...parts) : null;
  }
  if (!IMAGE_CATS.has(a.category)) return null;
  const dir = learnedDir(db, destRoot, a.category); if (!dir) return null;
  return path.join(destRoot.path, dir, a.file_name);
}
// destination exacte pour un modèle qui entre dans une écurie propre
export const cleanDestFor = (db, a, destRoot) => (destRoot && isCleanRoot(db, destRoot.id) ? path.join(destRoot.path, cleanRel(withArch(db, a))) : null);

const driveOf = (p) => (/^[A-Za-z]:/.test(p) ? p.slice(0, 2).toUpperCase() : path.parse(path.resolve(p)).root.toLowerCase());
const IGNORE_COMPANION = new RegExp(`^(${MARKER.replace('.', '\\.')}|CATALOGUE\\.md|desktop\\.ini|thumbs\\.db)$`, 'i');

// ---------------------------------------------------------------- plan de rangement (sur place, ou vers une autre écurie du même disque)
// into : le repo de destination (par défaut le repo lui-même). Même disque obligatoire : tout se fait par renommage, instantané.
export function planReorg(db, rootId, { into = rootId } = {}) {
  const root = getRoot(db, rootId); if (!root) throw new Error('Repo inconnu.');
  const dest = getRoot(db, into); if (!dest) throw new Error('Repo de destination inconnu.');
  if (driveOf(root.path) !== driveOf(dest.path)) throw new Error('La destination doit être sur le même disque (rangement par renommage, instantané).');
  const items = queryAssets(db, { rootId: String(root.id), limit: 5000 }).items.filter((a) => a.state === 'present');
  const byHash = new Map(); // empreinte → tous les fichiers du catalogue (tous repos)
  for (const a of queryAssets(db, { limit: 5000 }).items) if (a.state === 'present' && a.quick_hash) { if (!byHash.has(a.quick_hash)) byHash.set(a.quick_hash, []); byHash.get(a.quick_hash).push(a); }
  const taken = new Map(); // destination (minuscules) → id : évite deux fichiers au même endroit
  const primary = new Map(); // empreinte+taille → premier fichier de ce contenu rangé dans ce repo
  const moves = []; const stay = []; const dupes = []; const merges = [];
  const copyName = (a) => (/(^|[-_ .(])(cop(y|ie)|copie de|backup|old)([-_ .)]|$)|\(\d+\)|- Copie/i.test(a.file_name) ? 1 : 0); // l'original avant ses copies
  for (const a of [...items].sort((x, y) => copyName(x) - copyName(y) || x.id - y.id)) {
    const rel = cleanRel(withArch(db, a)); const to = path.join(dest.path, rel);
    const twins = (byHash.get(a.quick_hash) || []).filter((x) => x.id !== a.id && x.size_bytes === a.size_bytes);
    const elsewhere = twins.filter((x) => x.root_id !== root.id);
    const info = { id: a.id, name: a.title || a.file_name, file: a.file_name, category: a.category, size: a.size_bytes, from: a.abs_path, to, rel, top: rel.split(/[\\/]/)[0],
      copyOf: elsewhere.map((x) => ({ id: x.id, where: x.root_name || (x.abs_path || '').slice(0, 40), role: x.root_role, path: x.abs_path })) };
    const key = a.quick_hash ? `${a.quick_hash}|${a.size_bytes}` : null;
    // même contenu déjà rangé depuis ce repo : un seul exemplaire suit, l'autre nom est fusionné (contenu vérifié à l'application)
    if (key && primary.has(key)) { merges.push({ ...info, into: primary.get(key) }); continue; }
    if (norm(a.abs_path) === norm(to)) { stay.push(info); if (key) primary.set(key, { id: a.id, to }); taken.set(norm(to), a.id); continue; }
    if (taken.has(norm(to)) || fs.existsSync(to)) { dupes.push({ ...info, twins: [], conflict: true }); continue; }
    taken.set(norm(to), a.id); moves.push(info); if (key) primary.set(key, { id: a.id, to });
  }
  const tops = {}; for (const m of [...moves, ...stay.map((s) => ({ ...s }))]) tops[m.top] = (tops[m.top] || 0) + 1;
  return { root: { id: root.id, name: root.name, path: root.path }, dest: { id: dest.id, name: dest.name, path: dest.path }, moves, stay: stay.length, dupes, merges, tops,
    toSort: moves.filter((m) => m.top === 'A-trier').map((m) => m.from), bytes: moves.reduce((n, m) => n + (m.size || 0), 0) };
}

// chemins enregistrés ailleurs dans PAIZ (étagère, configurations, origines…) : remplacés partout où ils apparaissent
function rewriteSettingPaths(db, pairs) {
  if (!pairs.length) return 0;
  const enc = (p) => JSON.stringify(p).slice(1, -1);
  let n = 0;
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    let v = String(row.value ?? ''); const before = v;
    for (const [from, to] of pairs) { v = v.split(enc(from)).join(enc(to)); }
    if (v !== before) { db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(v, row.key); n++; }
  }
  return n;
}
const sameInode = (a, b) => { try { const x = fs.statSync(a, { bigint: true }); const y = fs.statSync(b, { bigint: true }); return x.dev === y.dev && x.ino === y.ino; } catch { return false; } };

// applique (seulement les ids choisis, destinations RECALCULÉES ici) ; journal pour annuler ; renommage = instantané (même disque)
export async function applyReorg(db, rootId, ids, { into = rootId } = {}) {
  const plan = planReorg(db, rootId, { into }); const want = ids ? new Set(ids.map(Number)) : null;
  const todo = plan.moves.filter((m) => !want || want.has(m.id));
  const merges = plan.merges.filter((m) => !want || want.has(m.id));
  if (!todo.length && !merges.length) throw new Error('Rien à ranger.');
  const root = getRoot(db, rootId); const dest = getRoot(db, into); const journal = []; const failed = [];
  // fichiers d'accompagnement (tokenizer.json, config.json…) : ils suivent leur modèle si tout le dossier va au même endroit
  const indexed = new Set(queryAssets(db, { limit: 20000 }).items.map((a) => norm(a.abs_path)));
  const dirDest = new Map();
  for (const m of todo) { const k = norm(path.dirname(m.from)); const d = path.dirname(m.to); if (!dirDest.has(k)) dirDest.set(k, d); else if (norm(dirDest.get(k)) !== norm(d)) dirDest.set(k, null); }
  for (const m of todo) {
    try {
      if (!fs.existsSync(m.from)) throw new Error('fichier absent');
      if (fs.existsSync(m.to)) throw new Error('destination déjà occupée');
      await fsp.mkdir(path.dirname(m.to), { recursive: true });
      await fsp.rename(m.from, m.to);
      db.prepare('UPDATE assets SET abs_path = ?, rel_path = ?, root_id = ?, last_seen_at = ? WHERE id = ?').run(m.to, path.relative(dest.path, m.to), dest.id, nowIso(), m.id);
      logEvent(db, 'move', m.id, { from: m.from, to: m.to, mode: 'reorg' });
      journal.push({ id: m.id, from: m.from, to: m.to, fromRoot: root.id, toRoot: dest.id });
    } catch (e) { failed.push({ id: m.id, file: m.file, error: e.message }); }
  }
  for (const [srcDir, dstDir] of dirDest) {
    if (!dstDir || norm(srcDir) === norm(root.path) || norm(srcDir).includes(`/${META_DIR.toLowerCase()}`)) continue;
    let entries = []; try { entries = await fsp.readdir(srcDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const from = path.join(srcDir, e.name);
      if (!e.isFile() || indexed.has(norm(from)) || IGNORE_COMPANION.test(e.name)) continue;
      const to = path.join(dstDir, e.name);
      try { if (fs.existsSync(to)) throw new Error('destination occupée'); await fsp.rename(from, to); journal.push({ companion: true, from, to }); }
      catch (err) { failed.push({ file: e.name, error: `fichier d'accompagnement : ${err.message}` }); }
    }
  }
  // même contenu présent deux fois dans le repo : vérifié octet par octet, puis un seul exemplaire (l'autre nom est retiré)
  for (const m of merges) {
    try {
      const keep = getAsset(db, m.into.id); if (!keep || !fs.existsSync(keep.abs_path)) throw new Error('l’exemplaire gardé est introuvable');
      if (!fs.existsSync(m.from)) throw new Error('fichier absent');
      const linked = sameInode(m.from, keep.abs_path);
      if (!linked && (await fullHashFile(m.from)) !== (await fullHashFile(keep.abs_path))) throw new Error('contenu différent : laissé en place');
      // contenu identique vérifié : retirer ce nom ne perd aucune donnée (l'exemplaire gardé a les mêmes octets) ; l'annulation le recrée par lien dur
      await fsp.unlink(m.from);
      deleteAssetRow(db, m.id);
      logEvent(db, 'dedupe', m.id, { keep: keep.abs_path, path: m.from, how: linked ? 'nom en double retiré (lien dur)' : 'copie identique retirée (contenu vérifié)' });
      journal.push({ merged: true, id: m.id, from: m.from, keep: keep.abs_path, how: 'link' });
      // ses fichiers d'accompagnement en double (même nom, même taille déjà rangés) partent avec lui
      const sib = path.dirname(m.from); const kd = path.dirname(keep.abs_path);
      for (const e of (await fsp.readdir(sib, { withFileTypes: true }).catch(() => []))) {
        const f = path.join(sib, e.name); const g = path.join(kd, e.name);
        if (!e.isFile() || indexed.has(norm(f)) || IGNORE_COMPANION.test(e.name) || !fs.existsSync(g) || fs.statSync(f).size !== fs.statSync(g).size) continue;
        if ((await fullHashFile(f)) !== (await fullHashFile(g))) continue;
        await fsp.unlink(f); journal.push({ merged: true, companion: true, from: f, keep: g, how: 'link' });
      }
    } catch (e) { failed.push({ id: m.id, file: m.file, error: e.message }); }
  }
  const moved = journal.filter((j) => !j.merged && !j.companion);
  // liens symboliques connus de PAIZ vers un modèle déplacé : repointés (sinon ils casseraient en silence)
  for (const j of moved) {
    for (const l of db.prepare("SELECT id, path FROM links WHERE asset_id = ? AND kind = 'symlink'").all(j.id)) {
      try { const st = fs.lstatSync(l.path); if (!st.isSymbolicLink()) continue; const tmp = `${l.path}.paiz-lien`; fs.symlinkSync(j.to, tmp, 'file'); fs.renameSync(tmp, l.path); } // nouveau lien d'abord : l'ancien reste si Windows refuse
      catch (e) {
        failed.push({ file: l.path, error: e.code === 'EPERM' ? `lien vers le modèle à refaire (Windows demande les droits administrateur) : ${j.to}` : `lien : ${e.message}` });
      }
    }
  }
  rewriteSettingPaths(db, journal.filter((j) => !j.merged).map((j) => [j.from, j.to]).concat(journal.filter((j) => j.merged && !j.companion).map((j) => [j.from, j.keep])));
  const removed = await pruneEmptyDirs(root.path, journal.map((j) => path.dirname(j.from)));
  let journalFile = null;
  if (journal.length) {
    await fsp.mkdir(path.join(dest.path, META_DIR), { recursive: true });
    journalFile = path.join(dest.path, META_DIR, `journal-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await fsp.writeFile(journalFile, JSON.stringify({ at: nowIso(), fromRoot: { id: root.id, path: root.path }, toRoot: { id: dest.id, path: dest.path }, moves: journal, removedDirs: removed }, null, 2));
  }
  let swept = { moved: 0 }; try { swept = await sweepLeftovers(db, root.id, { into: dest.id }); } catch { /* sans effet sur le rangement */ }
  if (dest.id !== root.id) { try { setCleanRoot(db, dest.id, true); } catch { /* repo actif : pas d'écurie propre */ } await writeTrace(db, root.id); }
  await writeTrace(db, dest.id);
  return { moved: moved.length, companions: journal.filter((j) => j.companion && !j.merged).length + swept.moved, merged: journal.filter((j) => j.merged && !j.companion).length, failed, journalFile };
}

// remet en place le dernier rangement (fichiers toujours à l'endroit où le journal les a mis)
export async function undoLast(db, rootId) {
  const root = getRoot(db, rootId); if (!root) throw new Error('Repo inconnu.');
  const dir = path.join(root.path, META_DIR); let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => /^journal-.*\.json$/.test(f) && !f.endsWith('.annule.json')).sort(); } catch { /* pas de dossier */ }
  if (!files.length) throw new Error('Aucun rangement à annuler.');
  const file = path.join(dir, files[files.length - 1]); const j = JSON.parse(await fsp.readFile(file, 'utf8'));
  let back = 0; const failed = []; const pairs = [];
  for (const m of [...j.moves].reverse()) {
    try {
      if (m.merged) {
        if (m.how === 'link' && fs.existsSync(m.keep)) { await fsp.mkdir(path.dirname(m.from), { recursive: true }); fs.linkSync(m.keep, m.from); if (!m.companion) back++; }
        else failed.push({ file: m.from, error: 'exemplaire gardé introuvable : copie non recréée' });
        continue;
      }
      if (!fs.existsSync(m.to)) throw new Error('le fichier n\'est plus là');
      if (fs.existsSync(m.from)) throw new Error('l\'ancienne place est occupée');
      await fsp.mkdir(path.dirname(m.from), { recursive: true });
      await fsp.rename(m.to, m.from); pairs.push([m.to, m.from]);
      if (!m.companion) {
        const back2 = getRoot(db, m.fromRoot ?? root.id) || root;
        db.prepare('UPDATE assets SET abs_path = ?, rel_path = ?, root_id = ?, last_seen_at = ? WHERE id = ?').run(m.from, path.relative(back2.path, m.from), back2.id, nowIso(), m.id);
        logEvent(db, 'move', m.id, { from: m.to, to: m.from, mode: 'reorg-undo' }); back++;
      }
    } catch (e) { failed.push({ id: m.id, file: m.from, error: e.message }); }
  }
  rewriteSettingPaths(db, pairs);
  await pruneEmptyDirs(root.path, j.moves.map((m) => path.dirname(m.to || m.keep)));
  await fsp.rename(file, file.replace(/\.json$/, '.annule.json'));
  await writeTrace(db, rootId); if (j.fromRoot?.id && j.fromRoot.id !== root.id) await writeTrace(db, j.fromRoot.id).catch(() => null);
  return { restored: back, failed, note: 'Les modèles retirés en double (liens durs) sont recréés ; une scan relit les dossiers.' };
}

// supprime seulement les dossiers VIDES laissés derrière (jamais un dossier qui contient quelque chose), en remontant jusqu'à la racine du repo
async function pruneEmptyDirs(rootPath, dirs) {
  const removed = []; const seen = new Set(); const top = norm(rootPath);
  for (let d of dirs) {
    while (d && norm(d).startsWith(`${top}/`) && !seen.has(norm(d))) {
      seen.add(norm(d));
      try { if ((await fsp.readdir(d)).length) break; await fsp.rmdir(d); removed.push(d); } catch { break; }
      d = path.dirname(d);
    }
  }
  return removed;
}

// ---------------------------------------------------------------- traces et copies des configurations
export async function writeTrace(db, rootId) {
  const root = getRoot(db, rootId); if (!root || !fs.existsSync(root.path)) return null;
  try { importCatalogue(db, rootId); } catch { /* catalogue illisible : on le réécrit */ }
  const origins = allOrigins(db); const files = {};
  for (const a of queryAssets(db, { rootId: String(root.id), limit: 5000 }).items) {
    if (a.state !== 'present') continue;
    const o = origins[modelKey(a)];
    files[path.relative(root.path, a.abs_path).replace(/\\/g, '/')] = { titre: a.title || null, type: a.category, base: a.base_model || a.base_family || null, taille: a.size_bytes, empreinte: a.quick_hash || null,
      origine: o ? { repo: o.rootName, chemin: o.path, rangeLe: o.at } : null };
  }
  const meta = path.join(root.path, META_DIR); const cfg = path.join(meta, 'configs');
  await fsp.mkdir(cfg, { recursive: true });
  await fsp.writeFile(path.join(meta, 'trace.json'), JSON.stringify({ misAJour: nowIso(), repo: root.name, fichiers: files }, null, 2));
  // listes de configuration : seulement les indications (quel modèle, quel repo), jamais les modèles eux-mêmes
  const keep = { 'engine.confs': 'configurations-moteur', 'engine.needs': 'fichiers-associes', 'engine.origins': 'origines', 'hub.origins': 'origines-decouvrir' };
  for (const [key, name] of Object.entries(keep)) { const v = getSetting(db, key, null); if (v) await fsp.writeFile(path.join(cfg, `${name}.json`), v); }
  try { writeCatalogue(db, rootId); } catch { /* le catalogue n'empêche jamais la trace */ }
  return { file: path.join(meta, 'trace.json'), count: Object.keys(files).length };
}
// après un déplacement vers / depuis une écurie propre : met à jour sa trace (sans jamais faire échouer le déplacement)
export function traceAfterMove(db, rootIds) {
  const clean = new Set(cleanRootIds(db));
  for (const id of new Set(rootIds.filter((x) => x != null))) if (clean.has(Number(id))) writeTrace(db, id).catch(() => {});
}

export function ecurieStatus(db) {
  const clean = new Set(cleanRootIds(db));
  return { roots: listRoots(db).filter((r) => r.role === 'store').map((r) => ({ id: r.id, name: r.name, path: r.path, clean: clean.has(r.id), hasTrace: fs.existsSync(path.join(r.path, META_DIR, 'trace.json')) })) };
}

// ---------------------------------------------------------------- CATALOGUE.md : le doc de suivi lisible d'une écurie
// Réécrit par PAIZ à chaque passage. Deux lignes par modèle sont à toi : « Notes : » et « Catégorie : ». PAIZ les relit avant de
// réécrire le fichier : une note s'affiche dans PAIZ (fiche du modèle), une catégorie corrigée change son classement au prochain rangement.
export const CATALOGUE = 'CATALOGUE.md';
const CAT_FR = { llm: 'LLM', checkpoint: 'Checkpoint', lora: 'LoRA', vae: 'VAE', controlnet: 'ControlNet', ipadapter: 'IP-Adapter', upscaler: 'Upscaler', clip: 'Encodeur', embedding: 'Embedding', faceid: 'FaceID', motion: 'Motion', onnx: 'ONNX', other: 'Autre' };
const CAT_FROM = Object.fromEntries(Object.entries(CAT_FR).map(([k, v]) => [v.toLowerCase(), k]).concat(Object.keys(CAT_FR).map((k) => [k, k])));
const gb = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} Go` : `${Math.max(1, Math.round(n / 1024 ** 2))} Mo`);
const day = (t) => (t ? String(t).slice(0, 10) : '—');
const quantOf = (f) => (String(f).match(/(?:^|[-_.])((?:UD[-_])?I?Q\d(?:_[A-Z0-9]+)*|MXFP4|BF16|F16|F32|fp16|fp8(?:_e4m3fn)?|int8|nf4)(?=[-_.]|$)/i) || [])[1] || null;

/** Relit les lignes « Notes : » et « Catégorie : » modifiées à la main et les reporte dans PAIZ. */
export function importCatalogue(db, rootId) {
  const root = getRoot(db, rootId); if (!root) return { notes: 0, categories: 0 };
  let txt; try { txt = fs.readFileSync(path.join(root.path, CATALOGUE), 'utf8'); } catch { return { notes: 0, categories: 0 }; }
  const byRel = new Map(queryAssets(db, { rootId: String(root.id), limit: 5000 }).items.map((a) => [norm(path.relative(root.path, a.abs_path)), a]));
  let notes = 0; let categories = 0;
  for (const block of txt.split(/\n(?=### )/)) {
    const rel = (block.match(/^- Fichier : `([^`]+)`/m) || [])[1]; if (!rel) continue;
    const a = byRel.get(norm(rel)); if (!a) continue;
    const note = ((block.match(/^- Notes : ?(.*)$/m) || [])[1] || '').trim();
    if (note !== (a.notes || '').trim() && !(note === '' && !a.notes)) { db.prepare('UPDATE assets SET notes = ? WHERE id = ?').run(note || null, a.id); notes++; }
    const cat = CAT_FROM[((block.match(/^- Catégorie : ?(.*)$/m) || [])[1] || '').trim().toLowerCase()];
    if (cat && cat !== a.category) { db.prepare('UPDATE assets SET category = ? WHERE id = ?').run(cat, a.id); logEvent(db, 'edit', a.id, { category: cat, from: 'CATALOGUE.md' }); categories++; }
  }
  return { notes, categories };
}

/** Écrit CATALOGUE.md : par rayon, chaque modèle avec ses métadonnées, son arrivée, son origine, ses usages et qui l'utilise. */
export function writeCatalogue(db, rootId) {
  const root = getRoot(db, rootId); if (!root || !fs.existsSync(root.path)) return null;
  const items = queryAssets(db, { rootId: String(root.id), limit: 5000 }).items.filter((a) => a.state === 'present');
  const usage = jget(db, 'models.usage', {}); const sources = jget(db, 'models.sources', {}); const hub = jget(db, 'hub.origins', {});
  const moe = jget(db, 'models.moe', {}); const links = jget(db, 'components.links', []); const origins = allOrigins(db);
  const groups = new Map();
  for (const a of items) {
    const rel = path.relative(root.path, a.abs_path); const parts = rel.split(/[\\/]/);
    const shelf = parts.length > 2 ? parts.slice(0, Math.min(3, parts.length - 1)).join(' / ') : parts.length > 1 ? parts[0] : 'Racine';
    if (!groups.has(shelf)) groups.set(shelf, []); groups.get(shelf).push({ a, rel });
  }
  const total = items.reduce((n, a) => n + (a.size_bytes || 0), 0);
  const out = [`# Catalogue — ${root.name}`, '',
    `_Mis à jour par PAIZ le ${nowIso().slice(0, 16).replace('T', ' à ')} · ${items.length} modèle(s) · ${gb(total)} · dossier \`${root.path}\`_`, '',
    '> Ce fichier est réécrit par PAIZ. Deux lignes par modèle sont à toi : **Notes** (affichée dans PAIZ) et **Catégorie** (LLM, Checkpoint, LoRA, VAE, Encodeur, ONNX, Upscaler, ControlNet, Autre…).',
    '> PAIZ les relit avant chaque mise à jour. Le reste est recalculé.', ''];
  for (const shelf of [...groups.keys()].sort((x, y) => x.localeCompare(y))) {
    const list = groups.get(shelf).sort((x, y) => x.rel.localeCompare(y.rel));
    out.push(`## ${shelf}  (${list.length} · ${gb(list.reduce((n, x) => n + (x.a.size_bytes || 0), 0))})`, '');
    for (const { a, rel } of list) {
      const k = `${String(a.file_name).toLowerCase()}|${a.size_bytes}`; const u = usage[k]; const s = sources[k]; const m = moe[k];
      const o = origins[modelKey(a)];
      const progs = Object.entries(u?.programs || {}).map(([p, v]) => `${p} ×${v.n}`);
      const used = links.filter((l) => norm(l.source) === norm(a.abs_path)).map((l) => l.target);
      const meta = [gb(a.size_bytes), quantOf(a.file_name), m?.experts ? (m.moe ? `MoE ${m.used || '?'}/${m.experts} experts` : 'dense') : null, a.base_model || a.base_family || null].filter(Boolean).join(' · ');
      out.push(`### ${a.title || a.file_name}`,
        `- Fichier : \`${rel}\``,
        `- Infos : ${meta}`,
        `- Arrivé le : ${day(s?.downloadedAt || a.first_seen_at)}${s?.repo || hub[String(a.file_name).toLowerCase()] ? ` · origine : ${s?.repo || hub[String(a.file_name).toLowerCase()]}` : ''}${s?.how ? ` (${s.how})` : ''}${o ? ` · rangé depuis « ${o.rootName} » le ${day(o.at)}` : ''}`,
        `- Usages : ${u ? `${u.n} · dernier le ${day(u.last)}${progs.length ? ` · ${progs.join(', ')}` : ''}` : 'aucun vu par PAIZ'}`,
        ...(used.length ? [`- Lié dans : ${used.map((t) => `\`${t}\``).join(', ')}`] : []),
        `- Empreinte : ${a.sha256 ? `sha256 ${a.sha256.slice(0, 16)}…` : a.quick_hash ? `rapide ${String(a.quick_hash).slice(0, 12)}` : '—'}`,
        `- Catégorie : ${CAT_FR[a.category] || a.category}`,
        `- Notes : ${(a.notes || '').replace(/\r?\n/g, ' ')}`, '');
    }
  }
  fs.writeFileSync(path.join(root.path, CATALOGUE), out.join('\n'));
  return { file: path.join(root.path, CATALOGUE), count: items.length };
}

// Fichiers restés derrière (tokenizer, config…) dont le dossier existe dans l'écurie rangée, même structure d'appli :
// ils rejoignent leur modèle. Exemple : installed-2026/AI-MODELS/WAN2GP-CKPTS/Qwen3/tokenizer.json → Applis/WAN2GP-CKPTS/Qwen3/.
// Rien n'est écrasé ; journal à part (annulable comme un rangement).
export async function sweepLeftovers(db, rootId, { into = rootId } = {}) {
  const root = getRoot(db, rootId); const dest = getRoot(db, into); if (!root || !dest) throw new Error('Repo inconnu.');
  if (driveOf(root.path) !== driveOf(dest.path)) return { moved: 0 };
  const indexed = new Set(queryAssets(db, { limit: 20000 }).items.map((a) => norm(a.abs_path)));
  const out = []; const failed = [];
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== META_DIR) await walk(f); continue; }
      if (!e.isFile() || indexed.has(norm(f)) || IGNORE_COMPANION.test(e.name) || norm(d) === norm(root.path)) continue;
      const parts = path.relative(root.path, d).split(/[\\/]/).filter(Boolean);
      while (parts.length > 1 && (APP_TOP.test(parts[0]) || /^(installed-\d+|AI-MODELS)$/i.test(parts[0]))) parts.shift();
      const toDir = path.join(dest.path, 'Applis', ...parts.map(safe));
      // seulement vers un dossier d'appli qui existe déjà (ou son sous-dossier, ex. le tokenizer « xlm-roberta-large » de WAN2GP-CKPTS)
      if (norm(toDir) === norm(d) || (!fs.existsSync(toDir) && (parts.length < 2 || !fs.existsSync(path.dirname(toDir))))) continue;
      await fsp.mkdir(toDir, { recursive: true });
      const to = path.join(toDir, e.name);
      try { if (fs.existsSync(to)) throw new Error('déjà présent à la destination'); await fsp.rename(f, to); out.push({ companion: true, from: f, to }); }
      catch (err) { failed.push({ file: f, error: err.message }); }
    }
  };
  await walk(root.path);
  if (out.length) {
    const removed = await pruneEmptyDirs(root.path, out.map((j) => path.dirname(j.from)));
    await fsp.mkdir(path.join(dest.path, META_DIR), { recursive: true });
    await fsp.writeFile(path.join(dest.path, META_DIR, `journal-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ at: nowIso(), fromRoot: { id: root.id, path: root.path }, toRoot: { id: dest.id, path: dest.path }, moves: out, removedDirs: removed, kind: 'accompagnement' }, null, 2));
  }
  return { moved: out.length, failed };
}
