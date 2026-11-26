// Serveurs MCP de l'écran Travail : liste mémorisée (réglage work.mcp), configuration d'OpenCode, essai de connexion, catalogue (registre officiel).
// Un serveur MCP EXÉCUTE du code sur ta machine : aucun n'est actif tant que tu ne l'as pas activé toi-même.
// Dans cette version d'OpenCode, les outils MCP s'appellent par l'outil `execute` : `tools.<id>.<outil>(...)` (voir codemode.js).
import { spawn, spawnSync } from 'node:child_process';
import { getSetting, setSetting } from './db.js';

const KEY = 'work.mcp';
const WIN = process.platform === 'win32';

export function listMcp(db) {
  try { const a = JSON.parse(getSetting(db, KEY, '[]')); return Array.isArray(a) ? a.filter((s) => s && typeof s.id === 'string') : []; } catch { return []; }
}
const store = (db, list) => setSetting(db, KEY, JSON.stringify(list));
export const nsOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'mcp';

// « ma commande "avec espaces" » -> ['ma','commande','avec espaces']
export function splitCommand(line) {
  const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(String(line || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
// npx est un script .cmd sous Windows : on le lance par cmd /c
export function wrapCommand(cmd) {
  if (WIN && cmd.length && /^(npx|npm|pnpm|yarn)$/i.test(cmd[0])) return ['cmd', '/c', ...cmd];
  return cmd;
}

export function saveMcp(db, s) {
  const label = String(s.label || s.name || '').trim().slice(0, 80);
  const id = nsOf(s.id || s.name || label);
  if (!label && !s.id) throw new Error('Donne un nom au serveur.');
  const type = s.type === 'remote' ? 'remote' : 'local';
  const rec = { id, label: label || id, type, enabled: !!s.enabled, source: s.source || 'manual', repo: s.repo || '', note: String(s.note || '').slice(0, 300) };
  if (type === 'local') {
    const command = Array.isArray(s.command) ? s.command.map(String) : splitCommand(s.command);
    if (!command.length) throw new Error('Indique la commande à lancer.');
    rec.command = command;
    const env = {}; for (const [k, v] of Object.entries(s.environment || {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = String(v);
    rec.environment = env;
  } else {
    if (!/^https?:\/\//i.test(String(s.url || ''))) throw new Error('Adresse invalide (http:// ou https://).');
    rec.url = String(s.url);
  }
  const list = listMcp(db).filter((x) => x.id !== id);
  list.push(rec); store(db, list);
  return rec;
}
export function setMcpEnabled(db, id, enabled) {
  const list = listMcp(db); const s = list.find((x) => x.id === id);
  if (!s) throw new Error('Serveur inconnu.');
  s.enabled = !!enabled; store(db, list); return s;
}
export function removeMcp(db, id) { store(db, listMcp(db).filter((x) => x.id !== id)); }

// Section `mcp` de la configuration d'OpenCode : seulement les serveurs ACTIFS (un serveur désactivé n'est même pas lancé).
export function mcpConfig(db) {
  const out = {};
  for (const s of listMcp(db)) {
    if (!s.enabled) continue;
    out[s.id] = s.type === 'remote'
      ? { type: 'remote', url: s.url, enabled: true }
      : { type: 'local', command: wrapCommand(s.command), enabled: true, ...(s.environment && Object.keys(s.environment).length ? { environment: s.environment } : {}) };
  }
  return out;
}
// Recherche web : l'outil « websearch » d'OpenCode reste bloqué ~60 s puis « Web search cancelled » ici (mesuré le 19/11), alors que le service Exa
// répond en ~1 s. On ajoute donc Exa comme serveur MCP distant (appelé par l'outil execute), une seule fois : si tu le retires, il ne revient pas.
// Les requêtes de recherche partent chez Exa (comme avec websearch). Désactivable dans l'onglet Outils.
export function seedWebSearch(db) {
  if (getSetting(db, 'work.exaSeeded', 0) == 1) return;
  setSetting(db, 'work.exaSeeded', 1);
  if (listMcp(db).some((s) => s.id === 'exa')) return;
  saveMcp(db, { id: 'exa', label: 'Recherche web (Exa)', type: 'remote', url: 'https://mcp.exa.ai/mcp?tools=web_search_exa', enabled: true, source: 'paiz', note: 'Cherche sur le web (actualités, documentation). Tes requêtes de recherche partent chez Exa.' });
}
export const enabledNamespaces = (db) => new Set(listMcp(db).filter((s) => s.enabled).map((s) => s.id));

export function prereqs() {
  const has = (c) => { try { return spawnSync(WIN ? 'where' : 'which', [c], { windowsHide: true }).status === 0; } catch { return false; } };
  return { node: has('npx'), uv: has('uvx') };
}

// ---- essai de connexion : lance le serveur, poignée de main MCP, liste des outils (et poids estimé dans le prompt)
export function probeServer(spec, timeoutMs = 40000) {
  return new Promise((resolve) => {
    if (spec.type === 'remote') { resolve({ ok: false, error: 'Essai non disponible pour un serveur distant.' }); return; }
    const cmd = wrapCommand(spec.command);
    let proc;
    try { proc = spawn(cmd[0], cmd.slice(1), { env: { ...process.env, ...(spec.environment || {}) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { resolve({ ok: false, error: e.message }); return; }
    let buf = ''; let err = ''; let done = false; let tools = null;
    const finish = (r) => {
      if (done) return; done = true; clearTimeout(t);
      try { if (WIN) spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true }); else proc.kill('SIGKILL'); } catch { /* déjà arrêté */ }
      resolve(r);
    };
    const t = setTimeout(() => finish({ ok: false, error: `Pas de réponse en ${Math.round(timeoutMs / 1000)} s.${err ? ` Sortie d'erreur : ${err.slice(-300)}` : ''}` }), timeoutMs);
    const send = (o) => { try { proc.stdin.write(`${JSON.stringify(o)}\n`); } catch { /* fermé */ } };
    proc.on('error', (e) => finish({ ok: false, error: e.code === 'ENOENT' ? `Commande introuvable : ${cmd[0]}` : e.message }));
    proc.on('exit', (c) => { if (!tools) finish({ ok: false, error: `Le serveur s'est arrêté (code ${c}).${err ? ` ${err.slice(-300)}` : ''}` }); });
    proc.stderr.on('data', (b) => { err = (err + String(b)).slice(-2000); });
    proc.stdout.on('data', (b) => {
      buf += String(b);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }); }
        else if (m.id === 2) {
          tools = (m.result?.tools || []).map((x) => ({ name: x.name, description: String(x.description || '').slice(0, 200), chars: JSON.stringify(x).length }));
          finish({ ok: true, tools, tokens: Math.round(tools.reduce((s, x) => s + x.chars, 0) / 3.4) });
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'paiz', version: '1.0.0' } } });
  });
}

// ---- catalogue : registre officiel MCP (open, sans identifiant). N'importe qui y publie : on affiche le dépôt et la version, rien n'est installé sans clic.
export const CURATED = [
  { id: 'blender_headless', category: '3d', label: 'Blender (sans interface)', description: 'Inspecte, convertit, rend et script des fichiers 3D avec un Blender lancé en arrière-plan. Aucun module à installer dans Blender.', type: 'local', command: ['npx', '-y', '@three-ws/blender-mcp'], repo: 'https://github.com/nirholas/three.ws', source: 'curated', needs: 'node', note: 'Registre officiel MCP, v0.5.0. Non testé avec un modèle local.' },
  { id: 'blender_frugal', category: '3d', label: 'Blender (4 outils compacts)', description: 'Quatre outils seulement (découvrir, exécuter, inspecter, capturer) : peu de jetons dans le prompt, idéal pour un modèle local.', type: 'local', command: ['uvx', 'frugal-blender-mcp'], repo: 'https://github.com/mohakmalviya/frugal-blender-mcp', source: 'curated', needs: 'uv', note: 'Registre officiel MCP, v0.2.0. Demande uv (uvx) et probablement un module dans Blender : voir le dépôt.' },
];

// Rubriques du catalogue : chacune lance plusieurs recherches dans le registre (le registre ne sait chercher que par texte, 3 lettres minimum).
export const MCP_CATEGORIES = [
  { id: '3d', label: '🧊 3D & Blender', terms: ['blender', '3d', 'mesh'] },
  { id: 'games', label: '🎮 Moteurs de jeu', terms: ['godot', 'unreal', 'unity'] },
  { id: 'image', label: '🖼 Images & ComfyUI', terms: ['comfyui', 'diffusion', 'image'] },
  { id: 'media', label: '🎬 Vidéo & audio', terms: ['video', 'ffmpeg', 'audio'] },
  { id: 'code', label: '💻 Code & Git', terms: ['github', 'git', 'code'] },
  { id: 'files', label: '📁 Fichiers & documents', terms: ['filesystem', 'pdf', 'docx'] },
  { id: 'data', label: '🗄 Bases de données', terms: ['sqlite', 'postgres', 'database'] },
  { id: 'web', label: '🌐 Web & navigateur', terms: ['browser', 'playwright', 'fetch'] },
  { id: 'notes', label: '🧠 Mémoire & notes', terms: ['memory', 'obsidian', 'notion'] },
];

function mapServer(s) {
  const npm = s.packages?.find((p) => p.registryType === 'npm');
  const pypi = s.packages?.find((p) => p.registryType === 'pypi');
  const remote = s.remotes?.find((x) => /http/.test(x.type || ''));
  const pk = npm || pypi;
  const item = { name: s.name, id: nsOf(s.name.split('/').pop()), title: s.title || s.name, description: s.description || '', version: s.version || '', repo: s.repository?.url || s.websiteUrl || '', env: (pk?.environmentVariables || []).map((v) => ({ name: v.name, required: !!v.isRequired, description: v.description || '' })) };
  if (npm) Object.assign(item, { kind: 'npm', type: 'local', command: ['npx', '-y', npm.version ? `${npm.identifier}@${npm.version}` : npm.identifier], needs: 'node' });
  else if (pypi) Object.assign(item, { kind: 'pypi', type: 'local', command: ['uvx', pypi.version ? `${pypi.identifier}@${pypi.version}` : pypi.identifier], needs: 'uv' });
  else if (remote) Object.assign(item, { kind: 'remote', type: 'remote', url: remote.url });
  else item.kind = s.packages?.[0]?.registryType || 'inconnu';
  item.supported = ['npm', 'pypi', 'remote'].includes(item.kind);
  return item;
}
async function registryPage(term, cursor, limit) {
  const u = new URL('https://registry.modelcontextprotocol.io/v0/servers');
  u.searchParams.set('version', 'latest'); u.searchParams.set('limit', String(Math.min(100, limit)));
  if (term) u.searchParams.set('search', term);
  if (cursor) u.searchParams.set('cursor', cursor);
  const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(r.status === 422 ? 'Tape au moins 3 lettres.' : `Registre MCP : ${r.status}`);
  const d = await r.json();
  return { servers: (d.servers || []).map((e) => e.server || e).filter((s) => s?.name), next: d.metadata?.nextCursor || '' };
}
// terms : une ou plusieurs recherches fusionnées (rubrique) ; cursor : page suivante d'une recherche simple.
export async function searchRegistry({ terms = [], cursor = '', limit = 40 } = {}) {
  const list = terms.map((t) => String(t).trim().slice(0, 80)).filter((t) => t.length >= 3);
  if (!list.length && !cursor) list.push(''); // aucune recherche : le registre dans l'ordre alphabétique
  const pages = await Promise.all(list.map((t) => registryPage(t, list.length === 1 ? cursor : '', list.length === 1 ? limit : 30)));
  const byName = new Map();
  for (const p of pages) for (const s of p.servers) if (!byName.has(s.name)) byName.set(s.name, s);
  const items = [...byName.values()].map(mapServer);
  return { items, nextCursor: list.length === 1 ? pages[0].next : '' };
}
