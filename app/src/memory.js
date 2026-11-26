// Mémoire des assistants (conception : notes internes) : notes classées (projet / globales), résumés de conversations,
// index plein texte (FTS5) des échanges, bloc « Mémoire » ajouté au dernier message de l'utilisateur, digestion au repos par un modèle.
// Tout est local (base de PAIZ). Les projets privés ne sont jamais lus ni indexés ; les chats « Test » (sans session) n'existent pas ici.
import { getSetting, setSetting } from './db.js';
import { addTask, listTasks, setKindHook } from './tasks.js';
import { ocCall, ocStatus } from './work.js';
import { engineStatus, LOSSY_PROFILES } from './engine.js';
import crypto from 'node:crypto';

export const CATS = ['identite', 'preference', 'projet', 'decision', 'personne', 'promesse', 'idee'];
// Quand la mémoire travaille : discrètement, et seulement quand ça vaut le coup.
// - la conversation est calme depuis 20 min, et toi tu n'as rien envoyé au modèle depuis 5 min (nulle part dans PAIZ) ;
// - il y a de quoi retenir : au moins 4 nouveaux messages de ta part, ou une conversation plus courte restée calme 3 h ;
// - au plus une mise en mémoire tous les quarts d'heure.
export const MEM_TH = { convIdleMs: 20 * 60 * 1000, userIdleMs: 5 * 60 * 1000, minUserMsgs: 4, shortIdleMs: 3 * 3600 * 1000, cooldownMs: 15 * 60 * 1000 };
const IDLE_MS = MEM_TH.convIdleMs;
let lastActivity = 0; let lastDigest = 0;
/** Appelé à chaque message que l'utilisateur envoie au modèle (écran Travail, mode Test) : la mémoire attend qu'il ait fini. */
export function noteActivity() { lastActivity = Date.now(); }
const MAX_TRANSCRIPT = 12_000;
const norm = (p) => String(p || '').replace(/\//g, '\\').replace(/[\\]+$/, '').toLowerCase();
const strip = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const words = (s) => new Set(strip(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
const jac = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const w of a) if (b.has(w)) n++; return n / (a.size + b.size - n); };

let ready = false; let fts = true;
function ensure(db) {
  if (ready) return;
  db.exec(`CREATE TABLE IF NOT EXISTS mem_notes (id TEXT PRIMARY KEY, scope TEXT NOT NULL, cat TEXT NOT NULL, text TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 3, due TEXT, source TEXT, created INTEGER NOT NULL, last_used INTEGER, uses INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS mem_summ (id TEXT PRIMARY KEY, session TEXT, project TEXT, title TEXT, text TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mem_state (session TEXT PRIMARY KEY, upto INTEGER NOT NULL DEFAULT 0);`);
  try { db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(text, kind UNINDEXED, ref UNINDEXED, project UNINDEXED, tokenize='unicode61 remove_diacritics 2')"); } catch { fts = false; }
  ready = true;
}
const fIns = (db, kind, ref, project, text) => { if (fts && text) db.prepare('INSERT INTO mem_fts (text, kind, ref, project) VALUES (?,?,?,?)').run(String(text), kind, String(ref), norm(project)); };
const fDel = (db, kind, ref) => { if (fts) db.prepare('DELETE FROM mem_fts WHERE kind=? AND ref=?').run(kind, String(ref)); };

// ------------------------------------------------------------ réglages
export function memConfig(db) {
  let priv = []; try { priv = JSON.parse(getSetting(db, 'memory.private', '[]')) || []; } catch { /* vide */ }
  const on = getSetting(db, 'memory.on', 1); return { on: !(on === 0 || on === '0' || on === false), private: priv.map(norm) };
}
export function setMemConfig(db, { on, project, private: p }) {
  ensure(db);
  if (on != null) setSetting(db, 'memory.on', on ? 1 : 0);
  if (project != null && p != null) {
    const set = new Set(memConfig(db).private); const k = norm(project);
    if (p) { set.add(k); purgeProject(db, k); } else set.delete(k);
    setSetting(db, 'memory.private', JSON.stringify([...set]));
  }
  return memConfig(db);
}
export const isPrivate = (db, dir) => memConfig(db).private.includes(norm(dir));
function purgeProject(db, k) { // un projet devenu privé : on oublie ce qui venait de lui
  for (const r of db.prepare('SELECT id FROM mem_summ WHERE lower(project)=?').all(k)) fDel(db, 'summ', r.id);
  db.prepare('DELETE FROM mem_summ WHERE lower(project)=?').run(k);
  if (fts) db.prepare("DELETE FROM mem_fts WHERE kind='msg' AND project=?").run(k);
  for (const r of db.prepare('SELECT id FROM mem_notes WHERE scope=?').all('projet:' + k)) fDel(db, 'note', r.id);
  db.prepare('DELETE FROM mem_notes WHERE scope=?').run('projet:' + k);
}

// ------------------------------------------------------------ notes
const scopeOf = (project, global) => (global || !project ? 'global' : 'projet:' + norm(project));
export function listNotes(db, project) {
  ensure(db);
  return db.prepare("SELECT * FROM mem_notes WHERE scope='global' OR scope=? ORDER BY importance DESC, created DESC").all('projet:' + norm(project));
}
export function addNote(db, { scope, project, global, cat = 'idee', text, importance = 3, due = '', source = '' }) {
  ensure(db);
  const tx = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 600); if (!tx) throw new Error('Note vide.');
  const sc = scope || scopeOf(project, global); const c = CATS.includes(cat) ? cat : 'idee';
  const imp = Math.min(5, Math.max(1, Math.round(Number(importance) || 3))); const d = /^\d{4}-\d\d-\d\d$/.test(due) ? due : '';
  const w = words(tx);
  for (const n of db.prepare('SELECT * FROM mem_notes WHERE scope=?').all(sc)) { // déjà connue : on la renforce au lieu de la dupliquer
    if (jac(w, words(n.text)) >= 0.7) {
      db.prepare('UPDATE mem_notes SET importance=?, uses=uses+1, due=COALESCE(NULLIF(?,\'\'), due), text=? WHERE id=?').run(Math.max(n.importance, imp), d, tx.length > n.text.length ? tx : n.text, n.id);
      fDel(db, 'note', n.id); fIns(db, 'note', n.id, sc.startsWith('projet:') ? sc.slice(7) : '', tx.length > n.text.length ? tx : n.text); return { ...n, merged: true };
    }
  }
  const id = 'n' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  db.prepare('INSERT INTO mem_notes (id, scope, cat, text, importance, due, source, created) VALUES (?,?,?,?,?,?,?,?)').run(id, sc, c, tx, imp, d, String(source).slice(0, 20), Date.now());
  fIns(db, 'note', id, sc.startsWith('projet:') ? sc.slice(7) : '', tx);
  return { id, scope: sc, cat: c, text: tx, importance: imp, due: d };
}
export function updateNote(db, id, p) {
  ensure(db); const n = db.prepare('SELECT * FROM mem_notes WHERE id=?').get(id); if (!n) throw new Error('Note inconnue.');
  const text = p.text != null ? String(p.text).trim().slice(0, 600) || n.text : n.text;
  const imp = p.importance != null ? Math.min(5, Math.max(1, Number(p.importance) || n.importance)) : n.importance;
  const cat = p.cat != null && CATS.includes(p.cat) ? p.cat : n.cat; const due = p.due != null ? (/^\d{4}-\d\d-\d\d$/.test(p.due) ? p.due : '') : n.due;
  db.prepare('UPDATE mem_notes SET text=?, importance=?, cat=?, due=? WHERE id=?').run(text, imp, cat, due, id);
  fDel(db, 'note', id); fIns(db, 'note', id, n.scope.startsWith('projet:') ? n.scope.slice(7) : '', text); return { ...n, text, importance: imp, cat, due };
}
export function removeNote(db, id) { ensure(db); fDel(db, 'note', id); db.prepare('DELETE FROM mem_notes WHERE id=?').run(id); return { ok: true }; }
export function listSummaries(db, project, limit = 40) {
  ensure(db); const k = norm(project);
  return db.prepare('SELECT * FROM mem_summ WHERE ?=\'\' OR lower(project)=? ORDER BY created DESC LIMIT ?').all(k, k, limit);
}
export function removeSummary(db, id) { ensure(db); fDel(db, 'summ', id); db.prepare('DELETE FROM mem_summ WHERE id=?').run(id); return { ok: true }; }

// ------------------------------------------------------------ recherche
function ftsQuery(q) { const t = [...new Set(strip(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 3))].slice(0, 12); return t.length ? t.map((w) => `"${w}"*`).join(' OR ') : ''; }
export function search(db, q, { kinds = ['note', 'summ', 'msg'], limit = 8, project = '' } = {}) {
  ensure(db); const m = ftsQuery(q); if (!m || !fts) return [];
  const rows = db.prepare(`SELECT kind, ref, project, text, bm25(mem_fts) AS s FROM mem_fts WHERE mem_fts MATCH ? ORDER BY s LIMIT ?`).all(m, limit * 4);
  const k = norm(project);
  return rows.filter((r) => kinds.includes(r.kind) && !(r.kind !== 'note' && memConfig(db).private.includes(r.project))
    && !(r.kind === 'note' && r.project && r.project !== k)).slice(0, limit);
}

// ------------------------------------------------------------ bloc injecté
const ago = (t) => { const d = Math.round((Date.now() - t) / 86400000); return d <= 0 ? 'aujourd’hui' : d === 1 ? 'hier' : `il y a ${d} jours`; };
export function buildBlock(db, { project = '', query = '', requestText = '' } = {}) {
  const cfg = memConfig(db); if (!cfg.on) return '';
  ensure(db); const priv = cfg.private.includes(norm(project));
  const notes = new Map();
  if (!priv) { for (const n of listNotes(db, project).filter((x) => x.importance >= 4).slice(0, 6)) notes.set(n.id, n); }
  else for (const n of db.prepare("SELECT * FROM mem_notes WHERE scope='global' AND importance>=4 ORDER BY importance DESC LIMIT 6").all()) notes.set(n.id, n);
  const hits = search(db, query, { project: priv ? '' : project, limit: 10 });
  for (const h of hits.filter((x) => x.kind === 'note').slice(0, 4)) { const n = db.prepare('SELECT * FROM mem_notes WHERE id=?').get(h.ref); if (n && (!priv || n.scope === 'global')) notes.set(n.id, n); }
  const sums = priv ? [] : hits.filter((x) => x.kind === 'summ').slice(0, 3).map((h) => db.prepare('SELECT * FROM mem_summ WHERE id=?').get(h.ref)).filter(Boolean);
  const msgs = priv ? [] : hits.filter((x) => x.kind === 'msg' && !requestText.includes(x.text.slice(0, 50))).slice(0, 2);
  if (!notes.size && !sums.length && !msgs.length) return '';
  const L = ['[Mémoire PAIZ — ce que tu sais de l’utilisateur et du projet ; ne la récite pas, sers-t’en seulement si c’est utile]'];
  if (notes.size) L.push(...[...notes.values()].map((n) => `- (${n.cat}) ${n.text}${n.due ? ` — échéance ${n.due}` : ''}`));
  if (sums.length) { L.push('Souvenirs de conversations passées :'); L.push(...sums.map((s) => `- ${ago(s.created)}${s.title ? ` (« ${s.title} »)` : ''} : ${s.text}`)); }
  if (msgs.length) { L.push('Extraits retrouvés :'); L.push(...msgs.map((m) => `- « ${m.text.slice(0, 300)} »`)); }
  const now = Date.now(); for (const n of notes.values()) db.prepare('UPDATE mem_notes SET last_used=?, uses=uses+1 WHERE id=?').run(now, n.id);
  return L.join('\n').slice(0, 2600);
}
// Ajoute le bloc à la fin du DERNIER message de l'utilisateur : le début du prompt (consignes, historique) reste identique d'un tour à l'autre,
// donc le cache du moteur n'est pas invalidé. Renvoie true si le corps a changé.
export function injectMemory(j, block) {
  if (!block || !Array.isArray(j.messages)) return false;
  const m = [...j.messages].reverse().find((x) => x.role === 'user'); if (!m) return false;
  const add = `\n\n${block}`;
  if (typeof m.content === 'string') m.content += add; else if (Array.isArray(m.content)) m.content.push({ type: 'text', text: add }); else return false;
  return true;
}
export function requestInfo(j) { // dossier de travail (lu dans les consignes d'OpenCode) et dernier texte de l'utilisateur
  const flat = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : '');
  const sys = (j.messages || []).filter((m) => m.role === 'system' || m.role === 'developer').map((m) => flat(m.content)).join('\n');
  const dir = (sys.match(/[Ww]orking directory:\s*([^\n<]+)/) || [])[1] || '';
  const last = [...(j.messages || [])].reverse().find((m) => m.role === 'user');
  return { project: dir.trim(), query: last ? flat(last.content) : '', requestText: (j.messages || []).map((m) => flat(m.content)).join('\n') };
}

// ------------------------------------------------------------ digestion au repos
const dayFr = (t) => new Date(t).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export function buildDigestPrompt({ title = '', when = Date.now(), lines = [], existing = [] }) {
  const L = [];
  L.push('Tu es la mémoire d’un assistant de travail. Lis cette conversation et en tire, en français, ce qui mérite d’être retenu plus tard. Réponds UNIQUEMENT par un objet JSON, sans texte autour :');
  L.push('{"summary":"1 à 3 phrases factuelles sur ce qui s’est dit ou fait","notes":[{"cat":"identite|preference|projet|decision|personne|promesse|idee","text":"fait court, autonome, à la 3e personne (« L’utilisateur préfère… »)","importance":1-5,"due":"AAAA-MM-JJ ou vide","scope":"projet|global"}]}');
  L.push('Règles : n’invente rien ; "global" = ce qui vaut pour l’utilisateur partout (identité, goûts, façon de travailler), "projet" = ce qui concerne ce projet (choix techniques, décisions, avancement, ce qui reste à faire) ; écris les dates en absolu à partir de la date de la conversation ; mets une échéance aux promesses et rendez-vous ; pas de note pour le bavardage ni pour ce qui est déjà dans les notes existantes ; au plus 8 notes ; "notes":[] si rien ne vaut la peine.');
  L.push(`\n## Conversation du ${dayFr(when)}${title ? ` (« ${title} »)` : ''}\n${lines.join('\n')}`);
  if (existing.length) L.push('\n## Notes déjà connues (ne pas répéter)\n' + existing.map((n) => '- ' + n.text).join('\n'));
  return L.join('\n');
}
export function applyDigest(db, t) {
  ensure(db); const m = t.meta || {}; let j = null;
  try { const mm = String(t.text || '').match(/\{[\s\S]*\}/); j = JSON.parse(mm ? mm[0] : '{}'); } catch { j = null; }
  if (!j) return;
  const proj = m.project || '';
  if (j.summary && String(j.summary).trim()) {
    const id = 's' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    db.prepare('INSERT INTO mem_summ (id, session, project, title, text, created) VALUES (?,?,?,?,?,?)').run(id, m.session || '', proj, m.title || '', String(j.summary).trim().slice(0, 700), m.when || Date.now());
    fIns(db, 'summ', id, proj, String(j.summary).trim());
  }
  for (const n of (Array.isArray(j.notes) ? j.notes : []).slice(0, 8)) {
    try { addNote(db, { project: proj, global: n.scope === 'global', cat: n.cat, text: n.text, importance: n.importance, due: n.due, source: 'digest' }); } catch { /* note vide */ }
  }
  for (const l of m.msgs || []) fIns(db, 'msg', m.session || '', proj, l);
  db.prepare('INSERT INTO mem_state (session, upto) VALUES (?,?) ON CONFLICT(session) DO UPDATE SET upto=excluded.upto').run(m.session || '', m.upto || Date.now());
}
const textOf = (m) => (m.type === 'user' ? String(m.text || '') : m.type === 'assistant' ? (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '');
async function sessionMessages(id) {
  const out = []; let cursor = '';
  for (let i = 0; i < 25; i++) {
    const r = await ocCall('GET', `/api/session/${encodeURIComponent(id)}/message?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&order=asc'}`);
    out.push(...(r?.data || [])); cursor = r?.cursor?.next; if (!cursor || !(r?.data || []).length) break;
  }
  return out;
}
let busy = false;
export async function tick(db) {
  if (busy) return; busy = true;
  try {
    ensure(db); const cfg = memConfig(db); if (!cfg.on || !ocStatus().running) return;
    const es = await engineStatus(db); if (!es.running || !es.responding || es.loading) return; // pas de modèle prêt : on attend
    // un modèle avec perte (mode extra-light, ou fichier en Q3 / Q2) rédigerait des résumés et des notes médiocres : on attend un modèle fidèle
    if (LOSSY_PROFILES[es.current?.profile] || /(?:^|[-_.])I?Q[23](?:_[A-Z0-9]+)*\.gguf$/i.test(String(es.current?.path || ''))) return;
    if (listTasks().some((t) => ['queued', 'running', 'paused'].includes(t.status))) return; // la mémoire passe après le vrai travail
    const now = Date.now();
    if (now - lastActivity < MEM_TH.userIdleMs || now - lastDigest < MEM_TH.cooldownMs) return; // tu es en train de discuter, ou elle vient de travailler
    const ss = (await ocCall('GET', '/api/session?limit=200&order=desc'))?.data || [];
    for (const s of ss) {
      const dir = s.location?.directory || ''; const upd = s.time?.updated || 0;
      if (cfg.private.includes(norm(dir)) || Date.now() - upd < IDLE_MS) continue;
      const st = db.prepare('SELECT upto FROM mem_state WHERE session=?').get(s.id); const upto = st?.upto || 0;
      if (upd <= upto) continue;
      const all = await sessionMessages(s.id);
      const fresh = all.filter((m) => (m.time?.created || 0) > upto && textOf(m).trim());
      const lines = fresh.map((m) => `${m.type === 'user' ? 'Utilisateur' : 'Assistant'} : ${textOf(m).trim().replace(/\n{3,}/g, '\n\n').slice(0, 1500)}`);
      let used = []; let size = 0; for (let i = lines.length - 1; i >= 0 && size < MAX_TRANSCRIPT; i--) { used.unshift(lines[i]); size += lines[i].length; }
      const newest = Math.max(upd, ...fresh.map((m) => m.time?.created || 0));
      const nUser = fresh.filter((m) => m.type === 'user').length;
      if (size < 400 || !nUser) { db.prepare('INSERT INTO mem_state (session, upto) VALUES (?,?) ON CONFLICT(session) DO UPDATE SET upto=excluded.upto').run(s.id, newest); continue; }
      if (nUser < MEM_TH.minUserMsgs && now - upd < MEM_TH.shortIdleMs) continue; // pas encore assez à retenir : on laisse la conversation s'étoffer
      const when = fresh[0]?.time?.created || upd;
      const spec = buildDigestPrompt({ title: s.title, when, lines: used, existing: listNotes(db, dir).slice(0, 25) });
      const t = addTask(db, { title: 'Mémoire : ' + (s.title || 'conversation').slice(0, 50), spec, maxTokens: 1500, source: 'memoire', model: 'chat', kind: 'memo', project: dir, meta: { session: s.id, project: dir, title: s.title || '', when, upto: newest, msgs: used.map((l) => l.slice(0, 1200)) } });
      lastDigest = Date.now();
      return t;
    }
  } catch { /* OpenCode ou moteur pas prêts : au prochain passage */ } finally { busy = false; }
}
let timer = null;
export function startMemory(db) {
  setKindHook('memo', (d, t) => applyDigest(d, t));
  if (timer) return; timer = setInterval(() => { tick(db).catch(() => {}); }, 120_000); timer.unref?.();
}
