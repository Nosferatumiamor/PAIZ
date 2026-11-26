// Bloc-notes du projet (« To-do ») : idées importantes à ne pas perdre, rattachées à un projet (dossier). Stockées dans PAIZ, pas dans le dépôt.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const FILE = () => path.join(DATA_DIR, 'ideas.json');
const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
function readAll() { try { const a = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function writeAll(a) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE() + '.tmp', JSON.stringify(a)); fs.renameSync(FILE() + '.tmp', FILE()); } catch { /* disque plein */ } }

export function listIdeas(project) { const k = norm(project); return readAll().filter((i) => !k || norm(i.project) === k); }
export function addIdea({ project, title, body = '', source = '' }) {
  const t = String(title || '').trim().replace(/\s+/g, ' ').slice(0, 120) || String(body || '').trim().split('\n')[0].slice(0, 80);
  if (!t) throw new Error('Idée vide.');
  const i = { id: `i${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, project: String(project || ''), title: t, body: String(body || '').slice(0, 20_000), source: String(source || '').slice(0, 40), createdAt: Date.now() };
  const a = readAll(); a.push(i); writeAll(a); return i;
}
export function updateIdea(id, patch) {
  const a = readAll(); const i = a.find((x) => x.id === id); if (!i) throw new Error('Idée inconnue.');
  if (patch.title != null) i.title = String(patch.title).trim().slice(0, 120) || i.title;
  if (patch.body != null) i.body = String(patch.body).slice(0, 20_000);
  writeAll(a); return i;
}
export function removeIdea(id) { writeAll(readAll().filter((x) => x.id !== id)); return { ok: true }; }
