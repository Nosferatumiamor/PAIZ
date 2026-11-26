// Préchauffage du prompt : au chargement d'un modèle de taille raisonnable, le moteur lit une fois le début de prompt qu'OpenCode envoie
// à chaque conversation (consignes + outils, tels que le proxy les a allégés). Quand l'utilisateur écrit son premier message, ce début est
// déjà en mémoire du moteur : seul son message reste à lire. Le début de prompt est repris de la dernière vraie requête vue pour ce modèle.
// Les très gros modèles sont exclus : lire un prompt y prend trop de temps pour le cacher dans une barre de chargement.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

export const WARM_MAX_BYTES = 40e9; // au-delà, pas de préchauffage
const FILE = () => path.join(DATA_DIR, 'warm-prefix.json');
const DROP = ['messages', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'ws_job', 'ws_checkpoint_s', 'tool_choice', 'n'];

function readAll() { try { const o = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
function writeAll(o) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE() + '.tmp', JSON.stringify(o)); fs.renameSync(FILE() + '.tmp', FILE()); } catch { /* disque plein : tant pis */ } }

// Garde le début de prompt (messages « system » + outils) d'une vraie requête de l'agent. Les requêtes sans outils (titres, tests) sont ignorées.
export function capturePrefix(modelPath, j) {
  if (!modelPath || !j || !Array.isArray(j.tools) || !j.tools.length || !Array.isArray(j.messages)) return false;
  const sys = j.messages.filter((m) => m && (m.role === 'system' || m.role === 'developer'));
  if (!sys.length || j.messages[0]?.role !== 'system') return false;
  const body = {}; for (const k of Object.keys(j)) if (!DROP.includes(k)) body[k] = j[k];
  body.messages = sys;
  const hash = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  const all = readAll();
  if (all[modelPath]?.hash === hash) return false;
  all[modelPath] = { savedAt: Date.now(), hash, body };
  const keys = Object.keys(all).sort((a, b) => (all[b].savedAt || 0) - (all[a].savedAt || 0)).slice(0, 8);
  writeAll(Object.fromEntries(keys.map((k) => [k, all[k]])));
  return true;
}
export function loadPrefix(modelPath) { return readAll()[modelPath] || null; }

// Requête de chauffe : le même début de prompt, un message utilisateur minimal, un seul jeton demandé, sans flux.
export function buildWarmBody(entry) {
  return { ...entry.body, model: 'local', messages: [...entry.body.messages, { role: 'user', content: '.' }], max_tokens: 1, stream: false };
}

export async function warmEngine({ port, modelPath, sizeBytes, enabled = true, timeoutMs = 300000 }) {
  if (!enabled) return { skipped: 'désactivé' };
  if (sizeBytes > WARM_MAX_BYTES) return { skipped: 'modèle trop gros' };
  const entry = loadPrefix(modelPath);
  if (!entry) return { skipped: 'aucun début de prompt connu pour ce modèle' };
  const t0 = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildWarmBody(entry)), signal: AbortSignal.timeout(timeoutMs) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: d?.error?.message || `HTTP ${r.status}`, seconds: (Date.now() - t0) / 1000 };
    return { ok: true, seconds: (Date.now() - t0) / 1000, promptTokens: d.usage?.prompt_tokens || 0 };
  } catch (e) { return { ok: false, error: String(e.message || e), seconds: (Date.now() - t0) / 1000 }; }
}
