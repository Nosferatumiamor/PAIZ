// Point d'entrée OpenAI-compatible de PAIZ : /v1/* est relayé vers ws_npc_server, en retirant la balise parasite
// « <|channel>thought<channel|> » que Gemma 4 met en tête de chaque message (réponse normale ET flux SSE).
import { logUseByPath, programOf } from './usage.js';
import crypto from 'node:crypto';
import http from 'node:http';
import { engineConfig, currentModel, auxPort } from './engine.js';
import { capturePrefix } from './warm.js';
import { getSetting } from './db.js';
import { describeImage } from './eye.js';
import { activePersonaText, injectPersona, personaOpts } from './persona.js';
import { timeNote } from './clock.js';
import { noteActivity } from './memory.js';
import { buildBlock, injectMemory, requestInfo } from './memory.js';
import { trimCodeMode, codeModeBlocks } from './codemode.js';
import { applyBudget } from './toolbudget.js';
import { pickNamespaces, noteSaved } from './toolpick.js';
import { enabledNamespaces } from './mcp.js';

const TAG = '<|channel>thought<channel|>';
const squash = (s) => s.replace(/\s+/g, '');
// 'drop' = le début est exactement la balise ; 'hold' = pourrait en être le début ; 'pass' = autre chose
function classify(s) {
  const t = squash(s);
  if (t === '') return 'hold';
  if (t.startsWith(TAG)) return 'drop';
  if (TAG.startsWith(t)) return 'hold';
  return 'pass';
}
const stripTag = (s) => s.replace(/^\s*<\|channel>thought\s*<channel\|>\s*/, '');

export function cleanJsonBody(d) {
  for (const c of d?.choices || []) if (typeof c.message?.content === 'string') c.message.content = stripTag(c.message.content);
  return d;
}

// Filtre d'un flux SSE : retient le début du contenu de chaque choix tant qu'il peut encore être la balise.
function sseFilter() {
  const state = new Map(); // choice index -> { buf, done }
  return (evt) => {
    if (!evt.startsWith('data:')) return evt;
    const payload = evt.slice(5).trim();
    if (payload === '[DONE]') return evt;
    let d; try { d = JSON.parse(payload); } catch { return evt; }
    for (const c of d.choices || []) {
      const st = state.get(c.index ?? 0) || { buf: '', done: false };
      state.set(c.index ?? 0, st);
      const delta = c.delta || {};
      if (st.done || typeof delta.content !== 'string') {
        // un message sans contenu (appel d'outil, fin) : on rend ce qui était retenu avec lui
        if (!st.done && st.buf && (delta.tool_calls || c.finish_reason)) { delta.content = st.buf; st.buf = ''; st.done = true; }
        continue;
      }
      st.buf += delta.content;
      const k = classify(st.buf);
      if (k === 'hold') { delta.content = ''; }
      else if (k === 'drop') { delta.content = stripTag(st.buf); st.buf = ''; st.done = true; }
      else { delta.content = st.buf; st.buf = ''; st.done = true; }
    }
    return `data: ${JSON.stringify(d)}`;
  };
}

// Les images d'une requête sont décrites par « l'œil » (Qwen3-VL sur processeur) et remplacées par leur description :
// le moteur courant (Gemma sans vision, Qwen coder…) « voit » ainsi sans rien changer. Descriptions mises en cache.
const seen = new Map();
async function describeCached(url) {
  const k = crypto.createHash('sha1').update(url).digest('hex');
  if (!seen.has(k)) seen.set(k, describeImage({ dataUrl: url }).catch((e) => { seen.delete(k); return `(image non vue : ${e.message})`; }));
  return seen.get(k);
}
export async function replaceImages(body) {
  let j; try { j = JSON.parse(body.toString('utf8')); } catch { return body; }
  let changed = false;
  for (const m of j.messages || []) {
    if (!Array.isArray(m.content)) continue;
    const out = [];
    for (const part of m.content) {
      const url = part?.type === 'image_url' ? (part.image_url?.url || part.image_url) : null;
      if (typeof url === 'string' && url.startsWith('data:image/')) { out.push({ type: 'text', text: `[Image jointe, décrite par l'œil de PAIZ : ${await describeCached(url)}]` }); changed = true; }
      else out.push(part);
    }
    m.content = out;
  }
  return changed ? Buffer.from(JSON.stringify(j)) : body;
}

// Appel du moteur via node:http (et non fetch) : aucun délai d'attente par défaut. Un gros modèle qui streame depuis le SSD met
// des minutes à lire le prompt ; le fetch intégré coupait la connexion vers 300 s et OpenCode relançait tout depuis zéro.
function upstream(port, pathname, method, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { ...headers, ...(body ? { 'Content-Length': body.length } : {}) }, timeout: 0 }, (m) => {
      resolve({
        status: m.statusCode, ctype: m.headers['content-type'] || '', body: m, cancel: () => m.destroy(),
        text: async () => { const c = []; for await (const x of m) c.push(x); return Buffer.concat(c).toString('utf8'); },
      });
    });
    r.setTimeout(0); r.on('error', reject);
    r.end(body);
  });
}

// Sélection des outils par tâche. Chaque outil exposé au modèle coûte des tokens à relire (minutes sur un gros modèle qui streame depuis le SSD) :
// on ne garde que ceux que la conversation réclame. La sélection ne fait que GROSSIR au fil de la conversation (déterminée par TOUS les
// messages de l'utilisateur) : le début du prompt reste stable, donc réutilisé, tant que rien de nouveau n'est demandé.
const CORE = new Set(['read', 'edit', 'write', 'glob', 'grep', 'apply_patch', 'patch', 'list', 'ls']);
const GROUPS = [
  { id: 'terminal', tools: ['shell', 'bash', 'powershell', 'cmd'], re: /\b(git|commit|branche|branch|merge|push|pull|test|tests|npm|pnpm|yarn|pip|cargo|install\w*|build|compil\w*|lance\w*|lancer|ex[ée]cute\w*|run|script|d[ée]p[ôo]t|repo|serveur|server|terminal|commande|console|format\w*|lint\w*)\b/i },
  { id: 'web', tools: ['webfetch', 'websearch'], re: /(https?:|www\.|github|gitlab|\bweb\b|internet|\burl\b|documentation|\bdocs?\b|cherche\w* (sur|en ligne)|recherche\w* (sur|en ligne|web)|librairie|biblioth[èe]que|package|\bsite\b)/i },
  { id: 'agents', tools: ['subagent', 'task', 'skill', 'question', 'execute', 'experimental_image_generate'], re: /(sous-?agent|\bagents?\b|en parall[èe]le|\bskill|g[ée]n[èe]re\w* une image|cr[ée]e\w* une image|dessine)/i },
];
// « websearch » passe par un service de recherche externe qui, ici, reste bloqué une minute puis échoue (et le modèle recommence) :
// retiré par défaut, le modèle se rabat sur « webfetch » (lire une adresse). Réglage engine.websearch = 1 pour le garder.
export function selectTools(j, mode = 'auto', alwaysKeep = [], allowSearch = false) {
  if (Array.isArray(j.tools) && !allowSearch) j.tools = j.tools.filter((t) => (t.function?.name || t.name) !== 'websearch');
  if (!Array.isArray(j.tools) || !j.tools.length || mode === 'all') return { removed: [], groups: ['tous'] };
  const users = (j.messages || []).filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join(' '))).join('\n');
  const on = new Set(mode === 'focus' ? [] : GROUPS.filter((g) => g.re.test(users)).map((g) => g.id));
  const keepNames = new Set([...GROUPS.filter((g) => on.has(g.id)).flatMap((g) => g.tools), ...alwaysKeep]);
  const allGroupTools = new Set(GROUPS.flatMap((g) => g.tools));
  const removed = [];
  j.tools = j.tools.filter((t) => {
    const n = t.function?.name || t.name;
    // outils inconnus (ajoutés par l'utilisateur, MCP…) : conservés ; outils connus : cœur toujours, le reste selon la tâche
    const drop = allGroupTools.has(n) && !keepNames.has(n) && !CORE.has(n);
    if (drop) removed.push(n);
    return !drop;
  });
  if (removed.length && j.tool_choice && typeof j.tool_choice === 'object' && removed.includes(j.tool_choice.function?.name)) delete j.tool_choice;
  return { removed, groups: ['coeur', ...on] };
}

// ---- Contrôle du travail (écran « Travail ») : pause / reprise exacte / stop / suivi d'avancement des requêtes de génération ----
// Chaque requête de chat en flux reçoit un identifiant de travail (« ws_job », empreinte de son contenu) : le moteur la traite alors comme un
// travail reprenable (journal des jetons + points de reprise du KV). Pause = le moteur s'arrête au prochain jeton avec un point de reprise,
// la requête reste ouverte (flux gardé) ; reprise = il repart exactement de là. Si le moteur tombe, le relais garde la connexion d'OpenCode
// ouverte et se rattache au même travail dès que le moteur revient (OpenCode ne voit rien). Un moteur sans cette fonction : ancien
// comportement (on retient la requête SUIVANTE, celle en cours finit).
export const relay = {
  paused: false, held: [], active: new Map(), seq: 0, port: 0, timings: [],
  rates: { prefill: 95, decode: 4.3, outAvg: 200, load: 120 }, // tokens/s, affinés par les mesures réelles (lissage)
  last: null,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function engineCall(method, pathname) {
  const r = await upstream(relay.port, pathname, method, { 'Content-Type': 'application/json' }, method === 'POST' ? Buffer.from('{}') : null);
  return { status: r.status, text: await r.text() };
}
// ordre au moteur pour un travail ; « unknown job » = la requête n'est pas encore enregistrée côté moteur : on réessaie un instant
async function jobCtl(track, what, { force = false } = {}) {
  if (!track.jobId) return false;
  for (let i = 0; i < 10 && (force || relay.active.has(track.id)); i++) {
    try {
      const r = await engineCall('POST', `/api/jobs/${track.jobId}/${what}`);
      if (r.status === 200) return true;
      if (!/unknown job/.test(r.text)) return false;
    } catch { return false; }
    await sleep(300);
  }
  return false;
}
export function relayPause(on) {
  const was = relay.paused;
  relay.paused = !!on;
  for (const a of relay.active.values()) {
    if (!a.jobId || a.state === 'interrompu') continue;
    if (relay.paused && !was) { a.pausedAt = Date.now(); jobCtl(a, 'pause').catch(() => {}); }
    else if (!relay.paused && (was || a.job?.status === 'paused')) { a.resuming = true; a.resumeAt = Date.now(); a.resumedTook = null; a.tokAtResume = a.job?.n_generated ?? 0; jobCtl(a, 'resume').catch(() => {}); }
  }
  if (!relay.paused) { const h = relay.held; relay.held = []; for (const w of h) w.go(); }
  return relay.paused;
}
export function relayAbortAll() {
  relay.paused = false;
  for (const w of relay.held.splice(0)) w.drop();
  let n = 0;
  for (const a of relay.active.values()) {
    a.aborted = true;
    if (a.jobId) jobCtl(a, 'cancel', { force: true }).catch(() => {});
    try { a.cancel(); } catch { /* déjà fermé */ }
    n++;
  }
  return n;
}
// met à jour l'état des travaux côté moteur (appelé avant relayStatus par la route d'état)
export async function relayRefresh() {
  const pending = [...relay.active.values()].filter((a) => !a.loadedAt);
  if (pending.length) {
    let loaded = null;
    try { const r = await engineCall('GET', '/health'); if (r.status === 200) loaded = JSON.parse(r.text).state === 'running'; } catch { /* moteur injoignable */ }
    for (const a of pending) {
      if (loaded === true) { a.loadedAt = Date.now(); if (a.needsLoad) a.loadSec = (a.loadedAt - a.upAt) / 1000; }
      else if (loaded === false) a.needsLoad = true;
    }
  }
  await Promise.all([...relay.active.values()].filter((a) => a.jobId && a.state !== 'interrompu').map(async (a) => {
    try {
      const r = await engineCall('GET', `/api/jobs/${a.jobId}`);
      if (r.status !== 200) return;
      a.job = JSON.parse(r.text);
      if (a.resuming && a.job.status === 'running' && a.job.n_generated > a.tokAtResume) { a.resuming = false; a.resumedTook = (Date.now() - a.resumeAt) / 1000; }
    } catch { /* moteur indisponible : l'état reste celui d'avant */ }
  }));
}
// La requête « principale » : OpenCode en envoie souvent d'autres en parallèle (titre de la conversation…), petites et brèves ; on suit la plus
// grosse (le plus long prompt), et à égalité la plus ancienne.
function mainActive() {
  let best = null;
  for (const a of relay.active.values()) if (!best || a.promptTok > best.promptTok) best = a;
  return best;
}
// Aperçu en direct de la réponse en cours d'écriture (léger : appelé plusieurs fois par seconde par l'écran Travail).
// Avec des outils (toujours le cas d'OpenCode), le moteur retient le flux OpenAI jusqu'à la fin de la réponse : le texte en cours d'écriture
// est alors lu sur sa route /api/jobs/<travail>/live (moteur plus ancien : 404, on ignore).
export async function relayLive() {
  const a = mainActive();
  if (!a) return { active: false };
  if (a.jobId && !a.text) {
    try {
      const r = await engineCall('GET', `/api/jobs/${a.jobId}/live`);
      if (r.status === 200) { a.liveText = JSON.parse(r.text).text || ''; a.liveLen = a.liveText.length; }
    } catch { /* moteur occupé ou ancien : pas d'aperçu par cette voie */ }
  }
  const text = a.text || a.liveText || '';
  if (text.length > 0 && !a.liveAt && !a.text) a.liveAt = Date.now(); // début de l'écriture vu par la voie « texte en direct »
  const outTok = a.outTok || Math.round(text.length / 3.5);
  return { active: true, id: a.id, text, tool: a.tool || '', outTok, writing: !!((a.firstAt && a.outTok > 0) || text.length > 0) };
}
export function relayTimings() { return relay.timings; }
export function relayStatus() {
  const now = Date.now();
  const a = mainActive();
  let active = null;
  if (a) {
    const loading = !a.loadedAt && a.needsLoad; // le modèle n'est pas encore réellement chargé en mémoire
    const phase = (a.firstAt && a.outTok > 0) || a.liveLen > 0 ? 'ecriture' : loading ? 'chargement' : 'lecture';
    const prefillEst = a.promptTok / relay.rates.prefill;
    const readStart = a.loadedAt || a.upAt;
    const outEff = a.outTok || Math.round((a.liveLen || 0) / 3.5);
    const expectTok = Math.min(a.maxTok, Math.max(relay.rates.outAvg, outEff * 1.25 + 20)); // longueur attendue : moyenne des réponses précédentes, jamais en dessous de ce qui est déjà écrit
    const decodeEst = expectTok / relay.rates.decode;
    const jb = a.job || null;
    const reason = jb?.status === 'paused' ? (jb.pause_reason || 'user') : null;
    active = {
      // état réel : run | pausing | paused | memory | resuming | interrupted
      state: a.state === 'interrompu' ? 'interrupted' : reason === 'memory_critical' ? 'memory' : jb?.status === 'paused' ? 'paused' : (jb?.pausing || (relay.paused && jb)) && jb?.status === 'running' ? 'pausing' : a.resuming ? 'resuming' : 'run',
      job: !!a.jobId, jobN: jb?.n_generated ?? null, checkpointAgo: jb?.last_checkpoint ? Math.max(0, Math.round(Date.now() / 1000 - jb.last_checkpoint)) : null,
      pausedFor: a.pausedAt && (jb?.status === 'paused') ? (now - a.pausedAt) / 1000 : null,
      resumeWait: a.resuming ? (now - a.resumeAt) / 1000 : null, resumeTook: a.resumedTook ?? null, engineResume: jb?.resume_prefill_s ?? null,
      interruptedFor: a.state === 'interrompu' ? (now - a.interruptedAt) / 1000 : null, memFreeMib: jb?.paused_free_mib ?? null,
      phase, promptTok: a.promptTok, maxTok: a.maxTok, outTok: outEff,
      elapsed: (now - a.upAt) / 1000,
      stepElapsed: phase === 'chargement' ? (now - a.upAt) / 1000 : phase === 'lecture' ? (now - readStart) / 1000 : (now - (a.liveAt || a.firstAt || a.upAt)) / 1000,
      stepEstimate: phase === 'chargement' ? relay.rates.load : phase === 'lecture' ? prefillEst : decodeEst,
      // jamais 99 % : une étape qui dépasse son estimation est signalée (overrun) au lieu de rester plantée à la fin de la barre
      progress: phase === 'chargement' ? Math.min(0.95, (now - a.upAt) / 1000 / relay.rates.load) : phase === 'lecture' ? Math.min(0.95, (now - readStart) / 1000 / Math.max(prefillEst, 0.1)) : Math.min(0.95, outEff / Math.max(expectTok, 1)),
      overrun: phase !== 'ecriture' && ((now - (phase === 'chargement' ? a.upAt : readStart)) / 1000) > (phase === 'chargement' ? relay.rates.load : prefillEst),
      loaded: !!a.loadedAt, loadSec: a.loadSec ?? null,
    };
  }
  return { paused: relay.paused, held: relay.held.length, active, rates: relay.rates, last: relay.last };
}
const smooth = (old, v) => (Number.isFinite(v) && v > 0 ? old * 0.6 + v * 0.4 : old);
const waitGate = (res) => new Promise((resolve) => {
  if (!relay.paused) { resolve(true); return; }
  const w = {
    go: () => resolve(true),
    drop: () => { try { res.writeHead(499, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Travail interrompu.' } })); } catch { /* fermé */ } resolve(false); },
  };
  relay.held.push(w);
  res.on('close', () => { const i = relay.held.indexOf(w); if (i >= 0) { relay.held.splice(i, 1); resolve(false); } });
});

export async function proxyV1(db, req, res, pathname, search) {
  const cfg = engineConfig(db);
  const chunks = []; for await (const c of req) chunks.push(c);
  let body = Buffer.concat(chunks);
  if (req.method === 'POST' && body.includes('image_url')) body = await replaceImages(body);
  if (req.method === 'POST' && pathname.endsWith('/chat/completions') && body.includes('"tools"')) {
    try {
      const j = JSON.parse(body.toString('utf8'));
      const ns = enabledNamespaces(db); // serveurs MCP activés : l'outil `execute` (qui les appelle) reste alors disponible
      const allowSearch = [1, '1', true].includes(getSetting(db, 'engine.websearch', 0));
      // budget d'outils : profil d'usage + choix de l'utilisateur ; le profil « Automatique » garde la sélection par mots-clés d'origine
      const r = applyBudget(db, j, (jj) => selectTools(jj, getSetting(db, 'engine.toolMode', 'auto'), ns.size ? ['execute'] : [], allowSearch), { allowSearch, keepExtra: ns.size ? ['execute'] : [] });
      // catalogue « Code Mode » : seulement les serveurs activés ET concernés par la conversation (choix par question)
      const blocks = codeModeBlocks(j); const enabledBlocks = Object.fromEntries(Object.entries(blocks).filter(([n]) => ns.has(n)));
      const keepNs = pickNamespaces(enabledBlocks, j.messages, { mode: getSetting(db, 'engine.mcpSelect', 'smart') });
      // outils MCP exposés directement (« serveur_outil ») d'un serveur écarté : retirés aussi
      const droppedNs = [...ns].filter((n) => !keepNs.has(n));
      if (droppedNs.length && Array.isArray(j.tools)) j.tools = j.tools.filter((t) => { const n = t.function?.name || t.name || ''; return !droppedNs.some((d) => n.startsWith(`${d}_`)); });
      const beforeChars = JSON.stringify(j.tools || []).length;
      const cm = trimCodeMode(j, keepNs);
      noteSaved(cm.saved + Math.max(0, beforeChars - JSON.stringify(j.tools || []).length)); // pour le panneau : jetons retirés à cette requête
      if (r.removed.length || cm.saved || true) { /* toujours réécrit : websearch a pu être retiré */ body = Buffer.from(JSON.stringify(j)); console.log(`[paiz] outils : ${r.groups.join('+')} (retirés : ${r.removed.join(', ') || '—'}${cm.saved ? `; catalogue Code Mode allégé de ${cm.saved} car.` : ''})`); }
    } catch { /* corps illisible : renvoyé tel quel */ }
  }
  // « caractère » du modèle : ajouté uniquement aux requêtes de l'écran Travail (en-tête posé par la config d'OpenCode de PAIZ)
  if (req.method === 'POST' && pathname.endsWith('/chat/completions') && req.headers['x-paiz-persona']) {
    try {
      const j = JSON.parse(body.toString('utf8'));
      noteActivity();
      const a = injectPersona(j, activePersonaText(db));
      let b = false; try { const ri = requestInfo(j); b = injectMemory(j, buildBlock(db, ri)); } catch { /* mémoire indisponible : on répond sans */ }
      if (personaOpts(db).time) { try { b = injectMemory(j, timeNote(j.messages)) || b; } catch { /* sans repère de temps */ } }
      if (a || b) body = Buffer.from(JSON.stringify(j));
    } catch { /* corps illisible : renvoyé tel quel */ }
  }
  // début de prompt de l'agent (consignes + outils, après allègement) : gardé pour le préchauffage au prochain chargement du modèle
  if (req.method === 'POST' && pathname.endsWith('/chat/completions') && body.includes('"tools"')) {
    try { const m = currentModel(); if (m) capturePrefix(m.path, JSON.parse(body.toString('utf8'))); } catch { /* sans effet */ }
  }
  if (req.method === 'POST' && pathname.endsWith('/chat/completions')) { try { const m = currentModel(); if (m) logUseByPath(db, m.path, programOf(req)); } catch { /* suivi sans effet */ } }
  relay.port = cfg.port;
  // suivi / pause du travail : seules les générations sont concernées
  let track = null;
  let jobBody = null;
  // « mule » = le modèle des tâches de fond (second moteur) : envoyé à son port, hors de l'aperçu et du suivi de la discussion
  let mule = false; if (req.method === 'POST' && pathname.endsWith('/chat/completions')) { try { mule = JSON.parse(body.toString('utf8')).model === 'mule'; } catch { /* corps non JSON */ } }
  const upPort = mule ? auxPort(db) : cfg.port;
  if (!mule && req.method === 'POST' && pathname.endsWith('/chat/completions')) {
    // chat en flux = travail reprenable côté moteur : identifiant = empreinte du contenu (la même requête rejouée retrouve le même travail)
    try {
      const j = JSON.parse(body.toString('utf8'));
      if (j.stream && getSetting(db, 'engine.resumable', true) !== false) {
        j.ws_job = `p${crypto.createHash('sha1').update(body).digest('hex').slice(0, 24)}`;
        j.ws_checkpoint_s = Number(getSetting(db, 'engine.checkpointS', 60)) || 60;
        jobBody = j; body = Buffer.from(JSON.stringify(j));
      }
    } catch { /* corps non JSON */ }
    if (!(await waitGate(res))) return;
    let maxTok = 4096; try { const j = JSON.parse(body.toString('utf8')); maxTok = Number(j.max_tokens || j.max_completion_tokens) || 4096; } catch { /* corps non JSON */ }
    track = { text: '', tool: '', id: ++relay.seq, promptTok: Math.round(body.length / 3.4), maxTok, outTok: 0, upAt: Date.now(), firstAt: 0, aborted: false, cancel: () => {}, jobId: jobBody?.ws_job || null, state: 'run', sentBytes: 0, job: null };
    relay.active.set(track.id, track);
  }
  const finish = () => {
    if (!track || !relay.active.delete(track.id)) return;
    const now = Date.now();
    // avec des outils le flux OpenAI n'arrive qu'à la fin : le vrai début d'écriture et le nombre de mots viennent du texte en direct
    const w0 = track.liveAt || track.firstAt; const outN = Math.max(track.outTok, Math.round((track.liveLen || 0) / 3.5));
    if (w0 && !track.aborted) {
      if (track.loadSec) relay.rates.load = smooth(relay.rates.load, track.loadSec);
      const pf = track.promptTok / Math.max((w0 - (track.loadedAt || track.upAt)) / 1000, 0.5); // sans le temps de chargement du modèle
      // un prompt déjà en cache est lu « instantanément » : seules les mesures plausibles affinent le débit
      if (pf < 400) relay.rates.prefill = smooth(relay.rates.prefill, pf);
      if (outN >= 5) relay.rates.outAvg = Math.min(track.maxTok, Math.max(20, smooth(relay.rates.outAvg, outN)));
      if (outN >= 8) relay.rates.decode = smooth(relay.rates.decode, outN / Math.max((now - w0) / 1000, 0.5));
    }
    // détail des durées réelles de cette requête (lecture du prompt / écriture), gardé pour l'affichage sous les réponses
    const rd0 = track.loadedAt || track.upAt;
    relay.timings.push({ up: track.upAt, end: now, load: track.loadedAt ? (track.loadedAt - track.upAt) / 1000 : 0, read: ((w0 || now) - rd0) / 1000, write: w0 ? (now - w0) / 1000 : 0, aborted: track.aborted });
    if (relay.timings.length > 60) relay.timings.shift();
    relay.last = { promptTok: track.promptTok, outTok: outN, seconds: (now - track.upAt) / 1000, aborted: track.aborted };
  };
  res.on('close', finish);
  let up; let cur = null; // cur = connexion moteur courante (change si on se rattache après une chute du moteur)
  try {
    up = await upstream(upPort, `${pathname}${search || ''}`, req.method, { 'Content-Type': req.headers['content-type'] || 'application/json' }, ['GET', 'HEAD'].includes(req.method) ? null : body);
    cur = up;
    if (track) track.cancel = () => { try { cur.cancel(); } catch { /* fermé */ } };
  } catch {
    finish();
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Le moteur WeightStream ne répond pas sur le port ${cfg.port}. Lance-le depuis l'onglet WeightStream, ou sans interface : PAIZ-server.bat --model <nom>.` } }));
    return;
  }
  const ct = up.ctype;
  if (ct.includes('text/event-stream')) {
    res.writeHead(up.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const filter = sseFilter();
    let clientGone = false; let sawDone = false; let broke = null; let reattached = false; let failedMsg = null;
    res.on('close', () => { clientGone = true; try { cur.cancel(); } catch { /* déjà fermé */ } });
    // Le moteur est tombé en cours de route : on garde la connexion d'OpenCode ouverte et on se rattache au même travail (même requête,
    // sans le texte déjà transmis) dès que le moteur répond de nouveau.
    const waitReattach = async () => {
      track.state = 'interrompu'; track.interruptedAt = Date.now(); track.job = null;
      let lastPing = 0;
      for (;;) {
        if (track.aborted || clientGone) return null;
        if (Date.now() - lastPing > 8000) { try { res.write(': paiz-attente\n\n'); } catch { /* client parti */ } lastPing = Date.now(); }
        try {
          // le moteur est de retour : il doit avoir gardé le travail (sinon : moteur sans reprise, on ne rejoue pas la requête à zéro)
          const g = await engineCall('GET', `/api/jobs/${track.jobId}`);
          if (g.status === 404) { failedMsg = "Le moteur n'a pas gardé le travail interrompu (moteur sans reprise exacte, ou dossier de données changé)."; return null; }
          const u = await upstream(cfg.port, `${pathname}${search || ''}`, 'POST', { 'Content-Type': 'application/json' }, Buffer.from(JSON.stringify({ ...jobBody, ws_skip_chars: track.sentBytes })));
          if (u.status === 200 && u.ctype.includes('text/event-stream')) { track.state = 'run'; track.resuming = true; track.resumeAt = Date.now(); track.resumedTook = null; track.tokAtResume = 0; if (relay.paused) jobCtl(track, 'pause').catch(() => {}); return u; }
          const t = await u.text();
          if (!/already attached/.test(t)) { failedMsg = (() => { try { return JSON.parse(t).error?.message; } catch { return null; } })() || `Le moteur a refusé la reprise (${u.status}).`; return null; }
        } catch { /* moteur absent : on réessaie */ }
        for (let i = 0; i < 5 && !track.aborted && !clientGone; i++) await sleep(500);
      }
    };
    for (;;) {
      let tail = ''; const dec = new TextDecoder(); broke = null;
      try {
        for await (const chunk of cur.body) {
          tail += dec.decode(chunk, { stream: true });
          let i;
          while ((i = tail.indexOf('\n\n')) >= 0) {
            const evt = tail.slice(0, i); tail = tail.slice(i + 2);
            if (evt.startsWith('data: [DONE]')) sawDone = true;
            if (track && evt.startsWith('data: {')) {
              if (!track.firstAt) track.firstAt = Date.now();
              // texte en cours d'écriture, pour l'aperçu en direct (OpenCode ne publie le texte qu'à la fin de chaque étape)
              try { const dl = JSON.parse(evt.slice(6))?.choices?.[0]?.delta; if (typeof dl?.content === 'string') track.text = (track.text + dl.content).slice(-30000); const fn = dl?.tool_calls?.[0]?.function; if (fn?.name) track.tool = fn.name; } catch { /* pas du JSON */ }
              if (evt.includes('"content"') || evt.includes('tool_calls')) track.outTok++;
              if (track.jobId) {
                let d = null; try { d = JSON.parse(evt.slice(6)); } catch { /* pas du JSON */ }
                const delta = d?.choices?.[0]?.delta;
                if (reattached && delta && Object.keys(delta).length === 1 && delta.role) { reattached = false; continue; } // « role » déjà envoyé avant la coupure
                reattached = false;
                if (typeof delta?.content === 'string') track.sentBytes += Buffer.byteLength(delta.content);
              }
            }
            res.write(`${filter(evt)}\n\n`);
          }
        }
        if (tail.trim()) res.write(`${filter(tail)}\n\n`);
      } catch (e) { broke = e; }
      if (!track?.jobId || sawDone || track.aborted || clientGone) break;
      const next = await waitReattach();
      if (!next) break;
      cur = next; reattached = true;
    }
    if (!sawDone && !clientGone && !track?.aborted) { try { res.write(`data: ${JSON.stringify({ error: { message: failedMsg || `Flux interrompu${broke ? ` : ${broke.message}` : ''}` } })}\n\n`); } catch { /* client parti */ } }
    res.end();
    // la réponse est livrée : le moteur peut oublier le travail (sinon la même requête rejouée recevrait la même réponse)
    if (track?.jobId && sawDone) engineCall('POST', `/api/jobs/${track.jobId}/cancel`).catch(() => {});
    return;
  }
  const text = await up.text();
  let out = text;
  if (ct.includes('json')) { try { out = JSON.stringify(cleanJsonBody(JSON.parse(text))); } catch { /* renvoyé tel quel */ } }
  res.writeHead(up.status, { 'Content-Type': ct || 'application/json' });
  res.end(out);
}
