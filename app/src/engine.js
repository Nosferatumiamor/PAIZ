// Moteur WeightStream piloté par PAIZ : un seul modèle « chaud » servi en API compatible OpenAI (ws_npc_server).
// PAIZ sait OÙ sont les modèles (catalogue multi-disques) ; ce module sait les INVOQUER : amener le fichier sur la racine
// « active » (SSD), lancer le moteur dessus, et ranger les autres sur les racines « store » (disques lents).
import { logUse } from './usage.js';
import { findEngineDir } from './enginedir.js';
import { DEFAULT_PORT as PAIZ_PORT } from './config.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { getSetting, setSetting } from './db.js';
import { registerChild } from './orphans.js';
import { warmEngine } from './warm.js';
import { isStockModel, stockConfig, stockArgs, stockPlan, stockMissingMessage, killTree } from './stockengine.js';

// mêmes profils que scripts/run-npc-server.ps1 du dépôt WeightStream
export const PROFILES = {
  eco: ['--ws-ram-mib', '700', '--cache-mib', '512'],
  leger: ['--ws-ram-mib', '700', '--cache-mib', '1500'], // mesuré 19/11 (Gemma 4 26B, 1 conversation, texte identique) : 0,7/0,5 2,1 tok/s ; 0,7/1 3,1 ; 0,7/1,5 3,7 (VRAM 5,1 Go, RAM du moteur 2,9 Go) ; 0,7/2 4,4 ; 1,5/0,7 3,1 ; 2/0,5 3,2 : c'est le cache VRAM qui fait la vitesse, pas la RAM
  normal: ['--ws-ram-mib', '3000', '--cache-mib', '1024'],
  confort: ['--ws-ram-mib', '8000', '--cache-mib', '5120'], // mesuré 17/11 (Qwen 48 Go, 12 Go de VRAM, écriture sur 90 jetons) : 10/5 Go 5,3 tok/s ; 8/7 5,7 (VRAM pic 12,0 sur 12,3 : trop juste) ; 8/5 5,5 ; 6/7 5,5 — écarts dans le bruit, donc le moins gourmand sûr
  // mesuré 19/11 (gpt-oss-120b MXFP4, 150 jetons) : VRAM 5 Go 1,53 tok/s, 7 Go 1,83 (+20 %, texte identique), 9 Go = carte pleine (426 Mo libres) : écarté
  tache: ['--ws-ram-mib', '2000', '--cache-mib', '7000'],
  // mesuré 19/11 (Gemma 4 26B-A4B, grille 5x3, texte identique partout) : la RAM compte peu (0,7 Go suffit), le cache VRAM fait la vitesse : 3 Go 9 tok/s, 4 Go 17, 5 Go 21, 6 Go 26 (llama.cpp seul à 6 Go : 22,6 avec 10 Go de RAM)
  dialogue: ['--ws-ram-mib', '700', '--cache-mib', '4000'],
  vif: ['--ws-ram-mib', '700', '--cache-mib', '5000'],
  discret: ['--ws-ram-mib', '4000', '--cache-mib', '700'], // mesuré 19/11 (Gemma 4 26B, 1 conversation) : ≈ 5,8 tok/s, VRAM ≈ 3,6 Go (4,5 Go avec Firefox), RAM du moteur ≈ 6 Go ; --cpu-stream (experts au CPU) fait moins bien : 4,7 tok/s
  ram8: ['--ws-ram-mib', '8000', '--cache-mib', '700'], // mesuré 19/11 (Gemma 4 26B, texte identique) : 9,3 tok/s, VRAM ≈ 4,4 Go ; RAM 12 Go : 9,1 (inutile, et la machine ne garde que 0,5 Go)
  rapide: ['--ws-ram-mib', '700', '--cache-mib', '7000'], // mesuré 19/11 avec le cache de fenêtre réduit, 1 conversation : 4 Go 13 tok/s (7,4 Go VRAM), 5 Go 22 (8,3), 6 Go 33 (9,1), 7 Go 43 (10,2), 8 Go 52 (11,1)
  // EXTRA-LIGHT (AVEC PERTE) : mêmes réglages qu'un cache VRAM de 3 Go mais sur la version Q3_K_M du modèle (fichier à part, voir variantPath) ; mesuré 21/11 sur Gemma 4 26B : 17 tok/s pour ≈ 6,2 Go de VRAM totale contre 6,3 tok/s en Q4 au même cache
  extralight: ['--ws-ram-mib', '700', '--cache-mib', '3000'],
  cpu: ['--ws-ram-mib', '3000', '--cpu-stream'],
  // profils ADAPTATIFS du moteur : tailles des caches calculées d'après la RAM/VRAM réellement libres au chargement, puis régulateur de mémoire
  partage: ['--profile', 'partage'],
  fond: ['--profile', 'fond'],
  // taille du cache RAM décidée UNE FOIS au début de chaque message (RAM libre - marge, arrondie à un palier : 4/6/8/10/12/16 Go), puis fixe pendant la génération
  paliers: ['--profile', 'paliers'],
};

// Ce que chaque mode (profil) fait, en clair : affiché dans les listes de choix.
export const PROFILE_INFO = {
  eco: { label: 'eco : minimum', desc: 'Le minimum de mémoire (0,7 Go RAM, 0,5 Go VRAM). Le plus lent, machine libre.' },
  leger: { label: 'léger : eco en mieux', desc: 'Presque aussi sobre qu’eco, nettement plus vif : 0,7 Go RAM + 1,5 Go de cache VRAM (≈ 5 Go de VRAM au total). Mesuré sur Gemma 4 26B : ≈ 3,7 tok/s contre ≈ 2 pour eco.' },
  normal: { label: 'normal : équilibré', desc: '3 Go RAM + 1 Go VRAM pour les experts. Bon compromis au quotidien.' },
  confort: { label: 'confort : rapide', desc: '8 Go RAM + 5 Go VRAM. Rapide ; la VRAM monte à ~11,6 Go : ferme les autres programmes GPU.' },
  tache: { label: 'tâche de fond : géants en arrière-plan', desc: 'Pousse la carte sans la remplir (≈ 1,4 Go de marge pour l’écran et la vidéo). Pour les longues tâches des très gros modèles ; la file se met en pause si la mémoire baisse.' },
  dialogue: { label: 'dialogue : sobre', desc: 'Le plus sobre pour discuter : 0,7 Go RAM + 4 Go de cache VRAM (≈ 7,4 Go de VRAM au total). Mesuré sur Gemma 4 26B : ≈ 13 tok/s.' },
  vif: { label: 'vif : sobre et réactif', desc: '0,7 Go RAM + 5 Go de cache VRAM (≈ 8,3 Go de VRAM au total). Mesuré sur Gemma 4 26B : ≈ 22 tok/s.' },
  discret: { label: 'discret : GPU libre', desc: 'Pour laisser la carte à un jeu ou à autre chose : 4 Go de RAM + 0,7 Go de cache VRAM (≈ 3,6 Go de VRAM au total). Mesuré sur Gemma 4 26B : ≈ 5,8 tok/s.' },
  ram8: { label: 'RAM 8 Go : carte presque libre', desc: 'La mémoire vive travaille, la carte graphique ne garde que 0,7 Go de cache : 8 Go de RAM + 0,7 Go de VRAM (≈ 4,4 Go de VRAM au total). Mesuré sur Gemma 4 26B : ≈ 9 tok/s. Laisse peu de RAM à la machine (≈ 2 Go).' },
  rapide: { label: 'rapide : cache VRAM large', desc: '0,7 Go RAM + 7 Go de cache VRAM (≈ 10,2 Go de VRAM au total). Mesuré sur Gemma 4 26B : ≈ 43 tok/s. Ferme les programmes gourmands en VRAM.' },
  extralight: { lossy: true, label: 'extra-light : plus rapide mais instable ⚠', desc: '⚠ Faster but unstable. Utilise une version Q3 du modèle (≈ 21 % plus légère) : ≈ 2,3 fois plus rapide à cache égal, mais AVEC PERTE. Le texte s’écarte de la version normale ; sur Gemma 4 le code est nettement moins fiable (4 essais sur 9 contre 8 sur 9) ; en dialogue français la différence est faible. Le fichier Q3 est fabriqué à partir de la version actuelle (≈ 13 Go, à la première utilisation). À réserver à la discussion légère.' },
  cpu: { label: 'cpu : sans carte graphique', desc: 'Experts calculés par le processeur, sans cache VRAM. Si la carte graphique est occupée.' },
  partage: { label: 'partagé : suit la mémoire libre', desc: 'Cache ajusté en continu selon la mémoire libre, même pendant la réponse. Poli mais lent.' },
  fond: { label: 'à fond : maximum', desc: 'Prend tout ce qui est disponible (vitesse 6). Pour laisser la machine travailler seule.' },
  paliers: { label: 'paliers : décidé une fois par message', desc: 'Taille du cache (4 à 16 Go) décidée une fois par message d’après la RAM libre. Conseillé pour les gros modèles.' },
};
// Consommation affichée au survol des modes : calculée depuis les arguments réels du profil (cache d'experts VRAM / RAM) + le reste du modèle,
// mesuré sur Gemma 4 26B-A4B le 19/11 (VRAM : cache + ~2,6 Go ; RAM de travail : cache + ~2,2 Go ; varie un peu selon le modèle).
const gb = (mib) => (Math.round(mib / 100) / 10).toString().replace('.', ',');
for (const [name, args] of Object.entries(PROFILES)) {
  const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : null; };
  const info = PROFILE_INFO[name]; if (!info) continue;
  if (args.includes('--profile')) { info.conso = 'Mémoire : variable, calculée d’après la RAM et la VRAM libres au moment du chargement.'; continue; }
  const v = arg('--cache-mib') ?? 0; const r = arg('--ws-ram-mib') ?? 0;
  info.conso = `Cache d’experts : VRAM ${gb(v)} Go · RAM ${gb(r)} Go.` + (args.includes('--cpu-stream') ? '' : ` Total estimé (mesuré sur Gemma 4 26B) : VRAM ≈ ${gb(v + 2650)} Go · RAM ≈ ${gb(r + 2200)} Go.`);
}
// Grille des modes : « Où » (GPU d'abord / RAM d'abord / adaptatif) x « Combien » (du plus discret au plus rapide). Chaque case est un profil ci-dessus.
// Niveaux repris des anciennes icônes de « Vitesse » (ange -> furieux).
const LV = { discret: '😇 Discret', leger: '🙂 Léger', sobre: '😐 Sobre', vif: '😠 Vif', rapide: '😡 Rapide' };
const cells = (m) => Object.entries(m).map(([level, profile]) => ({ level, label: LV[level], profile }));
export const MODE_GRID = [
  { id: 'gpu', label: 'GPU d’abord', tip: 'La carte graphique garde les experts : plus il y en a, plus c’est rapide (le cache VRAM fait la vitesse).',
    options: cells({ discret: 'eco', leger: 'leger', sobre: 'dialogue', vif: 'vif', rapide: 'rapide' }) },
  { id: 'ram', label: 'RAM d’abord', tip: 'La mémoire vive travaille, la carte graphique reste presque libre (pour un jeu, par exemple).',
    options: cells({ discret: 'cpu', leger: 'normal', sobre: 'discret', vif: 'ram8', rapide: 'confort' }) },
  { id: 'xl', label: '⚠ Extra-light (avec perte)', tip: 'Plus rapide et plus léger en VRAM, mais avec perte de qualité : « faster but unstable ». Réservé à la discussion légère, pas au code.',
    options: [{ level: '', label: 'extra-light : plus rapide mais instable', profile: 'extralight' }] },
  { id: 'auto', label: 'Adaptatif', tip: 'Le moteur suit la mémoire libre de la machine pendant qu’il travaille. Plus prudent que rapide : pour les gros modèles et le travail de fond.',
    options: [{ level: '', label: 'partagé : suit la mémoire libre', profile: 'partage' }, { level: '', label: 'paliers : décidé à chaque message', profile: 'paliers' },
      { level: '', label: 'tâche de fond : géants', profile: 'tache' }, { level: '', label: 'à fond : maximum', profile: 'fond' }] },
];
// Le moteur vit dans engine/, à côté de app/ (trouvé tout seul, voir enginedir.js) ; réglage `engine.dir` ou variable WS_HOME pour un autre emplacement.
// ---- Mode extra-light : version Q3_K_M (avec perte) fabriquée à côté du modèle, par llama-quantize ----
export const LOSSY_PROFILES = { extralight: { quant: 'Q3_K_M', suffix: '-extralight-Q3_K_M.gguf' } };
export const variantPath = (modelPath, prof = 'extralight') => String(modelPath).replace(/\.gguf$/i, '') + LOSSY_PROFILES[prof].suffix;
// Version « extra-light » déjà disponible pour ce modèle : le modèle lui-même s'il est déjà en Q3 ou moins, la version fabriquée par
// l'onglet WeightStream (…-extralight-Q3_K_M.gguf), ou la Q3_K_M fabriquée par « Quantifier » (même nom avec Q3_K_M à la place du niveau d'origine).
export function findVariant(modelPath, prof = 'extralight') {
  const base = String(modelPath).replace(/\.gguf$/i, '');
  if (/(?:^|[-_.])I?Q[23](?:_[A-Z0-9]+)*$/i.test(base)) return String(modelPath);
  const q = LOSSY_PROFILES[prof].quant;
  const cands = [variantPath(modelPath, prof), (/(?:^|[-_.])(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32)$/i.test(base) ? base.replace(/([-_.])(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32)$/i, `$1${q}`) : `${base}-${q}`) + '.gguf'];
  return cands.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}
export const isLossyFile = (p) => /(?:^|[-_.])I?Q[23](?:_[A-Z0-9]+)*\.gguf$/i.test(String(p || ''));
export const variantState = { running: false, assetId: null, message: '', error: null, startedAt: null, done: false };
const quantizeExe = (cfg) => path.join(path.dirname(cfg.exe), 'llama-quantize.exe');
export function variantInfo(db, asset) {
  const found = findVariant(asset.abs_path); const out = found || variantPath(asset.abs_path);
  let size = null; try { size = fs.statSync(out).size; } catch { /* absente */ }
  return { exists: size != null, path: out, size, estimateBytes: Math.round((asset.size_bytes || 0) * 0.8), building: variantState.running && variantState.assetId === asset.id };
}
export async function buildVariant(db, asset) {
  if (variantState.running) throw new Error('Une fabrication est déjà en cours.');
  const cfg = engineConfig(db); const exe = getSetting(db, 'engine.quantizeExe', '') || quantizeExe(cfg);
  if (!fs.existsSync(exe)) throw new Error(`llama-quantize introuvable : ${exe} (scripts\build-llama.ps1 -Targets llama-quantize)`);
  if (!/\.gguf$/i.test(asset.abs_path) || !fs.existsSync(asset.abs_path)) throw new Error('Fichier du modèle absent.');
  const out = variantPath(asset.abs_path); const tmp = out + '.building';
  if (findVariant(asset.abs_path)) throw new Error('La version extra-light existe déjà.');
  const need = Math.round((asset.size_bytes || fs.statSync(asset.abs_path).size) * 0.85) + 2 * 1024 ** 3;
  try { const st = fs.statfsSync(path.dirname(out)); if (st.bavail * st.bsize < need) throw new Error(`Pas assez de place sur le disque du modèle : il faut environ ${Math.round(need / 1024 ** 3)} Go libres.`); } catch (e) { if (/Pas assez/.test(e.message)) throw e; }
  Object.assign(variantState, { running: true, assetId: asset.id, message: 'Fabrication de la version extra-light (quelques minutes)…', error: null, startedAt: Date.now(), done: false });
  const shell = /\.(cmd|bat)$/i.test(exe);
  const p = spawn(exe, ['--allow-requantize', asset.abs_path, tmp, LOSSY_PROFILES.extralight.quant], { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell });
  registerChild('quantize', p, exe);
  let tail = ''; const keep = (b) => { tail = (tail + String(b)).slice(-600); };
  p.stdout.on('data', keep); p.stderr.on('data', keep);
  p.on('error', (e) => { variantState.running = false; variantState.error = e.message; });
  p.on('exit', (code) => {
    variantState.running = false;
    if (code === 0 && fs.existsSync(tmp)) { try { fs.renameSync(tmp, out); variantState.done = true; variantState.message = 'Version extra-light prête : relance le modèle avec ce mode.'; } catch (e) { variantState.error = e.message; } }
    else { variantState.error = `llama-quantize a échoué (code ${code}) : ${tail.trim().split(/\r?\n/).slice(-2).join(' ')}`; try { fs.rmSync(tmp, { force: true }); } catch { /* déjà absent */ } }
  });
  return { started: true, out };
}
export function engineConfig(db) {
  const dir = process.env.WS_HOME || getSetting(db, 'engine.dir', null) || findEngineDir() || 'D:\\005-GIT\\PAIZ\\engine';
  return {
    dir,
    exe: getSetting(db, 'engine.exe', path.join(dir, 'build-llama', 'bin', 'ws_npc_server.exe')),
    port: Number(getSetting(db, 'engine.port', 8770)),
    ctx: Number(getSetting(db, 'engine.ctx', 16384)),
    slots: Number(getSetting(db, 'engine.slots', 1)),
    profile: getSetting(db, 'engine.profile', 'normal'),
    kvType: getSetting(db, 'engine.kvType', ''),
    extraArgs: getSetting(db, 'engine.extraArgs', ''),
  };
}

let proc = null;
let current = null; // { assetId, path, profile, port, startedAt }
let lastLog = [];

function pushLog(buf) {
  for (const l of String(buf).split(/\r?\n/)) if (l.trim()) lastLog.push(l);
  if (lastLog.length > 200) lastLog = lastLog.slice(-200);
}

export const currentModel = () => (current ? { path: current.path, assetId: current.assetId } : null);

export async function engineHealth(cfg) {
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

// La version extra-light existe-t-elle pour le modèle chargé (sinon le dernier utilisé) ? null = pas de modèle connu.
function xlReady(db, cur) {
  try {
    const id = Number(cur?.assetId || getSetting(db, 'work.lastAsset', 0) || 0); const a = id ? getAsset(db, id) : null;
    return a ? variantInfo(db, a).exists : null;
  } catch { return null; }
}

export async function engineStatus(db) {
  const cfg = engineConfig(db);
  return {
    exeFound: fs.existsSync(cfg.exe),
    exe: cfg.exe,
    autoload: autoOn(db),
    running: !!proc && proc.exitCode === null,
    responding: await engineHealth(cfg),
    current,
    defaultProfile: LOSSY_PROFILES[cfg.profile] ? 'normal' : cfg.profile, // un réglage « version légère » ne vaut que pour un modèle léger
    loading: !!current && !current.loadedAt && !!proc && proc.exitCode === null,
    loadElapsed: current && !current.loadedAt ? (Date.now() - Date.parse(current.startedAt)) / 1000 : null,
    loadEstimate: Number(getSetting(db, 'engine.loadSec', 120)) || 120,
    endpoint: `http://127.0.0.1:${cfg.port}/v1`,
    profiles: Object.keys(PROFILES),
    profileInfo: PROFILE_INFO,
    grid: MODE_GRID,
    extralight: { ...variantState },
    lossy: !!current && isLossyFile(current.path),
    log: lastLog.slice(-30),
  };
}

// Le moteur lancé par PAIZ ne survit pas à PAIZ (fermeture normale, Ctrl+C ou arrêt par Tauri).
process.on('exit', () => { try { if (proc && proc.exitCode === null) { if (current?.backend === 'stock') killTree(proc); else proc.kill(); } } catch { /* déjà arrêté */ } });
// SIGHUP / SIGBREAK : fermeture de la fenêtre de console sous Windows (version navigateur) ; sans ça les moteurs survivraient.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => process.exit(0));
process.on('exit', () => { try { if (auxProc && auxProc.exitCode === null) auxProc.kill(); } catch { /* déjà arrêté */ } });

// Second moteur, à la demande, pour les tâches de fond qui demandent un autre modèle que celui de la discussion (un seul à la fois, port = port du moteur + 1).
// Mesuré 19/11 : Gemma 4 Go de cache + Qwen3-Coder-Next 1,5 Go tiennent ensemble (~10,9 Go de VRAM) ; chacun ralentit d'environ 20 % quand l'autre écrit.
let auxProc = null; let auxCur = null;
export const mainAssetId = () => (current ? current.assetId : null);
export const mainLoading = () => !!current && !current.loadedAt && !!proc && proc.exitCode === null; // le moteur de la discussion charge encore : sa part de VRAM n'est pas fixée
export const auxCurrent = () => (auxCur && auxProc && auxProc.exitCode === null ? auxCur : null);
export const auxPort = (db) => engineConfig(db).port + 1;
export async function stopAux() {
  if (auxProc && auxProc.exitCode === null) { auxProc.kill(); await new Promise((r) => setTimeout(r, 300)); }
  auxProc = null; auxCur = null;
}
export async function startAux(db, { asset, cacheMib = 1500, ramMib = 2000, ctx = 32768 }) {
  const cfg = engineConfig(db); const port = auxPort(db);
  if (!fs.existsSync(cfg.exe)) throw new Error('ws_npc_server introuvable.');
  if (!asset || !fs.existsSync(asset.abs_path)) throw new Error('Fichier du modèle absent.');
  await stopAux();
  const args = ['-m', asset.abs_path, '--port', String(port), '-c', String(ctx), '--slots', '1', '--swa-full', '0', '--ws-ram-mib', String(ramMib), '--cache-mib', String(cacheMib), '--data-dir', path.join(DATA_DIR, 'engine-aux')];
  const p = spawn(cfg.exe, args, { cwd: path.dirname(cfg.exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  registerChild('moteur-tâche', p, cfg.exe);
  p.stdout.on('data', () => {}); p.stderr.on('data', () => {});
  p.on('exit', () => { if (auxProc === p) { auxProc = null; auxCur = null; } });
  auxProc = p;
  for (let i = 0; i < 240 && auxProc === p; i++) { if (await engineHealth({ port })) break; await new Promise((r) => setTimeout(r, 500)); }
  if (auxProc !== p) throw new Error('Le second moteur s’est arrêté au démarrage.');
  await enginePost(port, '/api/resume', {});
  auxCur = { assetId: asset.id, path: asset.abs_path, port, cacheMib, startedAt: Date.now() };
  return auxCur;
}
export async function stopEngine() {
  if (proc && proc.exitCode === null) {
    if (current?.backend === 'stock') killTree(proc); else proc.kill();
    await new Promise((r) => setTimeout(r, current?.backend === 'stock' ? 1500 : 300));
  }
  proc = null; current = null;
}

// Lance le moteur sur un fichier GGUF (chemin absolu). Un seul modèle chaud à la fois : on arrête l'ancien.
// Au démarrage de PAIZ : relance le dernier modèle utilisé (si la case est cochée). Ne fait rien si le moteur tourne déjà, si le fichier a disparu
// ou si la machine n'a pas la mémoire libre pour charger sans gêner.
const autoOn = (db) => ['1', 'true'].includes(String(getSetting(db, 'engine.autoload', 0)));
export async function autoloadLast(db, { minFreeMb = 6000 } = {}) {
  if (!autoOn(db)) return { skipped: 'désactivé' };
  if (current || proc) return { skipped: 'moteur déjà lancé' };
  const id = Number(getSetting(db, 'work.lastAsset', 0) || 0); const asset = id ? getAsset(db, id) : null;
  if (!asset || !asset.abs_path || !fs.existsSync(asset.abs_path)) return { skipped: 'dernier modèle introuvable' };
  if (os.freemem() / 1048576 < minFreeMb) return { skipped: 'mémoire libre insuffisante' };
  await startEngine(db, { asset });
  return { started: asset.id };
}
// Conversations parallèles à la demande : chaque slot garde un cache KV en VRAM (~2 Go à 16 k), donc le moteur tourne avec 1 slot et n'en ouvre un
// deuxième que quand une tâche de fond en a besoin (relance du moteur, la conversation en cours est reprise depuis sa sauvegarde).
export async function ensureSlots(db, n) {
  if (!current || !proc || current.slots >= n) return false;
  const asset = getAsset(db, current.assetId); if (!asset) return false;
  await startEngine(db, { asset, profile: current.profile, slots: n });
  const cur = current;
  for (let i = 0; i < 1200 && current === cur && !cur.loadedAt; i++) await new Promise((r) => setTimeout(r, 500));
  return true;
}
// Referme les slots en trop (retour au réglage de base) : libère la VRAM.
export async function restoreSlots(db) {
  const base = engineConfig(db).slots;
  if (!current || !proc || current.slots <= base) return false;
  const asset = getAsset(db, current.assetId); if (!asset) return false;
  await startEngine(db, { asset, profile: current.profile, slots: base });
  return true;
}
export async function startEngine(db, { asset, profile, ctx, slots }) {
  const cfg = engineConfig(db);
  if (!/\.gguf$/i.test(asset.abs_path)) throw new Error('Le moteur ne lit que des fichiers .gguf.');
  if (!fs.existsSync(asset.abs_path)) throw new Error(`Fichier absent : ${asset.abs_path}`);
  // architecture que notre moteur ne connaît pas (Inkling 2...) : second moteur, llama.cpp récent ; les autres modèles ne changent pas
  if (await isStockModel(db, asset.abs_path)) return startStock(db, { asset, profile, ctx, slots });
  if (!fs.existsSync(cfg.exe)) throw new Error(`ws_npc_server introuvable : ${cfg.exe} (build : scripts\\build-ws-tools.ps1 dans WeightStream, ou réglage engine.exe)`);
  // un modèle allégé (Q3 / Q2) est un modèle extra-light : c'est son seul mode ; les autres modèles n'ont pas ce mode
  const lossy = isLossyFile(asset.abs_path);
  let prof = lossy ? 'extralight' : (profile || cfg.profile);
  if (!lossy && LOSSY_PROFILES[prof]) prof = cfg.profile !== 'extralight' ? cfg.profile : 'normal';
  if (!PROFILES[prof]) throw new Error(`Profil inconnu : ${prof}`);
  const modelPath = asset.abs_path;
  await stopEngine();
  lastLog = [];
  const args = ['-m', modelPath, '--port', String(cfg.port), '-c', String(ctx || cfg.ctx), '--slots', String(slots || cfg.slots), ...PROFILES[prof]];
  // Cache de fenêtre réduit (couches à fenêtre glissante de Gemma & co) : −4 Go de VRAM à 2 conversations, texte identique, mesuré. Réglage engine.swaFull=1 pour l'ancien comportement.
  if (String(getSetting(db, 'engine.swaFull', 0)) !== '1') args.push('--swa-full', '0');
  if (cfg.kvType) args.push('--kv-type', cfg.kvType);
  if (cfg.extraArgs) args.push(...String(cfg.extraArgs).split(/\s+/).filter(Boolean));
  proc = spawn(cfg.exe, args, { cwd: path.dirname(cfg.exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  registerChild('moteur', proc, cfg.exe);
  proc.stdout.on('data', pushLog);
  proc.stderr.on('data', pushLog);
  proc.on('exit', () => { proc = null; current = null; });
  current = { assetId: asset.id, path: modelPath, profile: prof, slots: Number(slots || cfg.slots), port: cfg.port, startedAt: new Date().toISOString(), loadedAt: null };
  setSetting(db, 'engine.profile', prof); // dernier mode choisi, retrouvé au prochain lancement (WeightStream comme Travail)
  try { logUse(db, asset, 'PAIZ · moteur', `profil ${prof}`); } catch { /* suivi sans effet sur le lancement */ }
  setSetting(db, 'work.lastAsset', asset.id); // dernier modèle utilisé : retrouvé par l'écran Travail
  const cur = current;
  // Le moteur charge normalement le modèle à la PREMIÈRE requête : on le charge dès le lancement (POST /api/resume),
  // pour que la première question n'attende pas le chargement. Puis on applique la vitesse (gear) choisie.
  const mine = proc;
  (async () => {
    for (let i = 0; i < 240 && proc === mine; i++) { if (await engineHealth(cfg)) break; await new Promise((r) => setTimeout(r, 500)); }
    if (proc !== mine) return;
    pushLog('[paiz] chargement du modèle en mémoire…');
    try {
      await enginePost(cfg.port, '/api/resume', {});
      // préchauffage du prompt (modèles de taille raisonnable) : compris dans la barre de chargement, le premier message n'a plus que le sien à lire
      if (current === cur && proc === mine) {
        let size = 0; try { size = fs.statSync(asset.abs_path).size; } catch { /* inconnu : pas de chauffe */ }
        cur.phase = 'warm'; pushLog('[paiz] préchauffage du prompt…');
        const w = await warmEngine({ port: cfg.port, modelPath: asset.abs_path, sizeBytes: size || Infinity, enabled: getSetting(db, 'engine.warm', true) !== false });
        cur.phase = null;
        pushLog(w.skipped ? `[paiz] préchauffage ignoré : ${w.skipped}.` : w.ok ? `[paiz] préchauffage fait en ${Math.round(w.seconds)} s (${w.promptTokens} jetons).` : `[paiz] préchauffage échoué : ${w.error}`);
      }
      if (current === cur) {
        cur.loadedAt = Date.now();
        const took = (cur.loadedAt - Date.parse(cur.startedAt)) / 1000;
        const old = Number(getSetting(db, 'engine.loadSec', 120)) || 120;
        setSetting(db, 'engine.loadSec', Math.round(old * 0.5 + took * 0.5)); // estimation du prochain chargement : moyenne lissée des mesures
        pushLog(`[paiz] modèle chargé en ${Math.round(took)} s.`);
      }
    } catch (e) { pushLog(`[paiz] chargement : ${e.message}`); }
    const g = Number(getSetting(db, 'work.gear', 0)) || 0;
    if (g > 0 && proc === mine) { try { await enginePost(cfg.port, '/api/resources', { gear: g }); } catch { /* sans effet : vitesse du profil */ } }
  })();
  return current;
}

// Second moteur (llama.cpp récent) : un seul serveur, le modèle se charge au démarrage (pas de /api/resume ni de préchauffage WeightStream).
async function startStock(db, { asset, profile, ctx, slots }) {
  const cfg = engineConfig(db); const sc = stockConfig(db);
  if (!fs.existsSync(sc.exe)) throw new Error(stockMissingMessage(sc));
  const prof = PROFILES[profile || cfg.profile] && !LOSSY_PROFILES[profile || cfg.profile] ? (profile || cfg.profile) : 'normal';
  const plan = stockPlan(prof);
  await stopEngine();
  lastLog = [];
  const args = stockArgs(db, { model: asset.abs_path, port: cfg.port, ctx: ctx || cfg.ctx, slots: slots || cfg.slots });
  if (cfg.extraArgs) args.push(...String(cfg.extraArgs).split(/\s+/).filter(Boolean));
  let exe = sc.exe; let full = args;
  if (plan.capMib > 0) {
    if (fs.existsSync(sc.capExe)) { exe = sc.capExe; full = ['--max-mib', String(plan.capMib), '--', sc.exe, ...args]; }
    else pushLog('[paiz] ws_run_capped introuvable : le plafond de RAM n’est pas appliqué.');
  }
  proc = spawn(exe, full, { cwd: sc.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  registerChild('moteur', proc, exe);
  proc.stdout.on('data', pushLog); proc.stderr.on('data', pushLog);
  proc.on('exit', () => { proc = null; current = null; });
  current = { assetId: asset.id, path: asset.abs_path, profile: prof, backend: 'stock', tier: plan.tier, tierLabel: plan.label, slots: Number(slots || cfg.slots), port: cfg.port, startedAt: new Date().toISOString(), loadedAt: null };
  setSetting(db, 'engine.profile', prof);
  try { logUse(db, asset, 'PAIZ · moteur secondaire', `profil ${prof} (${plan.label})`); } catch { /* suivi sans effet sur le lancement */ }
  setSetting(db, 'work.lastAsset', asset.id);
  const cur = current; const mine = proc;
  pushLog(`[paiz] moteur secondaire (llama.cpp récent) : ${plan.label}, VRAM basse.`);
  (async () => {
    for (let i = 0; i < 1200 && proc === mine; i++) { if (await engineHealth(cfg)) break; await new Promise((r) => setTimeout(r, 500)); }
    if (proc !== mine || current !== cur) return;
    cur.loadedAt = Date.now();
    const took = (cur.loadedAt - Date.parse(cur.startedAt)) / 1000;
    pushLog(`[paiz] modèle chargé en ${Math.round(took)} s.`);
  })();
  return current;
}

// POST JSON vers le moteur, sans délai d'attente (un chargement de 48 Go peut durer plusieurs minutes).
function enginePost(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (m) => {
      const c = []; m.on('data', (x) => c.push(x)); m.on('end', () => (m.statusCode < 400 ? resolve(Buffer.concat(c).toString('utf8')) : reject(new Error(`moteur ${m.statusCode}`))));
    });
    r.setTimeout(0); r.on('error', reject); r.end(data);
  });
}
// Vitesse du moteur (0 = auto, 1 à 6) : mémorisée, et appliquée tout de suite si le moteur tourne.
export async function setEngineGear(db, gear) {
  const g = Math.max(0, Math.min(6, Math.round(Number(gear) || 0)));
  setSetting(db, 'work.gear', g);
  const cfg = engineConfig(db);
  if (await engineHealth(cfg)) { try { await enginePost(cfg.port, '/api/resources', { gear: g }); } catch (e) { throw new Error(`Le moteur a refusé la vitesse : ${e.message}`); } }
  return g;
}

// Bloc de configuration pour OpenCode (opencode.json) : fournisseur OpenAI-compatible pointant sur le moteur.
export function opencodeConfig(db, modelName = 'local') {
  const cfg = engineConfig(db);
  const id = (modelName || 'local').replace(/\.gguf$/i, '');
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      paiz: {
        npm: '@ai-sdk/openai-compatible',
        name: 'PAIZ-WeightStream (local)',
        options: { baseURL: `http://127.0.0.1:${PAIZ_PORT}/v1`, timeout: false, chunkTimeout: 3600000 },
        models: { [id]: { name: id, limit: { context: cfg.ctx, output: 4096 }, modalities: { input: ['text', 'image'], output: ['text'] } }, ...(id === 'local' ? { mule: { name: 'mule', limit: { context: 32768, output: 8192 } } } : {}) },
      },
    },
    model: `paiz/${id}`,
  };
}

// ---------------------------------------------------------------------------
// Invocation : « sors ce modèle de l'archive, mets-le sur le SSD, lance-le, range les autres »
// ---------------------------------------------------------------------------
import { getAsset, getRoot, listRoots, queryAssets } from './db.js';
import { assertTransferSpace, getJob, startBulkMoveJob, startTransferJob } from './jobs.js';

export const summonState = { step: 'idle', message: '', jobId: null, error: null, assetId: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJob(id) {
  for (;;) {
    const j = getJob(id);
    if (!j) throw new Error('Tâche introuvable');
    if (j.status === 'done') return j;
    if (j.status !== 'running') throw new Error(j.error || `Tâche ${j.status}`);
    await sleep(500);
  }
}

// opts : { assetId, profile?, ctx?, slots?, activeRoot? (id|nom), storeRoot? (id|nom), shelve? (bool) }
export function summon(db, opts) {
  if (summonState.step !== 'idle' && summonState.step !== 'done' && summonState.step !== 'error') throw new Error('Une invocation est déjà en cours.');
  Object.assign(summonState, { step: 'check', message: 'Vérification…', jobId: null, error: null, assetId: Number(opts.assetId) });
  (async () => {
    try {
      const roots = listRoots(db);
      const active = opts.activeRoot ? getRoot(db, opts.activeRoot) : roots.find((r) => r.role === 'active');
      if (!active) throw new Error('Aucune racine « active » (le SSD de travail). Ajoutes-en une (role=active).');
      let asset = getAsset(db, opts.assetId);
      if (!asset) throw new Error('Modèle inconnu du catalogue.');
      if (asset.root_id !== active.id) {
        await assertTransferSpace(db, [asset.id], active.id);
        summonState.step = 'transfer';
        summonState.message = `Déplacement de ${asset.file_name} vers ${active.name}…`;
        const job = startTransferJob(db, { assetId: asset.id, toRoot: active.id, mode: 'move' });
        summonState.jobId = job.id;
        await waitJob(job.id);
        asset = getAsset(db, asset.id);
      }
      summonState.step = 'start';
      summonState.message = 'Démarrage du moteur…';
      await startEngine(db, { asset, profile: opts.profile, ctx: opts.ctx, slots: opts.slots });
      if (opts.shelve) {
        const store = opts.storeRoot ? getRoot(db, opts.storeRoot) : roots.find((r) => r.role === 'store');
        const others = queryAssets(db, { category: 'llm', rootId: active.id, limit: 5000 }).items.filter((a) => a.id !== asset.id);
        if (store && others.length) {
          summonState.step = 'shelve';
          summonState.message = `Rangement de ${others.length} autre(s) modèle(s) vers ${store.name}…`;
          const job = startBulkMoveJob(db, { assetIds: others.map((a) => a.id), toRoot: store.id, mode: 'move' });
          summonState.jobId = job.id;
          await waitJob(job.id);
        }
      }
      Object.assign(summonState, { step: 'done', message: 'Modèle prêt.' });
    } catch (e) {
      Object.assign(summonState, { step: 'error', error: e.message, message: e.message });
    }
  })();
  return summonState;
}

// ---------------------------------------------------------------------------
// Branchement d'OpenCode : on ajoute (ou met à jour) le fournisseur « weightstream » dans opencode.jsonc,
// sans toucher aux autres fournisseurs, avec une sauvegarde datée du fichier.
// ---------------------------------------------------------------------------
import os from 'node:os';

export function opencodeConfigPath() {
  return process.env.OPENCODE_CONFIG || path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc');
}

// JSONC -> objet : retire commentaires et virgules finales en respectant les chaînes. { value, hadComments }
export function parseJsonc(text) {
  let out = ''; let hadComments = false; let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]; const n = text[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n; i++; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { hadComments = true; while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') { hadComments = true; i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  // virgules finales hors chaînes
  let res = ''; inStr = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inStr) { res += c; if (c === '\\') { res += out[i + 1]; i++; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; res += c; continue; }
    if (c === ',') { let j = i + 1; while (/\s/.test(out[j] || '')) j++; if (out[j] === '}' || out[j] === ']') continue; }
    res += c;
  }
  return { value: res.trim() ? JSON.parse(res) : {}, hadComments };
}

function providerBlock(db, st) {
  const cfg = engineConfig(db);
  const id = st.current ? path.basename(st.current.path).replace(/\.gguf$/i, '') : 'local';
  return {
    name: 'WeightStream (local)',
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL: `http://127.0.0.1:${PAIZ_PORT}/v1`, timeout: false, chunkTimeout: 3600000 },
    models: { [id]: { name: id, limit: { context: cfg.ctx, output: 4096 } } },
  };
}

export async function opencodeStatus(db) {
  const file = opencodeConfigPath();
  const st = await engineStatus(db);
  let connected = false; let exists = fs.existsSync(file); let error = null;
  if (exists) {
    try { connected = !!parseJsonc(fs.readFileSync(file, 'utf8')).value?.provider?.weightstream; } catch (e) { error = e.message; }
  }
  return { file, exists, connected, error, preview: providerBlock(db, st) };
}

export async function connectOpencode(db) {
  const file = opencodeConfigPath();
  const st = await engineStatus(db);
  let conf = { $schema: 'https://opencode.ai/config.json' }; let hadComments = false; let backup = null;
  if (fs.existsSync(file)) {
    const parsed = parseJsonc(fs.readFileSync(file, 'utf8'));
    conf = parsed.value; hadComments = parsed.hadComments;
    backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  conf.provider = { ...(conf.provider || {}), weightstream: providerBlock(db, st) };
  fs.writeFileSync(file, JSON.stringify(conf, null, 2) + '\n');
  return { file, backup, commentsLost: hadComments, model: Object.keys(conf.provider.weightstream.models)[0], note: 'Relance OpenCode pour voir le fournisseur.' };
}

// ---------------------------------------------------------------------------
// Réglages persistants, test de chat
// ---------------------------------------------------------------------------
export function getEngineSettings(db) {
  const c = engineConfig(db);
  return { dir: c.dir, exe: c.exe, port: c.port, ctx: c.ctx, slots: c.slots, profile: c.profile, kvType: c.kvType, extraArgs: c.extraArgs, toolMode: getSetting(db, 'engine.toolMode', 'auto'), autoload: autoOn(db) };
}

export function setEngineSettings(db, b) {
  const num = (v, lo, hi) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error('Valeur hors limites.'); return Math.round(n); };
  if (b.port != null) setSetting(db, 'engine.port', num(b.port, 1024, 65535));
  if (b.ctx != null) setSetting(db, 'engine.ctx', num(b.ctx, 512, 1048576));
  if (b.slots != null) setSetting(db, 'engine.slots', num(b.slots, 1, 16));
  if (b.profile != null) { if (!PROFILES[b.profile]) throw new Error('Profil inconnu.'); setSetting(db, 'engine.profile', b.profile); }
  if (b.kvType != null) { if (!['', 'f16', 'q8_0', 'q4_0'].includes(b.kvType)) throw new Error('Type de KV inconnu.'); setSetting(db, 'engine.kvType', b.kvType); }
  if (b.toolMode != null) { if (!['auto', 'focus', 'all'].includes(b.toolMode)) throw new Error('Mode outils inconnu.'); setSetting(db, 'engine.toolMode', b.toolMode); }
  if (b.autoload != null) setSetting(db, 'engine.autoload', b.autoload === true || b.autoload === 'true' ? 1 : 0);
  if (b.extraArgs != null) setSetting(db, 'engine.extraArgs', String(b.extraArgs).slice(0, 500));
  if (b.exe != null && String(b.exe).trim()) setSetting(db, 'engine.exe', String(b.exe).trim());
  if (b.dir != null && String(b.dir).trim()) setSetting(db, 'engine.dir', String(b.dir).trim());
  return getEngineSettings(db);
}

// Envoie une conversation au moteur (non streamé) et rend le texte + la vitesse.
export async function engineChat(db, { messages, maxTokens = 400, temperature = 0.7, tools }) {
  const cfg = engineConfig(db);
  const t0 = Date.now();
  const body = { model: 'local', messages, max_tokens: maxTokens, temperature, ...(tools ? { tools } : {}) };
  const r = await fetch(`http://127.0.0.1:${cfg.port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(600000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || d?.error || `Moteur : HTTP ${r.status}`);
  const m = d.choices?.[0]?.message || {};
  const ms = Date.now() - t0; const n = d.usage?.completion_tokens || 0;
  return {
    text: (m.content || '').replace(/<\|channel>thought\s*<channel\|>/g, '').trim(), toolCalls: m.tool_calls || [], finish: d.choices?.[0]?.finish_reason,
    tokens: n, promptTokens: d.usage?.prompt_tokens || 0, ms, tps: n && d.timings?.predicted_ms ? +(n / (d.timings.predicted_ms / 1000)).toFixed(1) : null, timings: d.timings || null,
  };
}

// Même chose en flux : écrit des lignes JSON (une par morceau de texte, puis une ligne finale avec les durées) dans `res`.
export async function engineChatStream(db, { messages, maxTokens = 400, temperature = 0.7 }, res, abort) {
  const cfg = engineConfig(db);
  const t0 = Date.now(); let tFirst = 0; let text = ''; let usage = null; let timings = null;
  const send = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch { /* client parti */ } };
  const ac = new AbortController(); abort?.(() => ac.abort());
  const r = await fetch(`http://127.0.0.1:${cfg.port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([ac.signal, AbortSignal.timeout(600000)]),
    body: JSON.stringify({ model: 'local', messages, max_tokens: maxTokens, temperature, stream: true, stream_options: { include_usage: true } }) });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error?.message || d?.error || `Moteur : HTTP ${r.status}`); }
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim(); if (data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.usage) usage = j.usage; if (j.timings) timings = j.timings;
      const t = j.choices?.[0]?.delta?.content;
      if (t) { if (!tFirst) tFirst = Date.now(); text += t; send({ delta: t }); }
    }
  }
  const t1 = Date.now(); const n = usage?.completion_tokens || 0;
  send({ done: true, text: text.replace(/<\|channel>thought\s*<channel\|>/g, '').trim(), tokens: n, promptTokens: usage?.prompt_tokens || 0, ms: t1 - t0, readMs: tFirst ? tFirst - t0 : t1 - t0, writeMs: tFirst ? t1 - tFirst : 0,
    tps: n && timings?.predicted_ms ? +(n / (timings.predicted_ms / 1000)).toFixed(1) : (n && tFirst && t1 > tFirst ? +(n / ((t1 - tFirst) / 1000)).toFixed(1) : null) });
}

// ---------------------------------------------------------------------------
// OpenCode isolé : PAIZ lance OpenCode (mode --standalone) avec SA config, sans toucher à celle de l'utilisateur.
// ---------------------------------------------------------------------------
import { spawn as spawnProc } from 'node:child_process';
import { DATA_DIR } from './config.js';

export function opencodeExe() {
  const cands = [process.env.OPENCODE_EXE, path.join(process.env.LOCALAPPDATA || '', 'Programs', '@opencode-aidesktop', 'resources', 'opencode-cli.exe')];
  return cands.find((p) => p && fs.existsSync(p)) || null;
}

export function launchOpencode(db, { dir } = {}) {
  const exe = opencodeExe();
  if (!exe) throw new Error('OpenCode introuvable (installe-le, ou renseigne la variable OPENCODE_EXE).');
  const folder = path.resolve(String(dir || '').trim() || os.homedir());
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`Dossier introuvable : ${folder}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const conf = path.join(DATA_DIR, 'opencode-paiz.json');
  fs.writeFileSync(conf, JSON.stringify(opencodeConfig(db, 'local'), null, 2));
  const p = spawnProc('cmd.exe', ['/c', 'start', '"OpenCode - PAIZ"', '/D', folder, 'cmd', '/k', '%PAIZ_OC_EXE%', '--standalone'], {
    env: { ...process.env, OPENCODE_CONFIG: conf, PAIZ_OC_EXE: exe }, windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: false,
  });
  p.unref();
  return { folder, config: conf, exe };
}
