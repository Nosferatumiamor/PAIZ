// Budget d'outils de l'agent : chaque outil proposé au modèle coûte des tokens à relire (≈ 3 s par millier de tokens sur Gemma).
// Ce module (1) observe, requête après requête, quels outils sont proposés et lesquels le modèle appelle vraiment, (2) applique un PROFIL
// d'usage (discuter / coder / chercher…) puis les choix de l'utilisateur (case décochée = outil retiré, case cochée = outil gardé malgré
// le profil, cadenas = jamais éteint automatiquement), (3) en mode AUTO éteint un outil resté inutile plusieurs tours de suite.
// Changer la liste d'outils en cours de conversation force le moteur à relire tout ce qui suit le changement : mesuré à ≈ 25-30 s pour un
// prompt de 10 000 tokens. D'où : les outils « activables » sont placés EN FIN de liste (le début, stable, reste en cache).
import { getSetting, setSetting } from './db.js';
import { lastPick } from './toolpick.js';

// outils de base (jamais éteints automatiquement, toujours en tête de liste : le début du prompt reste stable)
export const CORE = new Set(['read', 'edit', 'write', 'glob', 'grep', 'apply_patch', 'patch', 'list', 'ls']);
const TERMINAL = ['shell', 'bash', 'powershell', 'cmd'];
const WEB = ['webfetch', 'websearch'];
const AGENTS = ['subagent', 'task', 'skill', 'question', 'execute', 'experimental_image_generate'];
const KNOWN = new Set([...CORE, ...TERMINAL, ...WEB, ...AGENTS, 'todowrite', 'todoread']);

// Un profil dit quels outils CONNUS restent proposés ; les outils inconnus (ajoutés par toi, MCP…) sont gardés, sauf en « Discussion ».
export const PROFILES = {
  auto: { label: 'Automatique', icon: '✨', desc: 'Les outils que la conversation réclame (mots-clés : git, web, agents…). Le comportement d\'origine.', keep: null },
  chat: { label: 'Discussion', icon: '💬', desc: 'Juste discuter : aucun outil. Le prompt le plus court possible, la réponse la plus rapide.', keep: () => false, dropUnknown: true },
  code: { label: 'Code', icon: '⌨️', desc: 'Lire, modifier, chercher dans les fichiers, terminal et liste de tâches. Sans web ni sous-agents.', keep: (n) => CORE.has(n) || TERMINAL.includes(n) || n === 'todowrite' || n === 'todoread' },
  search: { label: 'Recherche', icon: '🔎', desc: 'Lire des pages web (webfetch) et chercher dans les fichiers ; ni terminal ni modification.', keep: (n) => ['read', 'glob', 'grep', 'list', 'ls'].includes(n) || WEB.includes(n) },
  full: { label: 'Complet', icon: '🧰', desc: 'Tous les outils. Plus lent à chaque nouvelle session ; à choisir si le travail est vraiment varié.', keep: () => true },
};

const DEFAULT = { profile: 'auto', mode: 'manual', off: {}, on: [], locked: [] };
const RED_AFTER_TURNS = 8;   // aucun appel depuis le début d'une conversation de ≥ 8 messages : « rouge »
const GREEN_WITHIN_TURNS = 6; // appelé dans les 6 derniers messages : « vert »
const AUTO_STREAK = 3;        // requêtes consécutives en rouge avant extinction automatique
const HEAVY_TOKENS = 1000;

export function getBudget(db) {
  try { const v = JSON.parse(getSetting(db, 'tools.budget', 'null')); if (v && typeof v === 'object') return { ...DEFAULT, ...v, off: v.off || {}, on: v.on || [], locked: v.locked || [] }; } catch { /* réglage illisible */ }
  return { ...DEFAULT, off: {}, on: [], locked: [] };
}
const save = (db, b) => setSetting(db, 'tools.budget', JSON.stringify(b));

export function setBudget(db, patch = {}) {
  const b = getBudget(db);
  if (patch.profile != null) { if (!PROFILES[patch.profile]) throw new Error('Profil inconnu.'); b.profile = patch.profile; b.off = {}; b.on = []; streak.clear(); }
  if (patch.mode != null) { if (!['manual', 'auto'].includes(patch.mode)) throw new Error('Mode inconnu.'); b.mode = patch.mode; streak.clear(); }
  if (patch.toggle) {
    const { name, on } = patch.toggle; if (!name) throw new Error('Outil manquant.');
    delete b.off[name]; b.on = b.on.filter((x) => x !== name);
    if (on) { if (view && !view.profileKeeps.includes(name)) b.on.push(name); } else b.off[name] = 'user';
    streak.delete(name);
  }
  if (patch.mcpSelect != null) { if (!['smart', 'all'].includes(patch.mcpSelect)) throw new Error('Choix inconnu.'); setSetting(db, 'engine.mcpSelect', patch.mcpSelect); }
  if (patch.lock) { const { name, locked } = patch.lock; b.locked = b.locked.filter((x) => x !== name); if (locked) b.locked.push(name); streak.delete(name); }
  save(db, b);
  return b;
}

// ---- observation ----
const streak = new Map(); // outil → requêtes consécutives « rouge »
let view = null;          // dernière requête vue (ce que montre le panneau)
export const budgetView = () => view;

const nameOf = (t) => t.function?.name || t.name;
const tok = (bytes) => Math.round(bytes / 3.4);
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text || '').join(' ') : '');

// usage observé dans l'historique de la requête : appels par outil et nombre de messages utilisateur depuis le dernier appel
function usage(messages) {
  const calls = new Map(); let turn = 0;
  for (const m of messages || []) {
    if (m.role === 'user') turn++;
    else if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) { const n = c.function?.name; if (n) { const u = calls.get(n) || { n: 0, at: 0 }; u.n++; u.at = turn; calls.set(n, u); } }
  }
  return { calls, turns: turn };
}

export function classify(name, u, turns) {
  const c = u.calls.get(name);
  if (CORE.has(name)) return 'green';
  if (c && turns - c.at <= GREEN_WITHIN_TURNS) return 'green';
  if (c) return 'orange';
  if (turns < RED_AFTER_TURNS) return 'orange'; // pas encore assez de recul pour juger
  return 'red';
}

// Applique le budget à la requête (modifie j.tools) ; retourne { removed, groups }. autoFn = sélection par mots-clés d'origine (profil « auto »).
export function applyBudget(db, j, autoFn, { allowSearch = false, keepExtra = [] } = {}) {
  const b = getBudget(db);
  const original = Array.isArray(j.tools) ? j.tools.slice() : [];
  const total = tok(Buffer.byteLength(JSON.stringify(j)));
  const u = usage(j.messages);
  let removed = []; let groups = [PROFILES[b.profile].label];
  const reasons = new Map();
  if (original.length) {
    if (b.profile === 'auto') {
      const r = autoFn(j); removed = r.removed.slice(); groups = r.groups;
      for (const n of removed) reasons.set(n, 'mots-clés');
    } else {
      const P = PROFILES[b.profile];
      if (!allowSearch) j.tools = j.tools.filter((t) => { const drop = nameOf(t) === 'websearch'; if (drop) { removed.push('websearch'); reasons.set('websearch', 'moteur de recherche bloqué'); } return !drop; });
      j.tools = j.tools.filter((t) => {
        const n = nameOf(t);
        const known = KNOWN.has(n);
        const keep = keepExtra.includes(n) || (known ? P.keep(n) : !P.dropUnknown);
        if (!keep && !removed.includes(n)) { removed.push(n); reasons.set(n, `profil ${P.label}`); }
        return keep;
      });
    }
    const keptByProfile = j.tools.map(nameOf);
    // choix de l'utilisateur : « gardé quand même » (réintègre un outil que le profil avait retiré) puis « éteint »
    for (const n of b.on) { const t = original.find((x) => nameOf(x) === n); if (t && !keptByProfile.includes(n)) { j.tools.push(t); removed = removed.filter((x) => x !== n); reasons.delete(n); } }
    for (const n of Object.keys(b.off)) if (j.tools.some((t) => nameOf(t) === n)) { j.tools = j.tools.filter((t) => nameOf(t) !== n); removed.push(n); reasons.set(n, b.off[n] === 'auto' ? 'éteint automatiquement' : 'éteint par toi'); }
    // stable en tête (outils de base), activables en fin de liste : un changement ne fait relire que la queue et la conversation
    j.tools = j.tools.map((t, i) => [t, i]).sort((x, y) => (CORE.has(nameOf(x[0])) ? 0 : 1) - (CORE.has(nameOf(y[0])) ? 0 : 1) || x[1] - y[1]).map((x) => x[0]);
    if (j.tool_choice && typeof j.tool_choice === 'object' && removed.includes(j.tool_choice.function?.name)) delete j.tool_choice;
    if (!j.tools.length) { delete j.tools; delete j.tool_choice; } // plus aucun outil : le champ lui-même est retiré
  }
  // vue pour le panneau
  const kept = new Set((j.tools || []).map(nameOf));
  const rows = original.map((t) => {
    const n = nameOf(t); const tokens = tok(Buffer.byteLength(JSON.stringify(t)));
    const state = kept.has(n) ? classify(n, u, u.turns) : 'black';
    const c = u.calls.get(n);
    return { name: n, tokens, on: kept.has(n), state, calls: c?.n || 0, turnsSince: c ? u.turns - c.at : null, core: CORE.has(n), locked: b.locked.includes(n), why: kept.has(n) ? '' : (reasons.get(n) || '') };
  });
  view = { at: Date.now(), turns: u.turns, promptTok: total, rows, profile: b.profile, mode: b.mode, profileKeeps: original.map(nameOf).filter((n) => { const P = PROFILES[b.profile]; return b.profile === 'auto' ? !reasons.has(n) || reasons.get(n) !== 'mots-clés' : (KNOWN.has(n) ? P.keep(n) : !P.dropUnknown); }) };
  // AUTO : un outil proposé mais resté rouge AUTO_STREAK requêtes de suite est éteint (sauf cadenas / outils de base)
  if (b.mode === 'auto' && original.length) {
    let changed = false;
    for (const r of rows) {
      if (r.on && r.state === 'red' && !r.core && !r.locked) { const s = (streak.get(r.name) || 0) + 1; streak.set(r.name, s); if (s >= AUTO_STREAK) { b.off[r.name] = 'auto'; streak.delete(r.name); changed = true; } }
      else streak.delete(r.name);
    }
    if (changed) save(db, b); // appliqué à partir de la requête suivante
  }
  return { removed, groups };
}

// Résumé pour le panneau : lignes, économie possible (outils rouges encore proposés), coût d'un changement
export function budgetPanel(db, prefillRate = 200) {
  const b = getBudget(db);
  const v = view;
  const reds = v ? v.rows.filter((r) => r.on && r.state === 'red' && !r.core) : [];
  const heavy = v ? v.rows.filter((r) => r.on && r.tokens >= HEAVY_TOKENS && r.state !== 'green') : [];
  const rate = Math.max(40, Number(prefillRate) || 200);
  return {
    cfg: b,
    profiles: Object.entries(PROFILES).map(([id, p]) => ({ id, label: p.label, icon: p.icon, desc: p.desc })),
    view: v,
    suggest: v ? { tokens: reds.reduce((s, r) => s + r.tokens, 0), names: reds.map((r) => r.name), heavy: heavy.map((r) => r.name) } : null,
    // relecture maximale si l'on change la liste : tout le prompt après le début (borne haute, les outils de base restent en cache)
    changeCostS: v ? Math.round(v.promptTok / rate) : null,
    // serveurs MCP choisis selon la question (toolpick.js) : gardés / écartés et prefill évité à la dernière requête
    mcp: (() => { const p = lastPick(); return p ? { ...p, mode: getSetting(db, 'engine.mcpSelect', 'smart'), savedS: p.savedTok ? Math.round((p.savedTok / rate) * 10) / 10 : 0 } : { mode: getSetting(db, 'engine.mcpSelect', 'smart') }; })(),
    rate,
    thresholds: { redAfterTurns: RED_AFTER_TURNS, greenWithinTurns: GREEN_WITHIN_TURNS, autoStreak: AUTO_STREAK, heavyTokens: HEAVY_TOKENS },
  };
}
