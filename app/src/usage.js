// Suivi des modèles : quand, par quoi et combien de fois un modèle a servi, d'où il vient, et ce qui devient inutile (vieux, jamais utilisé).
// Tout est rangé dans les réglages (JSON), clé « nom de fichier | taille » : elle survit aux déplacements (disque actif, écurie, réseau).
// PAIZ ne sait que ce qui passe par lui : son moteur et son relais /v1. Les autres programmes de la machine (LM Studio, Ollama…) ne sont pas vus.
import fs from 'node:fs';
import path from 'node:path';
import { getSetting, setSetting, queryAssets } from './db.js';

const UKEY = 'models.usage';
const SKEY = 'models.sources';
const SINCE = 'models.usage.since';
const HUB_ORIGINS = 'hub.origins'; // nom de fichier -> dépôt Hugging Face (anciens téléchargements, sans date)
export const TH = { oldDays: 90, graceDays: 14, starMin: 5, starRecentDays: 45 };
const DAY = 86400000;
const THROTTLE_MS = 20 * 60 * 1000; // un même programme sur un même modèle n'est compté qu'une fois par tranche de 20 min

export const keyOf = (fileName, size) => `${String(fileName).toLowerCase()}|${size}`;
const rd = (db, k) => { try { const o = JSON.parse(getSetting(db, k, '{}')); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const wr = (db, k, o) => setSetting(db, k, JSON.stringify(o));

function since(db) {
  let s = getSetting(db, SINCE, null);
  if (!s) { s = new Date().toISOString(); setSetting(db, SINCE, s); }
  return s;
}

const lastLogged = new Map();
function record(db, fileName, size, program, note) {
  since(db);
  const k = keyOf(fileName, size); const u = rd(db, UKEY); const now = new Date().toISOString();
  const e = u[k] || { n: 0, first: now, last: now, programs: {} };
  e.n += 1; e.last = now; if (note) e.note = String(note).slice(0, 80);
  const p = e.programs[program] || { n: 0, last: now };
  p.n += 1; p.last = now; e.programs[program] = p;
  u[k] = e; wr(db, UKEY, u);
}

/** Un modèle vient d'être lancé (moteur) : toujours compté. */
export function logUse(db, asset, program, note = '') {
  if (!asset?.file_name) return;
  record(db, asset.file_name, asset.size_bytes, program, note);
}

/** Une requête passe par le relais pour le modèle chargé (chemin du fichier) : comptée au plus une fois par 20 min et par programme. */
export function logUseByPath(db, filePath, program) {
  try {
    const k = `${String(filePath).toLowerCase()}|${program}`; const t = Date.now();
    if (t - (lastLogged.get(k) || 0) < THROTTLE_MS) return;
    const st = fs.statSync(filePath);
    lastLogged.set(k, t);
    record(db, path.basename(filePath), st.size, program, '');
  } catch { /* fichier illisible : rien à noter */ }
}

/** Nom lisible du programme qui appelle le relais /v1. */
export function programOf(req) {
  if (req.headers['x-paiz-persona']) return 'OpenCode (écran Travail)';
  const ua = String(req.headers['user-agent'] || '');
  if (/opencode/i.test(ua)) return 'OpenCode (externe)';
  const tok = ua.split(/[\s/]/)[0].replace(/[^\w.-]/g, '').slice(0, 30);
  return tok ? `Client « ${tok} »` : 'Client OpenAI';
}

/** Téléchargement terminé : on garde l'origine ET la date (les anciens téléchargements n'ont que le dépôt, sans date). */
export function recordSource(db, destPath, source) {
  try {
    const st = fs.statSync(destPath); const s = rd(db, SKEY);
    s[keyOf(path.basename(destPath), st.size)] = { repo: source.repo, downloadedAt: new Date().toISOString(), how: 'téléchargé par PAIZ (Découvrir)' };
    wr(db, SKEY, s);
  } catch { /* fichier absent : rien à noter */ }
}

/** Version allégée fabriquée par PAIZ : on garde de quel fichier elle vient et à quel niveau (le nom seul ne le dit pas toujours). */
export function recordDerived(db, destPath, { from, quant }) {
  try {
    const st = fs.statSync(destPath); const s = rd(db, SKEY);
    s[keyOf(path.basename(destPath), st.size)] = { repo: null, downloadedAt: new Date().toISOString(), how: `allégée par PAIZ (${quant}) depuis ${from}`, derivedFrom: from, quant };
    wr(db, SKEY, s);
  } catch { /* fichier absent : rien à noter */ }
}

/** Rapport pour l'écran : un modèle par ligne, avec statut (⭐ étoile / actif / ancien / jamais utilisé / nouveau). */
export function usageReport(db, now = Date.now()) {
  const tracking = since(db); const trackAge = (now - Date.parse(tracking)) / DAY;
  const u = rd(db, UKEY); const s = rd(db, SKEY); const ho = rd(db, HUB_ORIGINS);
  const items = queryAssets(db, { q: '.gguf', limit: 5000 }).items.filter((a) => /\.gguf$/i.test(a.file_name) && !/mmproj/i.test(a.file_name));
  const rows = items.map((a) => {
    const k = keyOf(a.file_name, a.size_bytes); const e = u[k] || null;
    const seenDays = (now - Date.parse(a.first_seen_at || a.mtime || new Date(now).toISOString())) / DAY;
    const lastDays = e ? (now - Date.parse(e.last)) / DAY : null;
    let status;
    if (e && e.n >= TH.starMin && lastDays <= TH.starRecentDays) status = 'star';
    else if (e && lastDays <= TH.oldDays) status = 'actif';
    else if (e) status = 'ancien';
    else if (Math.min(seenDays, trackAge) >= TH.graceDays) status = 'jamais';
    else status = 'nouveau';
    const src = s[k] || (ho[String(a.file_name).toLowerCase()] ? { repo: ho[String(a.file_name).toLowerCase()], downloadedAt: null, how: 'téléchargé via Découvrir (date inconnue)' } : null);
    return {
      id: a.id, key: k, file_name: a.file_name, title: a.title || a.file_name, size_bytes: a.size_bytes,
      root: a.root_name, role: a.root_role, mtime: a.mtime, firstSeen: a.first_seen_at,
      uses: e?.n || 0, firstUse: e?.first || null, lastUse: e?.last || null, note: e?.note || '',
      programs: Object.entries(e?.programs || {}).map(([name, p]) => ({ name, n: p.n, last: p.last })).sort((x, y) => y.n - x.n),
      source: src, status,
    };
  });
  const by = (st) => rows.filter((r) => r.status === st);
  const reclaim = rows.filter((r) => (r.status === 'jamais' || r.status === 'ancien') && r.role === 'active');
  return {
    trackingSince: tracking, thresholds: TH, rows,
    summary: {
      total: rows.length, star: by('star').length, actif: by('actif').length, ancien: by('ancien').length, jamais: by('jamais').length, nouveau: by('nouveau').length,
      reclaimBytes: reclaim.reduce((n, r) => n + (r.size_bytes || 0), 0), reclaimCount: reclaim.length,
    },
  };
}

/** Dernière activité de chaque modèle : le plus récent entre son dernier rangement / invocation (déplacement) et son dernier usage.
 *  Sert à mettre en haut des listes ce qu'on vient de ranger, d'invoquer ou d'utiliser. Renvoie { idDuModèle: dateIso }. */
export function recentMap(db) {
  const out = {};
  const bump = (id, iso) => { if (id != null && iso && (!out[id] || Date.parse(iso) > Date.parse(out[id]))) out[id] = iso; };
  for (const r of db.prepare("SELECT asset_id, MAX(at) AS at FROM events WHERE asset_id IS NOT NULL AND type IN ('move', 'copy') GROUP BY asset_id").all()) bump(r.asset_id, r.at);
  const u = rd(db, UKEY);
  for (const a of queryAssets(db, { limit: 5000 }).items) { const e = u[keyOf(a.file_name, a.size_bytes)]; if (e) bump(a.id, e.last); }
  return out;
}
