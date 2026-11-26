// File de tâches du gros modèle local : les grosses demandes ne bloquent pas la discussion. Elles attendent ici, une seule tourne à la fois
// (ressources), le texte s'écrit au fil de l'eau et la progression se lit depuis l'écran « Travail ». Persistant : un redémarrage de PAIZ
// remet en file la tâche interrompue (elle repart de zéro, le texte déjà écrit est gardé le temps de la relance).
import { addIdea } from './ideas.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { PROFILES } from './engine.js';
import { engineConfig, engineHealth, ensureSlots, restoreSlots, mainAssetId, mainLoading, auxCurrent, auxPort, startAux, stopAux } from './engine.js';
import { getAsset } from './db.js';
import { relayStatus } from './proxy.js';

// Garde-fou : une tâche de fond ne doit jamais paralyser le PC. RAM disponible (libre + cache récupérable) et VRAM libre sont surveillées ;
// sous le seuil bas la tâche est mise en PAUSE (le moteur s'arrête au prochain jeton avec un point de reprise), elle repart exacte dès que la mémoire remonte.
export const LIMITS = { ramLow: 2000, ramOk: 3000, vramLow: 700, vramOk: 1200, pollMs: 3000 };
function vramFreeMb() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true }, (e, out) => { const n = parseInt(String(out || '').trim().split(String.fromCharCode(10))[0], 10); resolve(e || !Number.isFinite(n) ? null : n); });
  });
}
let probe = async () => ({ ramMb: Math.round(os.freemem() / 1048576), vramMb: await vramFreeMb() });
export function _setProbe(fn) { probe = fn; }
async function jobCall(port, id, what) { try { const r = await fetch(`http://127.0.0.1:${port}/api/jobs/${id}/${what}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) }); return r.ok; } catch { return false; } }
const FILE = () => path.join(DATA_DIR, 'tasks.json');
const MAX_KEEP = 60;          // tâches terminées gardées
const MAX_TEXT = 400_000;     // caractères gardés par tâche
// Modèle cloud gratuit d'OpenCode : t.model = 'cloud:<id>'. La tâche passe par une session OpenCode, rien n'est chargé sur la machine.
export const isCloud = (m) => typeof m === 'string' && m.startsWith('cloud:') && m.length > 6;
const cloudName = (m) => '☁ ' + String(m).slice(6);
let auxSpeed = 'auto'; // réglage de vitesse avec lequel la mule (second moteur) tourne
let tasks = null; let running = null; let timer = null; let dbRef = null;

function load() {
  if (tasks) return tasks;
  try { const a = JSON.parse(fs.readFileSync(FILE(), 'utf8')); tasks = Array.isArray(a) ? a : []; } catch { tasks = []; }
  for (const t of tasks) if (t.status === 'running' || t.status === 'paused') { t.status = 'queued'; t.note = 'Reprise après redémarrage'; t.text = ''; t.outTok = 0; }
  return tasks;
}
let saveAt = 0;
function save(force = false) {
  if (!force && Date.now() - saveAt < 4000) return;
  saveAt = Date.now();
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE() + '.tmp', JSON.stringify(tasks)); fs.renameSync(FILE() + '.tmp', FILE()); } catch { /* disque plein : la file reste en mémoire */ }
}
const pub = (t, withText) => ({ id: t.id, title: t.title, status: t.status, note: t.note || '', maxTokens: t.maxTokens, outTok: t.outTok || 0, createdAt: t.createdAt, startedAt: t.startedAt || 0, endedAt: t.endedAt || 0,
  tps: t.tps || 0, error: t.error || '', truncated: !!t.truncated, chars: (t.text || '').length, source: t.source || '', model: t.model || 'chat', modelName: t.modelName || '', kind: t.kind || 'exec', draftId: t.draftId || '', fromPlan: t.fromPlan || '', manual: !!t.manual, project: t.project || '', workDir: t.workDir || '', speed: t.speed || 'auto', files: t.files || [], ...(withText ? { spec: t.spec, text: t.text || '' } : { tail: (t.text || '').slice(-160) }) });

const memNote = (m) => `mémoire basse (RAM ${m.ramMb} Mo${m.vramMb != null ? `, VRAM libre ${m.vramMb} Mo` : ''})`;
export function listTasks() { return load().map((t) => pub(t)); }
let queueOn = true; let runPort = 0;
export const queueState = () => ({ queueOn });
export function getTask(id) { const t = load().find((x) => x.id === id); return t ? pub(t, true) : null; }

const hooks = {};
export const setKindHook = (kind, fn) => { hooks[kind] = fn; }; // action à la fin d'une tâche d'un type donné (ex. la mémoire range le résultat)
export function addTask(db, { title, spec, maxTokens = 0, source = '', model = 'chat', status = 'queued', kind = 'exec', execModel = 'chat', planTitle = '', project = '', meta = null, files = [], speed = 'auto' }) {
  const s = String(spec || '').trim(); if (!s) throw new Error('Cahier des charges vide.');
  let mid = 'chat'; let mname = '';
  if (isCloud(model)) { mid = String(model); mname = cloudName(model); }
  else if (model && model !== 'chat') { const a = getAsset(db, Number(model)); if (!a) throw new Error('Modèle inconnu.'); mid = a.id; mname = a.title || a.file_name; }
  const t = { id: `t${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, title: String(title || s.split('\n')[0] || 'Tâche').slice(0, 90), spec: s.slice(0, 60_000),
    maxTokens: Number(maxTokens) === 0 ? 0 : Math.min(60000, Math.max(200, Number(maxTokens) || 0)), // 0 = jusqu'à la fin (le moteur s'arrête seul, ou quand son contexte est plein)
    status: 'queued', note: '', text: '', outTok: 0, createdAt: Date.now(), source: String(source || '').slice(0, 40), model: mid, modelName: mname, kind: ['plan', 'notes', 'memo'].includes(kind) ? kind : 'exec', project: String(project || ''), meta: meta || undefined, execModel: execModel || 'chat', planTitle: String(planTitle || '').slice(0, 90), files: Array.isArray(files) ? files.map(String).filter(Boolean).slice(0, 30) : [], speed: PROFILES[speed] ? speed : 'auto' };
  if (status === 'draft') t.status = 'draft';
  load().push(t); save(true); if (t.status === 'queued') kick(db); return pub(t);
}
export function editTask(db, id, p) {
  const t = load().find((x) => x.id === id); if (!t) throw new Error('Tâche inconnue.');
  if (!['draft', 'queued'].includes(t.status)) throw new Error('Seules les tâches en brouillon ou en attente se modifient.');
  if (p.title != null) t.title = String(p.title).trim().slice(0, 90) || t.title;
  if (p.spec != null) { const s = String(p.spec).trim(); if (!s) throw new Error('Cahier des charges vide.'); t.spec = s.slice(0, 60_000); }
  if (typeof p.project === 'string') t.project = p.project.slice(0, 500);
  if (typeof p.speed === 'string') t.speed = PROFILES[p.speed] ? p.speed : 'auto';
  if (Array.isArray(p.files)) t.files = p.files.map(String).filter(Boolean).slice(0, 30);
  if (p.maxTokens != null) t.maxTokens = Number(p.maxTokens) === 0 ? 0 : Math.min(60000, Math.max(200, Number(p.maxTokens) || 0));
  if (p.model != null) { if (p.model === 'chat') { t.model = 'chat'; t.modelName = ''; } else if (isCloud(p.model)) { t.model = String(p.model); t.modelName = cloudName(p.model); } else { const a = getAsset(db, Number(p.model)); if (!a) throw new Error('Modèle inconnu.'); t.model = a.id; t.modelName = a.title || a.file_name; } }
  save(true); return pub(t, true);
}
export function launchTasks(db, ids) {
  let n = 0; for (const t of load()) if (ids.includes(t.id) && t.status === 'draft') { t.status = 'queued'; t.note = ''; n++; }
  queueOn = true; save(true); kick(db); return { launched: n };
}
// Ordre de la file : les tâches données reprennent, dans l'ordre reçu, les places qu'elles occupaient.
export function reorderTasks(ids) {
  const all = load(); const pos = []; all.forEach((t, i) => { if (ids.includes(t.id)) pos.push(i); });
  const byId = new Map(all.map((t) => [t.id, t])); const ordered = ids.filter((i) => byId.has(i));
  if (ordered.length !== pos.length) throw new Error('Liste d’identifiants invalide.');
  ordered.forEach((id, k) => { all[pos[k]] = byId.get(id); }); tasks = all; save(true); return { ok: true };
}
// Pilotage global : play (reprend / lance la file), pause (pause exacte de la tâche en cours), stop (annule la tâche en cours).
export async function queueControl(db, action) {
  const cur = load().find((x) => x.status === 'running' || x.status === 'paused');
  const port = runPort || engineConfig(db).port;
  if (action === 'pause') { queueOn = false; if (cur && cur.status === 'running' && await jobCall(port, 'wst' + cur.id, 'pause')) { cur.status = 'paused'; cur.manual = true; cur.note = 'En pause'; } }
  else if (action === 'play') { queueOn = true; if (cur && cur.status === 'paused' && cur.manual && await jobCall(port, 'wst' + cur.id, 'resume')) { cur.status = 'running'; cur.manual = false; cur.note = ''; } kick(db); }
  else if (action === 'stop') { queueOn = false; if (cur) cancelTask(cur.id); }
  else throw new Error('Action inconnue.');
  save(true); return { queueOn };
}
export function cancelTask(id) {
  const t = load().find((x) => x.id === id); if (!t) throw new Error('Tâche inconnue.');
  if (t.status === 'running' || t.status === 'paused') { t.status = 'cancelled'; t.endedAt = Date.now(); t.rid = (t.rid || 0) + 1; try { running?.abort(); } catch { /* déjà fini */ } running = null; }
  else if (t.status === 'queued') { t.status = 'cancelled'; t.endedAt = Date.now(); }
  save(true); return pub(t);
}
export function retryTask(db, id) {
  const t = load().find((x) => x.id === id); if (!t) throw new Error('Tâche inconnue.');
  if (['running', 'paused', 'queued'].includes(t.status)) return pub(t);
  Object.assign(t, { status: 'queued', note: '', error: '', truncated: false, text: '', outTok: 0, startedAt: 0, endedAt: 0, tps: 0 }); save(true); kick(db); return pub(t);
}
export function removeTask(id) {
  const t = load().find((x) => x.id === id); if (!t) return { ok: true };
  if (t.status === 'running' || t.status === 'paused') cancelTask(id);
  tasks = load().filter((x) => x.id !== id); save(true); return { ok: true };
}
export function clearFinished() { tasks = load().filter((x) => ['queued', 'running', 'paused'].includes(x.status)); save(true); return { ok: true }; }

// Tâche « agent » : une session OpenCode dans le DOSSIER DU PROJET, avec ses outils (lire, écrire, lancer) : le modèle fait le travail
// sur place, comme dans la discussion. Modèle de la discussion (paiz/local) ou modèle cloud gratuit d'OpenCode.
// Fin = dernier message de l'assistant terminé SANS appel d'outil (un appel d'outil veut dire qu'une étape suivante arrive).
const agentDir = (t) => { const d = String(t.project || ''); try { if (d && fs.statSync(d).isDirectory()) return d; } catch { /* dossier disparu */ } const x = path.join(DATA_DIR, 'cloud-tasks'); fs.mkdirSync(x, { recursive: true }); return x; };
export const runsAsAgent = (t) => isCloud(t.model) || ((t.kind || 'exec') === 'exec' && !!t.project);
async function agentRun(db, t, ac, rid) {
  const W = await import('./work.js');
  const dir = agentDir(t); const cloud = isCloud(t.model);
  t.note = cloud ? 'Envoi au modèle cloud gratuit…' : 'Ouverture d’une session dans le dossier du projet…'; t.workDir = dir; save(true);
  const s = await W.createSession(db, dir, 'Tâche : ' + t.title);
  t.sessionID = s.id;
  if (cloud) await W.setSessionModel(s.id, 'opencode', t.model.slice(6));
  else if (t.model && t.model !== 'chat') await W.setSessionModel(s.id, 'paiz', 'mule'); // modèle choisi pour la tâche = second moteur
  const brief = t.project ? `Tâche de fond lancée depuis PAIZ. Dossier de travail : ${dir}\nFais le travail directement dans ce dossier (crée ou modifie les fichiers nécessaires), puis termine par un court résumé de ce que tu as fait et des fichiers touchés.\n\n` : '';
  const files = (t.files || []).length ? `Fichiers à reprendre (lis-les d'abord, puis améliore-les sur place plutôt que de repartir de zéro) :\n${t.files.map((f) => '- ' + f).join('\n')}\n\n` : '';
  await W.sendPrompt(s.id, brief + files + t.spec);
  ac.signal.addEventListener('abort', () => { W.interrupt(s.id).catch(() => {}); }, { once: true });
  const t0 = Date.now();
  for (;;) {
    if (ac.signal.aborted || t.rid !== rid) return;
    if (Date.now() - t0 > 6 * 3600e3) throw new Error('Délai dépassé (6 h).');
    await new Promise((r) => setTimeout(r, 2000));
    const r = await W.ocCall('GET', `/api/session/${encodeURIComponent(s.id)}/message?limit=200&order=asc`);
    const asst = (r?.data || []).filter((m) => m.type === 'assistant'); const last = asst[asst.length - 1]; if (!last) continue;
    const text = asst.map((m) => (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n\n')).filter(Boolean).join('\n\n');
    const tools = asst.reduce((n, m) => n + (m.content || []).filter((c) => c.type === 'tool').length, 0);
    if (text) { t.text = text.slice(-MAX_TEXT); t.outTok = Math.round(text.length / 3.4); }
    t.note = tools ? `${tools} action(s) dans le dossier` : ''; save();
    if (last.error) throw new Error(String(last.error.message || 'Erreur du modèle'));
    if (last.time?.completed && !(last.content || []).some((c) => c.type === 'tool')) return;
  }
}
async function runOne(db, t, portOverride) {
  const cfg = { ...engineConfig(db), ...(portOverride ? { port: portOverride } : {}) };
  const ac = new AbortController(); running = ac; const jobId = `wst${t.id}`;
  runPort = cfg.port;
  const rid = (t.rid = (t.rid || 0) + 1); // numéro d'exécution : une ancienne exécution qui finit de s'arrêter n'écrase jamais une relance
  t.status = 'running'; t.startedAt = Date.now(); t.note = ''; t.text = ''; t.outTok = 0; save(true);
  let first = 0; let paused = false;
  const agent = runsAsAgent(t);
  const guard = agent ? null : setInterval(async () => {
    if (t.rid !== rid || t.status !== 'running' && t.status !== 'paused') return;
    const m = await probe();
    const low = m.ramMb < LIMITS.ramLow || (m.vramMb != null && m.vramMb < LIMITS.vramLow);
    const ok = m.ramMb >= LIMITS.ramOk && (m.vramMb == null || m.vramMb >= LIMITS.vramOk);
    if (!paused && low) { if (await jobCall(cfg.port, jobId, 'pause')) { paused = true; t.status = 'paused'; t.note = 'En pause : ' + memNote(m); } }
    else if (paused && ok && !t.manual) { if (await jobCall(cfg.port, jobId, 'resume')) { paused = false; t.status = 'running'; t.note = ''; } }
    else if (paused) t.note = 'En pause : ' + memNote(m);
  }, LIMITS.pollMs);
  try {
    if (agent) await agentRun(db, t, ac, rid); else {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([ac.signal, AbortSignal.timeout(6 * 3600 * 1000)]),
      body: JSON.stringify({ model: 'local', messages: [{ role: 'user', content: t.spec }], max_tokens: t.maxTokens || 60000, temperature: 0.4, ws_job: jobId, stream: true, stream_options: { include_usage: true } }) });
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
        if (j.usage?.completion_tokens) t.outTok = j.usage.completion_tokens;
        if (j.choices?.[0]?.finish_reason === 'length') t.truncated = true;
        if (t.rid !== rid) return;
        const d = j.choices?.[0]?.delta?.content;
        if (d) { if (!first) first = Date.now(); if (t.text.length < MAX_TEXT) t.text += d; if (!j.usage) t.outTok++; if (first && Date.now() > first + 2000) t.tps = +(t.outTok / ((Date.now() - first) / 1000)).toFixed(2); save(); }
      }
    }
    }
    if (t.rid === rid && (t.status === 'running' || t.status === 'paused')) {
      t.status = 'done'; t.endedAt = Date.now();
      if (hooks[t.kind]) { try { hooks[t.kind](db, t); } catch { /* sans effet sur la tâche */ } if (t.kind === 'memo') { const a = load(); const i = a.indexOf(t); if (i >= 0) a.splice(i, 1); } }
      if (t.kind === 'notes') { // le modèle a répondu à une consigne sur la To-do : ses éléments sont ajoutés au bloc-notes du projet
        let items = [];
        try { const m = t.text.match(/\[[\s\S]*\]/); const a = JSON.parse(m ? m[0] : t.text); items = (Array.isArray(a) ? a : [a]).filter((x) => x && (x.title || x.body)); } catch { /* texte libre */ }
        if (!items.length && t.text.trim()) items = [{ title: t.planTitle || 'Note', body: t.text.trim() }];
        let n = 0; for (const x of items.slice(0, 30)) { try { addIdea({ project: t.project, title: String(x.title || ''), body: String(x.body || ''), source: 'modèle' }); n++; } catch { /* vide */ } }
        t.note = n ? `${n} élément${n > 1 ? 's' : ''} ajouté${n > 1 ? 's' : ''} à la To-do` : 'Rien à noter';
      }
      if (t.kind === 'plan' && t.text.trim()) { // un plan terminé devient un brouillon de tâche, à relire avant de lancer
        const d = { id: 't' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), title: t.planTitle || t.title, spec: t.text.trim(), maxTokens: 0, status: 'draft', note: '', text: '', outTok: 0, createdAt: Date.now(), source: 'plan', model: t.execModel || 'chat', modelName: '', kind: 'exec', fromPlan: t.id };
        if (d.model !== 'chat' && !isCloud(d.model)) { const a = getAsset(db, Number(d.model)); if (a) { d.modelName = a.title || a.file_name; d.model = a.id; } else d.model = 'chat'; } if (isCloud(d.model)) d.modelName = cloudName(d.model);
        load().push(d); t.draftId = d.id; t.note = 'Plan prêt : brouillon ajouté';
      }
    }
  } catch (e) {
    if (t.rid !== rid || t.status === 'cancelled') { /* arrêt voulu */ } else { t.status = 'failed'; t.error = String(e.message || e).slice(0, 300); t.endedAt = Date.now(); }
  } finally { clearInterval(guard); if (t.rid === rid) running = null; save(true); }
}

let stepping = false; let idleSince = 0;
async function step() {
  if (running || stepping) return;
  stepping = true; // verrou posé avant tout await : deux appels rapprochés ne lancent jamais deux tâches
  try {
    const t = queueOn ? load().find((x) => x.status === 'queued') : null;
    if (!t) { // plus rien à faire : le second moteur se décharge après 30 s, la conversation en trop après 90 s (si aucune discussion n'est en cours)
      idleSince ||= Date.now();
      if (auxCurrent() && Date.now() - idleSince > 30000) await stopAux().catch(() => {});
      if (Date.now() - idleSince > 90000 && !relayStatus().active) { idleSince = 0; await restoreSlots(dbRef).catch(() => {}); }
      return;
    }
    idleSince = 0;
    const cloud = isCloud(t.model);
    const mid = !cloud && t.model && t.model !== 'chat' ? Number(t.model) : 0;
    let port = 0;
    if (cloud) { /* modèle cloud : rien à charger localement */ } else if (mid && mainAssetId() !== mid) { // autre modèle que celui de la discussion : second moteur, lancé à la demande
      const asset = getAsset(dbRef, mid);
      if (!asset) { t.status = 'failed'; t.error = 'Modèle introuvable.'; t.endedAt = Date.now(); save(true); return; }
      const sp = PROFILES[t.speed] ? t.speed : 'auto';
      if (auxCurrent()?.assetId !== mid || auxSpeed !== sp) {
        if (mainLoading()) { t.note = 'En attente : le modèle de la discussion finit de charger'; return; }
        const m = await probe();
        if (m.ramMb < 6000 || (m.vramMb != null && m.vramMb < 3600)) { t.note = 'En attente : pas assez de mémoire pour lancer ' + (t.modelName || 'le modèle') + ' (RAM ' + m.ramMb + ' Mo' + (m.vramMb != null ? ', VRAM libre ' + m.vramMb + ' Mo' : '') + ')'; return; }
        // cache d'experts = VRAM libre - ~2,5 Go de poids fixes et de contexte 32 k - 1,4 Go de marge pour l'écran (mesuré : Qwen3-Coder-Next 1,5 Go de cache => ~3,4 Go)
        const cache = m.vramMb == null ? 1500 : Math.max(700, Math.min(7000, Math.floor((m.vramMb - 2500 - 1400) / 500) * 500));
        t.note = 'Chargement de ' + (t.modelName || 'le modèle') + '…'; save(true);
        const prof = PROFILES[sp]; const arg = (k) => (prof ? Number(prof[prof.indexOf(k) + 1]) || null : null);
        try { await startAux(dbRef, { asset, cacheMib: arg('--cache-mib') || cache, ramMib: arg('--ws-ram-mib') || 2000 }); auxSpeed = sp; } catch (e) { t.status = 'failed'; t.error = String(e.message || e).slice(0, 300); t.endedAt = Date.now(); t.note = ''; save(true); return; }
      }
      t.note = ''; port = auxPort(dbRef);
    } else {
      if (!(await engineHealth(engineConfig(dbRef)))) { t.note = 'En attente : aucun modèle local chargé'; return; }
      t.note = "Ouverture d'une conversation parallèle…"; await ensureSlots(dbRef, 2).catch(() => {}); t.note = '';
    }
    await runOne(dbRef, t, port);
    // on ne garde que les dernières tâches terminées
    const done = load().filter((x) => !['queued', 'running', 'paused'].includes(x.status));
    if (done.length > MAX_KEEP) { const drop = new Set(done.slice(0, done.length - MAX_KEEP).map((x) => x.id)); tasks = load().filter((x) => !drop.has(x.id)); save(true); }
  } finally { stepping = false; }
}
export function kick(db) { dbRef = db || dbRef; if (!timer) { timer = setInterval(() => { step().catch(() => {}); }, 3000); timer.unref?.(); } step().catch(() => {}); }
export function startTasks(db) { dbRef = db; load(); kick(db); }
export function _resetForTests() { tasks = null; running = null; if (timer) { clearInterval(timer); timer = null; } }
