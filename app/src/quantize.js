// Quantification d'un modèle .gguf par llama-quantize : niveaux proposés selon le modèle, fabrication avec progression,
// puis enregistrement du nouveau fichier au catalogue (surligné en orange jusqu'au premier clic).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getSetting, setSetting, getAsset, getAssetByPath } from './db.js';
import { scanPath } from './scanner.js';
import { engineConfig } from './engine.js';
import { registerChild } from './orphans.js';
import { recordDerived } from './usage.js';

// bits par poids (ordre de grandeur) ; sert à classer et à estimer la taille du résultat
const BITS = { F32: 32, F16: 16, BF16: 16, Q8_0: 8.5, Q6_K: 6.6, Q5_K_M: 5.7, Q5_K_S: 5.5, Q5_1: 6, Q5_0: 5.5, Q4_K_M: 4.9, Q4_K_S: 4.6, Q4_1: 5, Q4_0: 4.5, IQ4_XS: 4.3, IQ4_NL: 4.5, Q3_K_L: 4.3, Q3_K_M: 3.9, Q3_K_S: 3.5, IQ3_M: 3.7, IQ3_S: 3.4, IQ3_XXS: 3.1, Q2_K: 2.6, IQ2_M: 2.7, IQ2_S: 2.5, IQ2_XS: 2.3, IQ2_XXS: 2.1 };
// niveaux proposés (du plus fidèle au plus agressif) ; risk : 0 quasi sans perte, 1 faible, 2 sensible, 3 très dégradé
const LEVELS = [
  { q: 'Q8_0', risk: 0, label: 'Q8_0 — quasi sans perte', note: 'Presque identique à l’original ; gain de taille modeste.' },
  { q: 'Q6_K', risk: 0, label: 'Q6_K — très fidèle', note: 'Différence imperceptible en pratique.' },
  { q: 'Q5_K_M', risk: 1, label: 'Q5_K_M — excellent compromis', note: 'Perte très faible, bon gain de place.' },
  { q: 'Q4_K_M', risk: 1, label: 'Q4_K_M — le standard', note: 'Le choix courant : bon équilibre taille / qualité.' },
  { q: 'Q3_K_M', risk: 2, label: 'Q3_K_M — perte sensible ⚠', note: 'Plus léger et plus rapide, mais les réponses se dégradent (erreurs, perte de nuance, français plus fragile).' },
  { q: 'Q2_K', risk: 3, label: 'Q2_K — très dégradé ⚠⚠', note: 'Souvent inutilisable : texte incohérent, surtout sur les petits modèles. À éviter sauf curiosité.' },
];
const QRE = /(?:^|[-_.])((?:I?Q\d(?:_[A-Z0-9]+)*)|BF16|F16|F32|MXFP4)(?=[-_.]|$)/i;
export const detectQuant = (fileName) => { const m = String(fileName).replace(/\.gguf$/i, '').match(QRE); return m ? m[1].toUpperCase() : null; };

/** Ce qu'on peut proposer pour un modèle : { ok, reason, source, levels:[{q,label,note,risk,estimateBytes,warn}] }. */
export function quantOptions(asset) {
  const name = asset.file_name || '';
  if (!/\.gguf$/i.test(name) || /mmproj/i.test(name)) return { ok: false, reason: 'Seuls les modèles de langage .gguf se quantifient.' };
  if (asset.state === 'missing') return { ok: false, reason: 'Fichier absent.' };
  const src = detectQuant(name);
  if (!src || !BITS[src]) return { ok: false, reason: src === 'MXFP4' ? 'Format MXFP4 : à ne pas requantifier.' : 'Niveau de quantification d’origine inconnu : rien n’est proposé pour éviter une mauvaise surprise.' };
  const full = ['F32', 'F16', 'BF16'].includes(src);
  const gb = (asset.size_bytes || 0) / 1024 ** 3;
  const levels = LEVELS.filter((l) => BITS[l.q] <= BITS[src] * 0.85 && !(gb < 2 && l.risk >= 3) && !(gb < 1 && l.risk >= 2))
    .map((l) => ({
      ...l, estimateBytes: Math.round((asset.size_bytes || 0) * BITS[l.q] / BITS[src]),
      warn: [!full && 'Ce modèle est déjà quantifié : refaire une quantification cumule la perte (mieux vaut partir de l’original F16 / BF16 si tu l’as).', l.risk >= 2 && 'Attention : un modèle trop quantifié peut devenir mauvais.'].filter(Boolean).join(' '),
    }));
  if (!levels.length) return { ok: false, reason: `Déjà au niveau ${src} : descendre plus bas serait trop destructeur.`, source: src };
  return { ok: true, source: src, full, levels };
}

export const quantState = { running: false, assetId: null, name: '', target: '', pct: 0, step: '', error: null, doneAssetId: null, startedAt: null, outPath: null, estimateBytes: 0 };
const exeOf = (db) => getSetting(db, 'engine.quantizeExe', '') || path.join(path.dirname(engineConfig(db).exe), 'llama-quantize.exe');
const FKEY = 'models.fresh';
export const freshIds = (db) => { try { const a = JSON.parse(getSetting(db, FKEY, '[]')); return Array.isArray(a) ? a.map(Number) : []; } catch { return []; } };
export const markSeen = (db, id) => setSetting(db, FKEY, JSON.stringify(freshIds(db).filter((x) => x !== Number(id))));

export async function startQuantize(db, assetId, target) {
  if (quantState.running) throw new Error('Une quantification est déjà en cours.');
  const asset = getAsset(db, assetId); if (!asset) throw new Error('Modèle inconnu.');
  const opt = quantOptions(asset); if (!opt.ok) throw new Error(opt.reason);
  const lvl = opt.levels.find((l) => l.q === target); if (!lvl) throw new Error(`Niveau ${target} non proposé pour ce modèle.`);
  const exe = exeOf(db); if (!fs.existsSync(exe)) throw new Error(`llama-quantize introuvable : ${exe}`);
  const base = asset.abs_path.replace(/\.gguf$/i, '');
  const tail0 = new RegExp(`([-_.])${opt.source}$`, 'i');
  const out = `${tail0.test(base) ? base.replace(tail0, `$1${target}`) : `${base}-${target}`}.gguf`; const tmp = `${out}.building`;
  if (fs.existsSync(out)) throw new Error(`Le fichier existe déjà : ${out}`);
  const need = lvl.estimateBytes + 2 * 1024 ** 3;
  try { const st = fs.statfsSync(path.dirname(out)); if (st.bavail * st.bsize < need) throw new Error(`Pas assez de place sur le disque du modèle : environ ${Math.round(need / 1024 ** 3)} Go libres nécessaires.`); } catch (e) { if (/Pas assez/.test(e.message)) throw e; }
  Object.assign(quantState, { running: true, assetId: asset.id, name: asset.title || asset.file_name, target, pct: 0, step: 'démarrage…', error: null, doneAssetId: null, startedAt: Date.now(), outPath: out, estimateBytes: lvl.estimateBytes });
  const args = opt.full ? [asset.abs_path, tmp, target] : ['--allow-requantize', asset.abs_path, tmp, target];
  const p = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: /\.(cmd|bat)$/i.test(exe) });
  registerChild('quantize', p, exe);
  let tail = '';
  const feed = (b) => {
    tail = (tail + String(b)).slice(-800);
    const m = [...tail.matchAll(/\[\s*(\d+)\s*\/\s*(\d+)\]/g)].pop();
    if (m) { quantState.pct = Math.min(99, Math.round((Number(m[1]) / Number(m[2])) * 100)); quantState.step = `tenseur ${m[1]} / ${m[2]}`; }
  };
  p.stdout.on('data', feed); p.stderr.on('data', feed);
  p.on('error', (e) => { quantState.running = false; quantState.error = e.message; });
  p.on('exit', async (code) => {
    if (code === 0 && fs.existsSync(tmp)) {
      try {
        fs.renameSync(tmp, out);
        await scanPath(db, { dir: out, rootId: asset.root_id ?? undefined, minBytes: 1 });
        recordDerived(db, out, { from: asset.file_name, quant: target });
        const n = getAssetByPath(db, out);
        if (n) { quantState.doneAssetId = n.id; setSetting(db, FKEY, JSON.stringify([...new Set([...freshIds(db), n.id])])); }
        quantState.pct = 100; quantState.step = 'terminé';
      } catch (e) { quantState.error = e.message; }
    } else {
      quantState.error = `llama-quantize a échoué (code ${code}) : ${tail.trim().split(/\r?\n/).slice(-2).join(' ')}`;
      try { fs.rmSync(tmp, { force: true }); } catch { /* déjà absent */ }
    }
    quantState.running = false;
  });
  return { started: true, out };
}
