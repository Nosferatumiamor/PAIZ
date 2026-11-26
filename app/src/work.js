// Écran « Travail » : PAIZ pilote OpenCode par son serveur local privé (`opencode serve`, API HTTP + flux SSE) au lieu de
// réutiliser son interface web. Le serveur est lancé par PAIZ (config PAIZ, données isolées dans .data/opencode : la config et
// les sessions habituelles de l'utilisateur ne sont pas touchées), le mot de passe est lu sur sa sortie et injecté par PAIZ :
// le navigateur ne le voit jamais et n'a rien à saisir.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { opencodeConfig, opencodeExe } from './engine.js';
import { registerChild } from './orphans.js';
import { guardRules, assertProjectAllowed } from './guard.js';
import { mcpConfig } from './mcp.js';
import { SKILLS_ON, ensureSkillDirs } from './skills.js';
import { getSetting, setSetting } from './db.js';

let oc = null; // { proc, port, auth, base, ready }
let starting = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function killTree(p) {
  if (!p?.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else p.kill();
  } catch { /* déjà arrêté */ }
}
process.on('exit', () => { if (oc?.proc) killTree(oc.proc); });

export function ocStatus() {
  return { running: !!oc?.ready, pid: oc?.proc?.pid || null, port: oc?.port || null };
}

// Lance (une seule fois) le serveur OpenCode privé. `paizPort` : port où le navigateur atteint PAIZ (le relais /v1 qui porte le modèle).
export async function ensureOpencode(db, paizPort) {
  if (oc?.ready && oc.proc.exitCode === null && oc.paizPort === paizPort) return oc;
  if (starting) return starting;
  starting = (async () => {
    if (oc?.proc) { killTree(oc.proc); oc = null; }
    const exe = opencodeExe();
    if (!exe) throw new Error('OpenCode introuvable (installe-le, ou renseigne la variable OPENCODE_EXE).');
    const root = path.join(DATA_DIR, 'opencode');
    const dirs = { data: path.join(root, 'data'), state: path.join(root, 'state'), cache: path.join(root, 'cache'), config: path.join(root, 'config') };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    const conf = path.join(root, 'opencode-paiz.json');
    const cfg = opencodeConfig(db, 'local');
    cfg.provider.paiz.options.baseURL = `http://127.0.0.1:${paizPort}/v1`;
    ensureSkillDirs(); cfg.skills = { paths: [SKILLS_ON] }; // skills activés dans l'onglet Outils
    const mc = mcpConfig(db);
    if (Object.keys(mc).length) cfg.mcp = mc; // serveurs MCP activés dans l'onglet Outils
    cfg.provider.paiz.options.headers = { 'X-Paiz-Persona': '1' }; // repère les requêtes de l'écran Travail : seules elles reçoivent le « caractère » du modèle
    fs.writeFileSync(conf, JSON.stringify(cfg, null, 2));
    const port = await freePort();
    const proc = spawn(exe, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      env: { ...process.env, OPENCODE_CONFIG: conf, XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state, XDG_CACHE_HOME: dirs.cache, XDG_CONFIG_HOME: dirs.config },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    registerChild('opencode', proc, exe);
    const cur = { proc, port, paizPort, auth: null, base: `http://127.0.0.1:${port}`, ready: false };
    let out = '';
    const onData = (b) => {
      out += String(b);
      const m = out.match(/server password\s+(\S+)/);
      if (m && !cur.auth) cur.auth = `Basic ${Buffer.from(`opencode:${m[1]}`).toString('base64')}`;
    };
    proc.stdout.on('data', onData); proc.stderr.on('data', onData);
    proc.on('exit', () => { cur.ready = false; if (oc === cur) oc = null; });
    const t0 = Date.now();
    while (!cur.auth && proc.exitCode === null && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 150));
    if (!cur.auth) { killTree(proc); throw new Error(`OpenCode n'a pas démarré : ${out.slice(-300) || 'aucune sortie'}`); }
    // attend que l'API réponde réellement
    for (; Date.now() - t0 < 30000;) {
      try { const r = await ocFetch(cur, 'GET', '/api/info'); if (r.status === 200) break; } catch { /* pas prêt */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    cur.ready = true; oc = cur; startUsageSampler(db);
    return cur;
  })();
  try { return await starting; } finally { starting = null; }
}

export function stopOpencode() { if (oc?.proc) killTree(oc.proc); oc = null; }
// Relance OpenCode pour qu'il relise la liste des serveurs MCP (les conversations sont gardées sur disque ; un travail en cours est interrompu).
export async function restartOpencode(db, paizPort) { stopOpencode(); return ensureOpencode(db, paizPort); }

function ocFetch(o, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: o.port, path: pathname, method, headers: { Authorization: o.auth, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, (m) => {
      const c = []; m.on('data', (x) => c.push(x)); m.on('end', () => {
        const t = Buffer.concat(c).toString('utf8'); let j = null; try { j = JSON.parse(t); } catch { /* pas du JSON */ }
        resolve({ status: m.statusCode, json: j, text: t });
      });
    });
    r.on('error', reject); r.end(data);
  });
}
export async function ocCall(method, pathname, body) {
  if (!oc?.ready) throw new Error('OpenCode n\'est pas lancé (ouvre l\'onglet Travail).');
  const r = await ocFetch(oc, method, pathname, body);
  if (r.status >= 400) throw new Error(r.json?.message || `OpenCode ${r.status}`);
  return r.json;
}

// Relais transparent navigateur → /api/* d'OpenCode (flux SSE compris), avec l'authentification injectée par PAIZ.
export function proxyOc(req, res, pathname, search) {
  if (!oc?.ready) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'OpenCode n\'est pas lancé.' })); return; }
  const target = `/api${pathname.slice('/oc'.length)}${search || ''}`;
  const headers = { Authorization: oc.auth };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (req.headers['content-length']) headers['Content-Length'] = req.headers['content-length'];
  if (req.headers.accept) headers.Accept = req.headers.accept;
  const up = http.request({ host: '127.0.0.1', port: oc.port, path: target, method: req.method, headers, timeout: 0 }, (m) => {
    const h = { 'Content-Type': m.headers['content-type'] || 'application/json', 'Cache-Control': 'no-cache' };
    res.writeHead(m.statusCode, h);
    m.pipe(res);
    res.on('close', () => m.destroy());
  });
  up.setTimeout(0);
  up.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); });
  res.on('close', () => { if (!res.writableEnded) up.destroy(); });
  req.pipe(up);
}

// Crée une session pour un dossier : modèle PAIZ, toutes les permissions accordées sauf les garde-fous (guard.js) : le travail ne s'arrête pas sur une question.
export async function createSession(db, dir, title) {
  const folder = path.resolve(String(dir || '').trim());
  if (!dir || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`Dossier introuvable : ${dir}`);
  assertProjectAllowed(db, folder);
  const r = await ocCall('POST', '/api/session', {
    location: { directory: folder }, title: title || null, model: { id: 'local', providerID: 'paiz' },
    permissions: guardRules(db),
  });
  return r.data;
}
export async function sendPrompt(sessionID, text, files) {
  const att = (Array.isArray(files) ? files : []).filter((f) => typeof f?.uri === 'string' && /^data:image\//.test(f.uri)).map((f) => ({ uri: f.uri, name: String(f.name || 'image') }));
  const r = await ocCall('POST', `/api/session/${encodeURIComponent(sessionID)}/prompt`, att.length ? { text, files: att } : { text });
  return r.data;
}
// Modèles cloud GRATUITS proposés par OpenCode (coût nul en entrée et en sortie) : seuls eux peuvent être choisis, jamais un modèle payant.
// Confidentialité de chaque modèle gratuit, d'après la page https://opencode.ai/docs/zen/ (relevée le 2026-11-18, peut changer).
// level : 'bad' = données utilisées pour entraîner / journalisées, 'warn' = conservées quelques jours, 'ok' = zéro rétention annoncée, 'unk' = non précisé.
const FREE_INFO = {
  'big-pickle': { level: 'bad', note: 'Pendant la période gratuite, les données collectées peuvent servir à améliorer le modèle.' },
  'iceman-free': { level: 'bad', note: 'Données conservées et utilisées pour améliorer le modèle.' },
  'inkling-2-small-free': { level: 'bad', note: 'Données conservées, possiblement utilisées pour l\'entraînement et la surveillance.' },
  'flint-40b-free': { level: 'warn', note: 'Données possiblement utilisées pour améliorer le modèle ; conservées 30 jours.' },
  'nemotron-3.5-lightning-free': { level: 'bad', note: 'NVIDIA : usage d\'essai, ne pas envoyer de données personnelles ou confidentielles. Journalisé pour améliorer les produits NVIDIA.' },
  'nemotron-3.5-super-vl-free': { level: 'bad', note: 'NVIDIA : usage d\'essai, ne pas envoyer de données personnelles ou confidentielles. Journalisé pour améliorer les produits NVIDIA.' },
  'beam-free': { level: 'warn', note: 'Pas utilisé pour l\'entraînement, mais conservé 30 jours pour des raisons de sécurité.' },
  'longcat-2.5-free': { level: 'warn', note: 'Pas utilisé pour l\'entraînement ni conservé ; hébergé en Chine. Limite annoncée : 100 requêtes par jour.', limit: '100 requêtes/jour' },
  'deepseek-v4.1-flash-free': { level: 'ok', note: 'Zéro rétention annoncée, pas d\'entraînement sur tes données.' },
  'hy4-flash-free': { level: 'ok', note: 'Zéro rétention annoncée, pas d\'entraînement sur tes données.' },
  'mimo-v2.6-flash-free': { level: 'unk', note: 'Aucune précision propre à ce modèle ; politique générale d\'OpenCode : zéro rétention, pas d\'entraînement.' },
};
export async function listFreeModels() {
  const r = await ocCall('GET', '/api/model');
  return (r?.data || []).filter((m) => m.providerID === 'opencode' && m.enabled !== false && m.status !== 'deprecated'
    && (m.cost || []).length > 0 && (m.cost || []).every((c) => !c.input && !c.output && !c.cache?.read && !c.cache?.write))
    .map((m) => ({ id: m.modelID, name: m.name || m.modelID, context: m.limit?.context || null, tools: m.capabilities?.tools !== false, ...(FREE_INFO[m.modelID] || { level: 'unk', note: 'Politique de données non relevée par PAIZ pour ce modèle : considère-le comme non privé.' }) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
// Change le modèle d'une session en cours : le modèle local de PAIZ, ou un modèle gratuit d'OpenCode. Les messages suivants l'utilisent.
export async function setSessionModel(sessionID, providerID, id) {
  if (!sessionID) throw new Error('Aucune session.');
  if (!(providerID === 'paiz' && (id === 'local' || id === 'mule')) && !(providerID === 'opencode' && (await listFreeModels()).some((m) => m.id === id))) throw new Error("Modèle non autorisé : seuls le modèle local et les modèles gratuits d'OpenCode sont proposés.");
  await ocCall('POST', `/api/session/${encodeURIComponent(sessionID)}/model`, { model: { id, providerID } });
  return { ok: true, providerID, id };
}
// ---- consommation de jetons : relevée dans les messages des sessions OpenCode (chaque réponse porte son modèle et ses jetons).
// Le modèle local s'appelle « local » côté OpenCode : son vrai nom est retenu ici (journal des modèles chargés, par date).
export function noteLocalModel(db, name) {
  if (!name) return;
  const j = jget(db, 'usage.localNames', []) || [];
  if (j.length && j[j.length - 1].name === name) return;
  j.push({ t: Date.now(), name }); jset(db, 'usage.localNames', j.slice(-200));
}
const jget = (db, k, fb) => { try { const v = getSetting(db, k, null); return v == null ? fb : JSON.parse(v); } catch { return fb; } };
const jset = (db, k, v) => setSetting(db, k, JSON.stringify(v));
const usageCache = new Map(); // sessionID -> { updated, rows }
async function sessionRows(s) {
  const upd = s.time?.updated || 0; const hit = usageCache.get(s.id);
  if (hit && hit.updated === upd) return hit.rows;
  const rows = []; let cursor = '';
  for (let page = 0; page < 50; page++) {
    const r = await ocCall('GET', `/api/session/${encodeURIComponent(s.id)}/message?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&order=asc'}`);
    for (const m of r?.data || []) {
      if (m.type !== 'assistant') continue;
      const t = m.tokens || {};
      rows.push({ t: m.time?.created || 0, p: m.model?.providerID || '?', id: m.model?.id || '?', i: t.input || 0, o: t.output || 0, r: t.reasoning || 0, c: (t.cache?.read || 0), err: m.error ? String(m.error.type || 'erreur') : '', msg: m.error ? String(m.error.message || '').slice(0, 160) : '' });
    }
    cursor = r?.cursor?.next; if (!cursor || !(r?.data || []).length) break;
  }
  usageCache.set(s.id, { updated: upd, rows });
  return rows;
}
// Relevé horaire durable : chaque appel fusionne (par maximum) les jetons par heure et par modèle, pour garder l'historique même si une session est effacée.
const HOUR = 3600000;
const EXHAUST_RE = /limit|quota|exhaust|rate|credit|too many|429|épuis|insufficient|usage/i;
function mergeLedger(db, rows, localName) {
  const led = jget(db, 'usage.hourly', {}) || {};
  const cur = {};
  for (const r of rows) {
    if (!r.t) continue;
    const h = String(Math.floor(r.t / HOUR) * HOUR); const k = r.p === 'paiz' ? `L|${localName(r.t)}` : `R|${r.p}/${r.id}`;
    const e = ((cur[h] ||= {})[k] ||= [0, 0, 0]); e[0] += r.i; e[1] += r.o + r.r; e[2]++;
  }
  for (const [h, ks] of Object.entries(cur)) for (const [k, v] of Object.entries(ks)) {
    const e = ((led[h] ||= {})[k] ||= [0, 0, 0]); for (let i = 0; i < 3; i++) e[i] = Math.max(e[i], v[i]);
  }
  const cut = Date.now() - 120 * 24 * HOUR; for (const h of Object.keys(led)) if (Number(h) < cut) delete led[h];
  jset(db, 'usage.hourly', led);
  return led;
}
function producedBefore(led, model, t, w) { // jetons produits par ce modèle distant dans les w ms qui précèdent t
  let n = 0; const from = Math.floor((t - w) / HOUR) * HOUR;
  for (const [h, ks] of Object.entries(led)) { const hh = Number(h); if (hh >= from && hh <= t) n += ks[`R|${model}`]?.[1] || 0; }
  return n;
}
let sampler = null;
export function startUsageSampler(db) { // relevé automatique toutes les 10 minutes tant que PAIZ tourne (OpenCode lancé)
  if (sampler) return;
  sampler = setInterval(() => { if (oc?.ready) usageSummary(db).catch(() => {}); }, 10 * 60 * 1000); sampler.unref?.();
}
export async function usageSummary(db) {
  const ss = (await ocCall('GET', '/api/session?limit=500&order=desc'))?.data || [];
  const rows = []; for (const s of ss) rows.push(...await sessionRows(s));
  const names = jget(db, 'usage.localNames', []) || [];
  const localName = (t) => { let n = null; for (const e of names) { if (e.t <= t) n = e.name; else break; } return n || 'Modèle local (nom non relevé)'; };
  const d0 = new Date(); d0.setHours(0, 0, 0, 0); const day = d0.getTime(); const week = day - 6 * 86400000;
  const groups = { local: new Map(), remote: new Map() };
  const blank = () => ({ msgs: 0, in: 0, out: 0, reasoning: 0, cached: 0, errors: 0 });
  const addTo = (o, r) => { o.msgs++; o.in += r.i; o.out += r.o; o.reasoning += r.r; o.cached += r.c; if (r.err && r.err !== 'aborted') o.errors++; };
  const total = { local: { today: blank(), week: blank(), all: blank() }, remote: { today: blank(), week: blank(), all: blank() } };
  const errors = []; const led = mergeLedger(db, rows, localName);
  for (const r of rows) {
    const kind = r.p === 'paiz' ? 'local' : 'remote';
    const key = kind === 'local' ? localName(r.t) : `${r.p}/${r.id}`;
    let g = groups[kind].get(key); if (!g) { g = { name: key, today: blank(), week: blank(), all: blank(), last: 0 }; groups[kind].set(key, g); }
    for (const [per, ok] of [['all', true], ['week', r.t >= week], ['today', r.t >= day]]) if (ok) { addTo(g[per], r); addTo(total[kind][per], r); }
    if (r.t > g.last) g.last = r.t;
    if (kind === 'remote' && r.err && r.err !== 'aborted') errors.push({ t: r.t, model: key, type: r.err, message: r.msg });
  }
  // blocages remembrés (survivent à l'effacement de la session), avec la conso avant le blocage
  const memo = jget(db, 'usage.errors', []) || [];
  for (const e of errors) if (!memo.some((m) => m.t === e.t && m.model === e.model)) memo.push(e);
  memo.sort((a, b) => b.t - a.t); jset(db, 'usage.errors', memo.slice(0, 60));
  const errOut = memo.slice(0, 8).map((e) => ({ ...e, exhausted: EXHAUST_RE.test(`${e.type} ${e.message}`), before: { h1: producedBefore(led, e.model, e.t, HOUR), h5: producedBefore(led, e.model, e.t, 5 * HOUR), h24: producedBefore(led, e.model, e.t, 24 * HOUR) } }));
  const hourly = []; const nowH = Math.floor(Date.now() / HOUR) * HOUR;
  for (let i = 23; i >= 0; i--) { const h = nowH - i * HOUR; const ks = led[String(h)] || {}; let L = 0; let R = 0; for (const [k, v] of Object.entries(ks)) { if (k[0] === 'L') L += v[1]; else R += v[1]; } hourly.push({ h, local: L, remote: R }); }
  const out = (m) => [...m.values()].sort((a, b) => b.all.out + b.all.in - (a.all.out + a.all.in));
  return { local: out(groups.local), remote: out(groups.remote), total, since: rows.length ? Math.min(...rows.map((x) => x.t).filter(Boolean)) : null, errors: errOut, hourly, sessions: ss.length };
}
export async function interrupt(sessionID) {
  const r = await ocCall('POST', `/api/session/${encodeURIComponent(sessionID)}/interrupt`);
  return r.interrupted;
}
