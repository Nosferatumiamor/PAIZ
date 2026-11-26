// Archive des projets de l'écran Travail : mémorisés dans la base de PAIZ (pas dans le navigateur), localisables, avec taille à la demande.
// Les conversations OpenCode, elles, vivent déjà dans le dossier de données de PAIZ ; ici on garde la liste des dossiers de travail et la corbeille.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getSetting, setSetting } from './db.js';

const KEY = 'work.projects';
const norm = (d) => String(d || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

function read(db) {
  try { const o = JSON.parse(getSetting(db, KEY, '{}')); return { projects: Array.isArray(o.projects) ? o.projects : [], trash: Array.isArray(o.trash) ? o.trash : [] }; } catch { return { projects: [], trash: [] }; }
}
const write = (db, o) => setSetting(db, KEY, JSON.stringify(o));

export function listProjects(db) {
  const o = read(db);
  return { projects: o.projects.map((p) => ({ ...p, exists: fs.existsSync(p.dir) })), trash: o.trash };
}

// body : { projects?: [dir], trash?: [{dir,sid?,title?,at}] } — remplace la liste (en gardant la date d'ajout de chaque projet)
export function saveProjects(db, body = {}) {
  const old = read(db); const byKey = new Map(old.projects.map((p) => [norm(p.dir), p]));
  const now = new Date().toISOString(); const seen = new Set(); const projects = [];
  for (const d of Array.isArray(body.projects) ? body.projects : old.projects.map((p) => p.dir)) {
    const dir = String(typeof d === 'string' ? d : d?.dir || '').trim(); const k = norm(dir);
    if (!dir || seen.has(k)) continue; seen.add(k);
    projects.push({ dir, addedAt: byKey.get(k)?.addedAt || now });
  }
  const trash = Array.isArray(body.trash) ? body.trash.filter((t) => t && typeof t.dir === 'string').slice(0, 500) : old.trash;
  write(db, { projects, trash });
  return listProjects(db);
}

// taille d'un dossier de projet (parcours borné : 12 s / 300 000 fichiers), pour un futur ménage
export async function folderSize(dir) {
  if (!dir || !fs.existsSync(dir)) throw new Error('Dossier introuvable.');
  const t0 = Date.now(); let bytes = 0; let files = 0; let partial = false;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() - t0 > 12000 || files > 300000) { partial = true; break; }
    const d = stack.pop(); let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { bytes += (await fsp.stat(p)).size; files++; } catch { /* fichier disparu */ } }
    }
  }
  return { bytes, files, partial };
}

export function revealFolder(dir) {
  if (!dir || !fs.existsSync(dir)) throw new Error('Dossier introuvable.');
  if (process.platform === 'win32') spawn('explorer.exe', [path.resolve(dir)], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
}
