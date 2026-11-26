// Composants partagés (encodeurs de texte, VAE, CLIP vision…) : un seul exemplaire sur disque, rendu visible dans le dossier de chaque programme IA
// qui l'attend (lien dur sur le même disque, lien symbolique entre disques), pour que ces programmes ne le re-téléchargent pas.
// Tout est réversible : « restaurer » remplace un lien par une vraie copie du fichier, dans un programme précis.
import fs from 'node:fs';
import path from 'node:path';
import { getSetting, setSetting, queryAssets, logEvent } from './db.js';

const PKEY = 'components.programs'; // [{ dir, name, status: 'accepted' | 'ignored' }]
const LKEY = 'components.links';    // [{ target, source, method, at }]
const SUBS = ['checkpoints', 'diffusion_models', 'unet', 'loras', 'lora', 'vae', 'clip', 'text_encoders', 'clip_vision', 'controlnet', 'embeddings', 'upscale_models'];
const STRONG = new Set(['clip', 'text_encoders', 'vae', 'clip_vision', 'diffusion_models', 'checkpoints', 'unet', 'loras', 'lora', 'controlnet']);
const EXPECT = { 'text-encoder': ['text_encoders', 'clip'], vae: ['vae'], 'clip-vision': ['clip_vision'] };
const rd = (db, k) => { try { const v = JSON.parse(getSetting(db, k, '[]')); return Array.isArray(v) ? v : []; } catch { return []; } };
const wr = (db, k, v) => setSetting(db, k, JSON.stringify(v));
const split = (p) => String(p).split(/[\\/]+/).filter(Boolean);
const guess = (dir) => { const l = dir.toLowerCase(); return /swarm/.test(l) ? 'SwarmUI' : /comfy/.test(l) ? 'ComfyUI' : /forge/.test(l) ? 'Forge' : /automatic|a1111|webui/.test(l) ? 'Automatic1111' : /invoke/.test(l) ? 'InvokeAI' : /wan2gp/.test(l) ? 'Wan2GP' : path.basename(dir) || dir; };

/** Dossiers qui ressemblent à la racine de modèles d'un programme IA (plusieurs sous-dossiers typiques : clip, vae, text_encoders…). */
export function detectPrograms(db) {
  const known = new Set(rd(db, PKEY).map((p) => p.dir.toLowerCase()));
  const found = new Map();
  for (const a of queryAssets(db, { limit: 20000 }).items) {
    if (a.state !== 'present') continue;
    const segs = split(a.abs_path); const isUnc = a.abs_path.startsWith('\\\\');
    for (let i = 0; i < segs.length - 2; i++) {
      const sub = segs[i + 1].toLowerCase(); if (!SUBS.includes(sub)) continue;
      const dir = isUnc ? `\\\\${segs.slice(0, i + 1).join('\\')}` : (/^[a-z]:$/i.test(segs[0]) ? `${segs[0]}\\${segs.slice(1, i + 1).join('\\')}`.replace(/\\$/, '') : segs.slice(0, i + 1).join('\\'));
      const e = found.get(dir.toLowerCase()) || { dir, subs: new Set(), n: 0 }; e.subs.add(sub); e.n++; found.set(dir.toLowerCase(), e); break;
    }
  }
  for (const e of found.values()) { try { for (const d of fs.readdirSync(e.dir, { withFileTypes: true })) if (d.isDirectory() && SUBS.includes(d.name.toLowerCase())) e.subs.add(d.name.toLowerCase()); } catch { /* dossier illisible */ } }
  return [...found.values()].filter((e) => [...e.subs].filter((s) => STRONG.has(s)).length >= 2 && !known.has(e.dir.toLowerCase()))
    .map((e) => ({ dir: e.dir, name: guess(e.dir), subs: [...e.subs].sort(), files: e.n })).sort((a, b) => b.files - a.files);
}
export const setProgram = (db, dir, name, status) => {
  const l = rd(db, PKEY).filter((p) => p.dir.toLowerCase() !== String(dir).toLowerCase());
  if (status !== 'remove') l.push({ dir, name: name || guess(dir), status });
  wr(db, PKEY, l); return l;
};

const kindOf = (a) => {
  if (!/\.(safetensors|sft|pt|bin)$/i.test(a.file_name)) return null;
  const n = a.file_name.toLowerCase();
  if (/clip[-_]?vision|vision_h|clip-vit|image_encoder/.test(n)) return 'clip-vision';
  if (a.category === 'vae' || /(^|[-_.])vae([-_.]|$)|^ae\.safetensors$/.test(n)) return 'vae';
  if (a.category === 'clip' || /^(clip_[lg]|t5xxl|umt5|qwen_3_|qwen_2\.5_vl|byt5|text_enc)/.test(n)) return 'text-encoder';
  return null;
};
const lst = (p) => { try { return fs.lstatSync(p, { bigint: true }); } catch { return null; } };
function stateOf(p) {
  const s = lst(p); if (!s) return 'missing';
  if (s.isSymbolicLink()) return 'symlink';
  return s.nlink > 1n ? 'hardlink' : 'real';
}

/** Rapport : programmes acceptés, candidats détectés, composants et leur présence dans chaque programme. */
export function componentsReport(db) {
  const programs = rd(db, PKEY).filter((p) => p.status === 'accepted');
  const groups = new Map();
  for (const a of queryAssets(db, { limit: 20000 }).items) {
    if (a.state !== 'present') continue; const kind = kindOf(a); if (!kind) continue;
    const k = `${a.file_name.toLowerCase()}|${a.size_bytes}`; const g = groups.get(k) || { key: k, file_name: a.file_name, size: a.size_bytes, kind, copies: [] };
    g.copies.push({ id: a.id, path: a.abs_path }); groups.set(k, g);
  }
  const components = [...groups.values()].map((g) => {
    const canonical = g.copies.find((c) => stateOf(c.path) === 'real') || g.copies[0];
    const places = [];
    for (const p of programs) for (const sub of EXPECT[g.kind]) {
      if (!fs.existsSync(path.join(p.dir, sub))) continue;
      const target = path.join(p.dir, sub, g.file_name);
      places.push({ program: p.name, dir: p.dir, sub, target, state: stateOf(target) });
    }
    return { key: g.key, file_name: g.file_name, size: g.size, kind: g.kind, canonical: canonical.path, copies: g.copies.length, places };
  }).filter((c) => c.places.length).sort((a, b) => b.size - a.size);
  const missing = components.reduce((n, c) => n + c.places.filter((p) => p.state === 'missing').length, 0);
  return { programs, candidates: detectPrograms(db), components, missing, links: rd(db, LKEY).length };
}

/** Rend un composant visible dans un dossier de programme : lien dur (même disque) ou symbolique (autre disque). Ne remplace jamais un fichier existant. */
export function provision(db, source, target) {
  if (!fs.existsSync(source)) throw new Error(`Exemplaire introuvable : ${source}`);
  if (fs.existsSync(target) || lst(target)) throw new Error(`Déjà présent : ${target}`);
  if (!fs.existsSync(path.dirname(target))) throw new Error(`Dossier du programme absent : ${path.dirname(target)}`);
  let method = 'hardlink';
  try { fs.linkSync(source, target); } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
    fs.symlinkSync(source, target, 'file'); method = 'symlink';
  }
  const l = rd(db, LKEY).filter((x) => x.target.toLowerCase() !== target.toLowerCase()); l.push({ target, source, method, at: new Date().toISOString() }); wr(db, LKEY, l);
  logEvent(db, 'component-link', null, { target, source, method });
  return { target, method };
}

/** Remplace un lien par une VRAIE copie du fichier (pour un programme qui ne supporterait pas le lien). L'exemplaire d'origine n'est pas touché. */
export function restore(db, target) {
  const s = lst(target); if (!s) throw new Error('Fichier absent.');
  const rec = rd(db, LKEY).find((x) => x.target.toLowerCase() === String(target).toLowerCase());
  if (!s.isSymbolicLink() && s.nlink <= 1n) throw new Error('C’est déjà une vraie copie.');
  const src = s.isSymbolicLink() ? fs.realpathSync(target) : target; // un lien dur est déjà lisible : on copie vers un nouveau fichier
  const size = fs.statSync(src).size;
  try { const f = fs.statfsSync(path.dirname(target)); if (f.bavail * f.bsize < size + 512 * 1024 ** 2) throw new Error(`Pas assez de place pour une vraie copie (${Math.round(size / 1024 ** 3 * 10) / 10} Go).`); } catch (e) { if (/Pas assez/.test(e.message)) throw e; }
  const tmp = `${target}.paiz-copie`;
  try { fs.rmSync(tmp, { force: true }); fs.copyFileSync(src, tmp); if (s.isSymbolicLink()) fs.rmSync(target); fs.renameSync(tmp, target); }
  catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* rien */ } throw e; }
  wr(db, LKEY, rd(db, LKEY).filter((x) => x !== rec && x.target.toLowerCase() !== String(target).toLowerCase()));
  logEvent(db, 'component-restore', null, { target });
  return { target, restored: true };
}
