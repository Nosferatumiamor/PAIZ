// Garde-fous de l'écran Travail : ce que le modèle (via OpenCode) n'a pas le droit de toucher, même avec « toutes les permissions ».
// Mécanisme : règles de permission d'OpenCode posées à la création de la session (la dernière règle qui correspond l'emporte,
// donc les refus passent APRÈS « tout autoriser »). Vérifié sur un vrai OpenCode avec un faux modèle (voir test/guard.mjs) :
//  - action `external_directory` : tout accès hors du dossier du projet, comparé au chemin (insensible à la casse, / ou \) ;
//  - action `shell` : la commande entière, `*` = n'importe quoi.
// Les dossiers du projet lui-même restent libres : c'est là que le modèle a le droit de travailler.
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { getSetting, listRoots } from './db.js';
import { SKILLS_ON } from './skills.js';

const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '');
const fwd = (p) => p.replace(/\\/g, '/');

// Dossiers protégés : système, secrets de l'utilisateur, données de PAIZ, dossiers de modèles de PAIZ (+ ajouts de l'utilisateur).
export function protectedPaths(db) {
  const home = os.homedir();
  const env = process.env;
  const list = [
    env.SystemRoot || 'C:\\Windows', env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData,
    path.join(home, 'AppData'), path.join(home, '.ssh'), path.join(home, '.gnupg'), path.join(home, '.aws'), path.join(home, '.azure'),
    path.join(home, '.claude'), path.join(home, '.config'), path.join(home, 'NTUSER.DAT'),
    DATA_DIR,
  ];
  try { for (const r of listRoots(db)) if (r?.path) list.push(r.path); } catch { /* base pas prête */ }
  try { const extra = JSON.parse(getSetting(db, 'work.protected', '[]')); if (Array.isArray(extra)) list.push(...extra.filter((x) => typeof x === 'string' && x.trim())); } catch { /* réglage illisible */ }
  const seen = new Set(); const out = [];
  for (const p of list) { if (!p) continue; const n = norm(p); const k = n.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(n); } }
  return out;
}

// Dossiers qu'on ne peut pas choisir comme projet (le modèle y aurait tous les droits).
export function assertProjectAllowed(db, folder) {
  const f = norm(folder).toLowerCase();
  const home = norm(os.homedir()).toLowerCase();
  if (/^[a-z]:$/.test(f)) throw new Error(`« ${folder} » est la racine d'un disque : choisis un sous-dossier précis pour le projet.`);
  if (f === home) throw new Error('Ton dossier personnel entier ne peut pas être un projet : choisis un sous-dossier.');
  for (const p of protectedPaths(db)) {
    const pl = p.toLowerCase();
    if (f === pl || f.startsWith(pl + path.sep)) throw new Error(`« ${folder} » est protégé (${p}) : le modèle n'a pas le droit de travailler là.`);
  }
}

// Verbes qui détruisent ou déplacent des fichiers, avec lesquels on ne veut pas voir un dossier protégé.
const VERBS = ['del', 'erase', 'rd', 'rmdir', 'rm', 'Remove-Item', 'ri', 'mv', 'move', 'Move-Item', 'ren', 'rename', 'Rename-Item', 'takeown', 'icacls', 'attrib'];
// Commandes qui n'ont jamais leur place dans un travail de programmation.
const NEVER = ['format *', 'format.com*', 'diskpart*', 'bcdedit*', 'shutdown*', 'reg delete*', 'reg add*', 'mkfs*', 'dd if=*', 'cipher /w*', 'vssadmin delete*', 'wmic * delete*', 'Stop-Computer*', 'Restart-Computer*', 'Clear-Disk*', 'Format-Volume*', 'Remove-Partition*', 'Set-ExecutionPolicy*', 'rm -rf /', 'rm -rf /*', 'rm -rf ~*', 'rm -rf $HOME*', 'rm -fr ~*'];

export function guardRules(db) {
  const rules = [{ action: '*', resource: '*', effect: 'allow' }];
  const deny = (action, resource) => rules.push({ action, resource, effect: 'deny' });
  for (const p of protectedPaths(db)) {
    deny('external_directory', p); deny('external_directory', `${fwd(p)}/**`);
    for (const v of VERBS) { deny('shell', `*${v} *${p}*`); deny('shell', `*${v} *${fwd(p)}*`); }
  }
  for (const c of NEVER) deny('shell', c);
  // les skills activés vivent dans le dossier de données (protégé) mais restent lisibles : leurs références et scripts en ont besoin
  rules.push({ action: 'external_directory', resource: SKILLS_ON, effect: 'allow' }, { action: 'external_directory', resource: `${fwd(SKILLS_ON)}/**`, effect: 'allow' });
  return rules;
}
