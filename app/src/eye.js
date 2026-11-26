// « L'œil » : décrit une image pour les modèles qui ne voient pas (Qwen coder, etc.). Le relais /v1 de PAIZ remplace les images
// des requêtes par cette description. Utilise un petit modèle de vision (ex. Qwen3-VL 4B + son mmproj), sur PROCESSEUR (aucune VRAM), lancé à la demande et arrêté après un temps d'inactivité.
// Modèles attendus dans <données PAIZ>/eye/ (vision-model.gguf et vision-mmproj.gguf), ou indiqués par variables d'environnement : PAIZ_EYE_MODEL, PAIZ_EYE_MMPROJ, PAIZ_EYE_EXE, PAIZ_EYE_PORT, PAIZ_EYE_IDLE_S.
import { findEngineDir } from './enginedir.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerChild } from './orphans.js';
import { DATA_DIR } from './config.js';

const env = process.env;
const MODEL = env.PAIZ_EYE_MODEL || path.join(DATA_DIR, 'eye', 'vision-model.gguf');
const MMPROJ = env.PAIZ_EYE_MMPROJ || path.join(DATA_DIR, 'eye', 'vision-mmproj.gguf');
const EXE = env.PAIZ_EYE_EXE || [path.join(findEngineDir() || '', 'build-llama', 'bin', 'llama-server.exe')].find((p) => fs.existsSync(p));
const PORT = Number(env.PAIZ_EYE_PORT || 8092);
const IDLE_MS = Number(env.PAIZ_EYE_IDLE_S || 600) * 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const DESCRIBE = 'Describe this image in rich, factual detail for someone who cannot see it (6-9 sentences). Cover the objects, layout, colors, any people, and transcribe ANY visible text exactly (code, error messages, UI labels). Do not guess identities. No preamble.';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };

let child = null; let lastUsed = 0; let busy = false;
let mode = 'demand';
export const EYE_MODES = ['live', 'demand', 'off'];
export function eyeMode() { return mode; }
/** Change le mode de l'œil : live le lance tout de suite, off l'arrête. */
export function setEyeMode(m) {
  if (!EYE_MODES.includes(m)) throw new Error('Mode inconnu.');
  mode = m;
  if (m === 'off') { try { child?.kill(); } catch { /* déjà arrêté */ } child = null; }
  if (m === 'live') ensureEye().catch(() => { /* lancé au premier usage */ });
}
export async function eyeStatus() { return { mode, running: await healthy() }; }
const healthy = async () => { try { return (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };

async function ensureEye() {
  if (await healthy()) return;
  if (!EXE || !fs.existsSync(EXE)) throw new Error('llama-server.exe introuvable (variable PAIZ_EYE_EXE).');
  if (!fs.existsSync(MODEL) || !fs.existsSync(MMPROJ)) throw new Error(`Modèle de vision absent : mets un modèle Qwen3-VL (.gguf) et son mmproj dans ${path.join(DATA_DIR, 'eye')} sous les noms vision-model.gguf et vision-mmproj.gguf (ou variables PAIZ_EYE_MODEL / PAIZ_EYE_MMPROJ).`);
  child = spawn(EXE, ['-m', MODEL, '--mmproj', MMPROJ, '--host', '127.0.0.1', '--port', String(PORT), '--ctx-size', '4096', '--parallel', '1', '-ngl', '0', '--reasoning', 'off', '--no-mmproj-offload'],
    { cwd: path.dirname(EXE), windowsHide: true, stdio: 'ignore' });
  registerChild('oeil', child, EXE);
  child.on('exit', () => { child = null; });
  for (let i = 0; i < 240; i++) {
    lastUsed = Date.now();
    if (!child && !(await healthy())) throw new Error("L'œil n'a pas démarré.");
    if (await healthy()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("L'œil n'a pas répondu à temps.");
}

export async function describeImage({ path: file, dataUrl, question }) {
  if (mode === 'off') throw new Error("l'œil de PAIZ est éteint (bouton 👁 en haut de la discussion)");
  let url = dataUrl;
  if (!url) {
    const abs = path.resolve(String(file || ''));
    const mime = MIME[path.extname(abs).toLowerCase()];
    if (!mime) throw new Error('Format non pris en charge (png, jpg, webp, gif, bmp).');
    if (!fs.existsSync(abs)) throw new Error(`Fichier introuvable : ${abs}`);
    if (fs.statSync(abs).size > 20 * 1048576) throw new Error('Image trop lourde (> 20 Mo).');
    url = `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
  }
  busy = true; lastUsed = Date.now();
  try {
    await ensureEye();
    const prompt = question ? `Answer this question about the image, precisely and factually: ${question}` : DESCRIBE;
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(600000),
      body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url } }] }], max_tokens: 400, temperature: 0.2 }),
    });
    if (!r.ok) throw new Error(`L'œil a répondu HTTP ${r.status}`);
    return ((await r.json()).choices?.[0]?.message?.content || '').trim() || '(aucune description)';
  } finally { busy = false; lastUsed = Date.now(); }
}

setInterval(() => { if (mode === 'demand' && child && !busy && Date.now() - lastUsed > IDLE_MS) { child.kill(); child = null; } }, 30000).unref();
const stopAll = () => { try { child?.kill(); } catch { /* déjà arrêté */ } };
process.on('exit', stopAll);

export const stopEye = stopAll;
