// Second moteur : llama.cpp « standard » récent (llama-server), pour les modèles que notre moteur WeightStream ne connaît pas encore.
// Notre moteur reste le moteur par défaut (Gemma, Qwen... et leurs réglages ne changent pas) ; ce second moteur ne prend en charge que les
// architectures listées ci-dessous (Inkling 2 : `inkling2_loop`, absente du llama.cpp que nous avons patché).
// Réglages mesurés le 25/11/2026 sur Inkling 2 Mini (Q4, 16,6 Go ; RTX 3060 12 Go ; 32 Go de RAM ; modèle sur NVMe) :
//  - `--cpu-moe` : les experts (97 % du modèle) restent en RAM, mappés depuis le SSD (pages récupérables par Windows) ;
//  - `--no-op-offload` : sans lui, llama.cpp réserve ≈ 7 Go de VRAM de calcul pour envoyer les experts au GPU ; avec, la VRAM tombe de
//    ≈ 10 Go à ≈ 3,3 Go pour la même vitesse de génération (≈ 7 tok/s) ; coût : le prompt se lit au processeur (≈ 18 tok/s) ;
//  - plafond dur de RAM (ws_run_capped) : sans plafond 7 tok/s (16,5 Go de pages mappées) ; 8 Go ≈ 4 tok/s ; 4 Go ≈ 3,5 tok/s.
//    ATTENTION : c'est un plafond du working set du processus. Windows garde les pages retirées dans son cache de fichiers (68 Mo lus
//    sur le SSD pendant toute une génération à 4 Go, mesuré) : le ralentissement vient des défauts de page, pas du SSD, et la RAM de la
//    machine n'est pas libérée tant qu'aucun autre programme ne la réclame (le cache est alors rendu). Ce n'est PAS une machine à 4 Go.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getSetting } from './db.js';
import { findEngineDir } from './enginedir.js';
import { readGgufHeader } from './detect.js';

export const STOCK_ARCHS = ['inkling2_loop']; // réglage engine.stockArchs (liste séparée par des virgules) pour en ajouter

export function stockConfig(db) {
  const engineDir = process.env.WS_HOME || getSetting(db, 'engine.dir', null) || findEngineDir() || 'D:\\005-GIT\\PAIZ\\engine';
  const dir = process.env.WS_STOCK_HOME || getSetting(db, 'engine.stockDir', null) || path.join(engineDir, 'stock-llama');
  return {
    dir,
    exe: path.join(dir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
    capExe: path.join(engineDir, 'build-llama', 'bin', 'ws_run_capped.exe'),
    reasoning: String(getSetting(db, 'engine.stockReasoning', 'off')) === 'on', // Inkling réfléchit très longuement : coupé par défaut
  };
}

/** Ce modèle doit-il tourner sur le second moteur ? (architecture lue dans l'en-tête GGUF) */
export async function isStockModel(db, absPath) {
  let arch = null;
  try { arch = (await readGgufHeader(absPath))?.arch || null; } catch { /* fichier illisible : moteur habituel */ }
  if (!arch) return false;
  const extra = String(getSetting(db, 'engine.stockArchs', '')).split(',').map((s) => s.trim()).filter(Boolean);
  return [...STOCK_ARCHS, ...extra].includes(arch);
}

// Les modes de PAIZ gardent leurs noms ; sur ce moteur ils se traduisent en plafond de RAM (la VRAM reste basse dans tous les cas).
export const STOCK_TIERS = {
  sobre: { capMib: 4096, label: 'RAM plafonnée à 4 Go', tps: 3.5 },
  equilibre: { capMib: 8192, label: 'RAM plafonnée à 8 Go', tps: 4 },
  libre: { capMib: 0, label: 'RAM libre (le fichier se mappe en entier)', tps: 7 },
};
const TIER_OF = {
  eco: 'sobre', leger: 'sobre', dialogue: 'sobre', discret: 'sobre', cpu: 'sobre',
  normal: 'equilibre', partage: 'equilibre', paliers: 'equilibre',
  confort: 'libre', ram8: 'libre', vif: 'libre', rapide: 'libre', tache: 'libre', fond: 'libre',
};
export const stockTier = (profile) => TIER_OF[profile] || 'equilibre';
export const stockPlan = (profile) => ({ tier: stockTier(profile), ...STOCK_TIERS[stockTier(profile)] });

export function stockArgs(db, { model, port, ctx, slots }) {
  const c = stockConfig(db);
  const a = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-c', String(ctx), '-np', String(slots || 1), '-ngl', '99', '--cpu-moe', '--no-op-offload'];
  if (!c.reasoning) a.push('--reasoning-budget', '0', '--reasoning-effort', 'minimal');
  return a;
}

/** Arrête un moteur lancé par PAIZ avec tous ses enfants (ws_run_capped ne tue pas son enfant). */
export function killTree(proc) {
  if (!proc || !proc.pid || proc.exitCode !== null) return;
  if (process.platform === 'win32') { try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); } catch { /* déjà arrêté */ } }
  else { try { proc.kill(); } catch { /* déjà arrêté */ } }
}

export const stockMissingMessage = (c) => `Ce modèle a besoin du moteur secondaire (llama.cpp récent), introuvable : ${c.exe}. Installe-le avec engine\\scripts\\fetch-stock-llama.ps1 (dépôt PAIZ), ou indique son dossier dans le réglage engine.stockDir.`;
