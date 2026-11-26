// Local HTTP API + web UI. No framework, no build step.
import { usageReport, recentMap } from './usage.js';
import { annotateGroups, mergeCopies, planAll, startSmartMerge } from './dedupe.js';
import { relatedTo } from './related.js';
import { sysStats } from './sysmon.js';
import { checkLocal } from './localguard.js';
import { moeMap } from './moe.js';
import { writeMarker, markAll, findRepos, relocateRoot } from './repomark.js';
import { listLocalVolumes } from './volumes.js';
import { setEyeMode, eyeStatus } from './eye.js';
import { replaceImages } from './proxy.js';
import { timeNote } from './clock.js';
import { injectMemory } from './memory.js';
import { componentsReport, setProgram, provision, restore as restoreComponent } from './components.js';
import { quantOptions, quantState, startQuantize, freshIds, markSeen } from './quantize.js';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import { APP_NAME, APP_VERSION, normalizeDir, nowIso, pathExists, volumeOf } from './util.js';
import { DATA_DIR, DB_PATH, PUBLIC_DIR, DEFAULT_PORT } from './config.js';
import {
  addRoot, allAssets, duplicateGroups, getAsset, getRoot, listEvents, listLinks, listRoots,
  logEvent, openDb, queryAssets, removeRoot, stats, updateAsset, getSetting, setSetting,
} from './db.js';
import { CATEGORIES, BASE_MODELS, baseFamily } from './detect.js';
import {
  cancelJob, getJob, listJobs,
  assertTransferSpace, checkTransferSpace, startBulkMoveJob, startHashJob, startLinkJob, startRestoreJob, startScanAllJob, startScanJob, startTrashJob, startTransferJob,
} from './jobs.js';
import { engineConfig, variantInfo, buildVariant, setEngineGear, engineStatus, startEngine, stopEngine, summon, summonState, opencodeConfig, opencodeStatus, connectOpencode, launchOpencode, getEngineSettings, setEngineSettings, autoloadLast, engineChat, engineChatStream, currentModel }
  from './engine.js';
import { searchModels, modelFiles, modelSizeRange, repoArch, startDownload } from './hub.js';
import { machineSpecs, estimateFit, isMoe } from './fit.js';
import { listPersonas, savePersona, setActivePersona, removePersona, personaOpts, setPersonaOpts, activePersonaText, injectPersona } from './persona.js';
import { budgetPanel, setBudget, getBudget } from './toolbudget.js';
import { proxyV1, relayPause, relayAbortAll, relayStatus, relayRefresh, relayLive, relayTimings } from './proxy.js';
import { listLiberables, startLiberateJob } from './liberer.js';
import { ecurieStatus, setCleanRoot, planReorg, applyReorg, undoLast, writeTrace } from './ecurie.js';
import { ensureOpencode, ocStatus, proxyOc, createSession, sendPrompt, interrupt, restartOpencode, listFreeModels, setSessionModel, usageSummary, noteLocalModel } from './work.js';
import { seedWebSearch, listMcp, saveMcp, setMcpEnabled, removeMcp, probeServer, searchRegistry, prereqs, CURATED, MCP_CATEGORIES } from './mcp.js';
import { listConfs, saveConf, deleteConf, updateConf, loadConf } from './confs.js';
import { listGroups, createGroup, deleteGroup, updateGroup, parkGroup, recallGroup } from './groups.js';
import { linksForAll, moveInfo, moveModel, mergeRoots } from './placement.js';
import { setupState, markSetupDone, installOpencode, opencodeJob } from './setup.js';
import { listProjects, saveProjects, folderSize, revealFolder } from './projects.js';
import { runScript, stopScript, runningFiles } from './runner.js';
import { listSkills, setSkillEnabled, removeSkill, installFromGithub, installBuiltin, skillPrereqs, SKILLS_CURATED } from './skills.js';
import { listShelf, shelve, restore, shelfState } from './shelf.js';
import { diskHealth, scanCaches, flushCache, startBackup, backup, scanLeftovers, removeLeftovers } from './maintenance.js';
import { sweepOrphans, findStrays, stopStray } from './orphans.js';
import { pickFolder, pickFiles } from './pickfolder.js';
import { listTasks, getTask, addTask, cancelTask, retryTask, removeTask, clearFinished, startTasks, editTask, launchTasks, reorderTasks, queueControl, queueState } from './tasks.js';
import { createPlan, createNotes } from './plans.js';
import { noteActivity, memConfig, setMemConfig, listNotes, addNote, updateNote, removeNote, listSummaries, removeSummary, search as memSearch, startMemory } from './memory.js';
import { listIdeas, addIdea, updateIdea, removeIdea } from './ideas.js';
import { listScanTargets } from './volumes.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('Requête trop volumineuse');
    chunks.push(chunk);
  }
  if (!total) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw new Error('JSON invalide'); }
}

function mapAsset(row) {
  let tags = [];
  let meta = null;
  try { tags = row.tags_json ? JSON.parse(row.tags_json) : []; } catch { /* ignore */ }
  try { meta = row.meta_json ? JSON.parse(row.meta_json) : null; } catch { /* ignore */ }
  const { tags_json, meta_json, ...rest } = row;
  return { ...rest, tags, meta };
}

async function rootWithSpace(root) {
  const exists = await pathExists(root.path);
  let space = null;
  if (exists) {
    try {
      const st = await fsp.statfs(root.path);
      space = { free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) };
    } catch { /* ignore */ }
  }
  return {
    ...root,
    volume: root.volume || volumeOf(root.path),
    exists,
    free: space?.free ?? null,
    total: space?.total ?? null,
  };
}

async function buildState(db) {
  const roots = [];
  for (const root of listRoots(db)) roots.push(await rootWithSpace(root));
  const s = stats(db);

  // Aggregate volumes from roots (an unplugged volume stays visible but with free=null).
  const volumes = new Map();
  for (const root of roots) {
    const key = (root.volume || '?').toUpperCase();
    if (!volumes.has(key)) {
      volumes.set(key, {
        volume: root.volume || '?',
        free: null,
        total: null,
        exists: false,
        roots: [],
        assetCount: 0,
        assetBytes: 0,
      });
    }
    const vol = volumes.get(key);
    vol.roots.push({ id: root.id, name: root.name, role: root.role, path: root.path, exists: root.exists });
    if (root.exists) {
      vol.exists = true;
      if (root.free != null) {
        vol.free = Math.max(vol.free ?? 0, root.free);
        vol.total = Math.max(vol.total ?? 0, root.total ?? 0);
      }
    }
    const perRoot = s.byRoot.find((r) => r.id === root.id);
    vol.assetCount += perRoot?.count || 0;
    vol.assetBytes += perRoot?.bytes || 0;
  }

  return {
    app: { name: APP_NAME, version: APP_VERSION, dataDir: DATA_DIR, dbPath: DB_PATH, now: nowIso() },
    roots,
    volumes: [...volumes.values()].sort((a, b) => a.volume.localeCompare(b.volume)),
    stats: s,
    jobs: listJobs().filter((j) => j.status === 'running').map(jobSummary),
    events: listEvents(db, 20),
    categories: CATEGORIES,
    bases: BASE_MODELS,
  };
}

function jobSummary(job) {
  return {
    id: job.id, type: job.type, label: job.label, status: job.status,
    cancelled: job.cancelled, startedAt: job.startedAt, endedAt: job.endedAt,
    progress: job.progress, result: job.result, error: job.error, meta: job.meta,
  };
}

function parseAssetsQuery(url) {
  const p = url.searchParams;
  return {
    q: p.get('q') || '',
    category: p.get('category') || 'all',
    base: p.get('base') || 'all',
    rootId: p.get('rootId') || 'all',
    volume: p.get('volume') || null,
    role: p.get('role') || 'all',
    state: p.get('state') || 'present',
    unmanaged: p.get('unmanaged') === '1',
    minSize: p.get('minSize') ? Number(p.get('minSize')) : null,
    sort: p.get('sort') || 'size',
    dir: p.get('dir') || (p.get('sort') === 'name' ? 'asc' : 'desc'),
    limit: Number(p.get('limit') || 200),
    offset: Number(p.get('offset') || 0),
  };
}

// Interface de PAIZ : la page de base (écrans réutilisés) habillée par la coquille v2 (bandeau, onglets, pastille moteur, « Ma collection »).
// C'est la seule interface servie : l'ancienne coquille (nav.js) a été retirée.
async function serveV2(res) {
  let html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const sub = (a, b) => { if (html.includes(a)) html = html.replace(a, b); };
  sub('</head>', '  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Nunito:wght@400;600;700;800&display=swap">\n  <link rel="stylesheet" href="/v2/v2.css">\n</head>');
  sub('<body>', '<body class="v2">\n  <div id="v2-shell"></div>');
  sub('<button data-view="disks" class="tab">', '<button data-view="collection" class="tab hidden-tab">Ma collection</button>\n    <button data-view="v2iface" class="tab hidden-tab">Interface</button>\n    <button data-view="v2engine" class="tab hidden-tab">Moteur</button>\n    <button data-view="v2care" class="tab hidden-tab">Ménage</button>\n    <button data-view="v2roots" class="tab hidden-tab">Dossiers</button>\n    <button data-view="disks" class="tab">');
  sub('<main>', '<main>\n    <section id="view-collection" class="view"><div id="collection-body"></div></section>\n    <section id="view-v2iface" class="view"><div id="v2iface-body"></div></section>\n    <section id="view-v2engine" class="view"><div id="v2engine-body"></div></section>\n    <section id="view-v2care" class="view"><div id="v2care-body"></div></section>\n    <section id="view-v2roots" class="view"><div id="v2roots-body"></div></section>');
  sub('<script type="module" src="/nav.js"></script>', '<script type="module" src="/v2/shell.js"></script>\n  <script type="module" src="/v2/collection.js"></script>\n  <script type="module" src="/v2/care.js"></script>\n  <script type="module" src="/v2/roots.js"></script>\n  <script type="module" src="/v2/details.js"></script>\n  <script type="module" src="/v2/setup.js"></script>');
  const data = Buffer.from(html, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
  res.end(data);
}

async function serveStatic(res, pathname, db) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/nouvelle' || rel === '/nouvelle/') { await serveV2(res); return; }
  if (rel === '/' || rel === '' || rel === '/index.html' || rel === '/ancienne' || rel === '/ancienne/') { await serveV2(res); return; }
  const abs = path.join(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new Error('not a file');
    const data = await fsp.readFile(abs);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

export function createServer(db) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    // verrou : seule l'interface de PAIZ et les programmes de la machine pilotent le serveur (voir localguard.js)
    const refused = checkLocal(req, pathname);
    if (refused) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`PAIZ : ${refused}.`); return; }

    if (req.method === 'OPTIONS') {
      // le CORS n'est ouvert que pour /v1 (discussion compatible OpenAI, utilisée par des interfaces de chat dans le navigateur)
      res.writeHead(204, pathname.startsWith('/v1/') ? {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      } : {});
      res.end();
      return;
    }

    if (pathname.startsWith('/v1/')) { await proxyV1(db, req, res, pathname, url.search); return; }
    if (pathname.startsWith('/oc/')) { proxyOc(req, res, pathname, url.search); return; }

    if (!pathname.startsWith('/api/')) {
      await serveStatic(res, pathname, db);
      return;
    }

    try {
      // ---- state / meta -------------------------------------------------
      // ---- moteur WeightStream (invocation / OpenCode) --------------------
      if (req.method === 'GET' && pathname === '/api/engine') {
        sendJson(res, 200, { ...(await engineStatus(db)), summon: summonState });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/engine/summon') {
        const body = await readBody(req);
        sendJson(res, 202, { ...summon(db, body) });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/engine/start') {
        const body = await readBody(req);
        const asset = getAsset(db, body.assetId);
        if (!asset) throw new Error('Modèle inconnu du catalogue.');
        const started = await startEngine(db, { asset, profile: body.profile, ctx: body.ctx, slots: body.slots });
        setSetting(db, 'work.lastAsset', asset.id);
        sendJson(res, 202, started);
        return;
      }
      // ---- écran « Travail » : OpenCode piloté par son serveur privé, contrôle du relais, chargement du modèle ----
      if (req.method === 'POST' && pathname === '/api/work/start') {
        const port = Number((req.headers.host || '').split(':').pop()) || DEFAULT_PORT;
        await ensureOpencode(db, port);
        sendJson(res, 200, { ok: true, ...ocStatus() });
        return;
      }
      if (pathname === '/api/work/persona') {
        if (req.method === 'POST') {
          const b = await readBody(req);
          let savedId = null;
          if (b.save) savedId = savePersona(db, b.save);
          if (b.remove) removePersona(db, b.remove);
          if (b.opts) setPersonaOpts(db, b.opts);
          if (b.active || savedId && b.activate) setActivePersona(db, b.active || savedId);
          sendJson(res, 200, { ...listPersonas(db), opts: personaOpts(db), savedId });
        } else sendJson(res, 200, { ...listPersonas(db), opts: personaOpts(db) });
        return;
      }
      // ---- archive des projets du Travail
      if (pathname === '/api/work/projects') {
        if (req.method === 'PUT') { sendJson(res, 200, saveProjects(db, await readBody(req))); return; }
        if (req.method === 'GET') { sendJson(res, 200, listProjects(db)); return; }
      }
      if (req.method === 'GET' && pathname === '/api/work/projects/size') { sendJson(res, 200, await folderSize(url.searchParams.get('dir'))); return; }
      if (req.method === 'POST' && pathname === '/api/work/projects/reveal') { revealFolder((await readBody(req)).dir); sendJson(res, 200, { ok: true }); return; }
      // ---- lancer un script écrit par le modèle (bouton « ▶ Lancer »)
      if (req.method === 'POST' && pathname === '/api/work/run') { const b = await readBody(req); sendJson(res, 200, await runScript(db, { file: String(b.file || ''), dir: String(b.dir || '') })); return; }
      if (req.method === 'POST' && pathname === '/api/work/run/stop') { sendJson(res, 200, stopScript(String((await readBody(req)).file || ''))); return; }
      if (req.method === 'GET' && pathname === '/api/work/run/state') { sendJson(res, 200, { running: runningFiles() }); return; }
      // ---- outils MCP (onglet Outils)
      if (pathname === '/api/work/skills') {
        let restarted = false; let added = [];
        if (req.method === 'POST') {
          const b = await readBody(req);
          if (b.install?.builtin) added = installBuiltin(String(b.install.url).replace(/^paiz:/, ''));
          else if (b.install) added = await installFromGithub(String(b.install.url || ''), Array.isArray(b.install.needs) ? b.install.needs.map(String) : []);
          if (b.toggle) setSkillEnabled(String(b.toggle.id), !!b.toggle.enabled);
          if (b.remove) removeSkill(String(b.remove));
          if (!b.install && ocStatus().running) { await restartOpencode(db, port); restarted = true; } // la liste des skills n'est lue qu'au démarrage d'OpenCode
        }
        sendJson(res, 200, { skills: listSkills(), curated: SKILLS_CURATED, prereqs: skillPrereqs(), added, restarted });
        return;
      }
      if (pathname === '/api/work/mcp') {
        let restarted = false;
        if (req.method === 'POST') {
          const b = await readBody(req);
          if (b.save) saveMcp(db, b.save);
          if (b.toggle) setMcpEnabled(db, String(b.toggle.id), !!b.toggle.enabled);
          if (b.remove) removeMcp(db, String(b.remove));
          if (ocStatus().running) { await restartOpencode(db, Number((req.headers.host || '').split(':').pop()) || DEFAULT_PORT); restarted = true; } // la nouvelle liste n'est lue qu'au démarrage d'OpenCode
        }
        sendJson(res, 200, { servers: listMcp(db), curated: CURATED, categories: MCP_CATEGORIES.map(({ id, label }) => ({ id, label })), prereqs: prereqs(), restarted });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/work/mcp/search') { const cat = MCP_CATEGORIES.find((c) => c.id === url.searchParams.get('cat'));
        const q = url.searchParams.get('q') || '';
        sendJson(res, 200, await searchRegistry({ terms: cat ? cat.terms : (q ? [q] : []), cursor: cat ? '' : (url.searchParams.get('cursor') || '') }));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/work/mcp/probe') {
        const b = await readBody(req);
        const spec = b.id ? listMcp(db).find((s) => s.id === b.id) : b.spec;
        if (!spec) throw new Error('Serveur inconnu.');
        sendJson(res, 200, await probeServer(spec));
        return;
      }
      // File de tâches du gros modèle local (une à la fois, la discussion reste libre)
      if (pathname === '/api/tasks' && req.method === 'GET') { sendJson(res, 200, { tasks: listTasks(), ...queueState() }); return; }
      if (pathname === '/api/tasks' && req.method === 'POST') { const b = await readBody(req); sendJson(res, 200, addTask(db, { title: b.title, spec: b.spec, maxTokens: b.maxTokens, source: b.source, model: b.model, project: typeof b.project === 'string' ? b.project : '', files: b.files, speed: b.speed, status: b.draft ? 'draft' : 'queued' })); return; }
      if (pathname === '/api/tasks/reorder' && req.method === 'POST') { const b = await readBody(req); sendJson(res, 200, reorderTasks(Array.isArray(b.ids) ? b.ids.map(String) : [])); return; }
      if (pathname === '/api/tasks/launch' && req.method === 'POST') { const b = await readBody(req); sendJson(res, 200, launchTasks(db, Array.isArray(b.ids) ? b.ids.map(String) : [])); return; }
      if (pathname === '/api/tasks/queue' && req.method === 'POST') { const b = await readBody(req); sendJson(res, 200, await queueControl(db, String(b.action || ''))); return; }
      if (pathname === '/api/plans' && req.method === 'POST') { sendJson(res, 200, createPlan(db, await readBody(req))); return; }
      if (pathname === '/api/memory' && req.method === 'GET') { const p = url.searchParams.get('project') || ''; const c = memConfig(db); sendJson(res, 200, { on: c.on, private: c.private.includes(p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()), notes: listNotes(db, p), summaries: listSummaries(db, p) }); return; }
      if (pathname === '/api/memory/search' && req.method === 'GET') { sendJson(res, 200, { hits: memSearch(db, url.searchParams.get('q') || '', { project: url.searchParams.get('project') || '', limit: 20 }) }); return; }
      if (pathname === '/api/memory/settings' && req.method === 'POST') { sendJson(res, 200, setMemConfig(db, await readBody(req))); return; }
      if (pathname === '/api/memory/notes' && req.method === 'POST') { sendJson(res, 200, addNote(db, await readBody(req))); return; }
      { const mm = pathname.match(/^\/api\/memory\/(notes|summaries)\/([\w-]+)$/); if (mm) { if (mm[1] === 'notes' && req.method === 'PATCH') { sendJson(res, 200, updateNote(db, mm[2], await readBody(req))); return; } if (req.method === 'DELETE') { sendJson(res, 200, mm[1] === 'notes' ? removeNote(db, mm[2]) : removeSummary(db, mm[2])); return; } } }
      if (pathname === '/api/notes/ask' && req.method === 'POST') { const b = await readBody(req); sendJson(res, 200, createNotes(db, { ...b, existing: listIdeas(b.project || '') })); return; }
      if (pathname === '/api/ideas' && req.method === 'GET') { sendJson(res, 200, { ideas: listIdeas(url.searchParams.get('project') || '') }); return; }
      if (pathname === '/api/ideas' && req.method === 'POST') { sendJson(res, 200, addIdea(await readBody(req))); return; }
      { const mi = pathname.match(/^\/api\/ideas\/([\w-]+)$/); if (mi) { if (req.method === 'PATCH') { sendJson(res, 200, updateIdea(mi[1], await readBody(req))); return; } if (req.method === 'DELETE') { sendJson(res, 200, removeIdea(mi[1])); return; } } }
      if (pathname === '/api/tasks/clear' && req.method === 'POST') { sendJson(res, 200, clearFinished()); return; }
      { const m = pathname.match(/^\/api\/tasks\/([\w-]+)(?:\/(cancel|retry))?$/);
        if (m) {
          if (req.method === 'GET' && !m[2]) { const t = getTask(m[1]); if (!t) { sendJson(res, 404, { error: 'Tâche inconnue.' }); return; } sendJson(res, 200, t); return; }
          if (req.method === 'POST' && m[2] === 'cancel') { sendJson(res, 200, cancelTask(m[1])); return; }
          if (req.method === 'POST' && m[2] === 'retry') { sendJson(res, 200, retryTask(db, m[1])); return; }
          if (req.method === 'DELETE' && !m[2]) { sendJson(res, 200, removeTask(m[1])); return; }
          if (req.method === 'PATCH' && !m[2]) { sendJson(res, 200, editTask(db, m[1], await readBody(req))); return; }
        } }
      if (req.method === 'GET' && pathname === '/api/work/timings') { sendJson(res, 200, relayTimings()); return; }
      if (req.method === 'GET' && pathname === '/api/work/live') { sendJson(res, 200, await relayLive()); return; }
      if (req.method === 'GET' && pathname === '/api/work/state') {
        const eng = await engineStatus(db);
        await relayRefresh();
        const la = getSetting(db, 'work.lastAsset', null); const laAsset = la ? getAsset(db, Number(la)) : null;
        if (eng.running && laAsset) noteLocalModel(db, laAsset.title || laAsset.file_name);
        sendJson(res, 200, { tools: { profile: getBudget(db).profile, mode: getBudget(db).mode }, oc: ocStatus(), engine: { loading: eng.loading, loadElapsed: eng.loadElapsed, loadEstimate: eng.loadEstimate, lastAssetName: laAsset ? (laAsset.title || laAsset.file_name) : null, responding: eng.responding, lossy: eng.lossy, running: eng.running, current: eng.current, lastAsset: getSetting(db, 'work.lastAsset', null), profiles: eng.profiles, profileInfo: eng.profileInfo, grid: eng.grid, profile: eng.current?.profile || (getSetting(db, 'engine.profile', 'normal') === 'extralight' ? 'normal' : getSetting(db, 'engine.profile', 'normal')), gear: Number(getSetting(db, 'work.gear', 0)) || 0, autoload: ['1', 'true'].includes(String(getSetting(db, 'engine.autoload', 0))) }, relay: relayStatus() });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/work/pause') {
        const b = await readBody(req);
        sendJson(res, 200, { paused: relayPause(b.paused ?? !relayStatus().paused) });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/work/session') {
        const b = await readBody(req);
        sendJson(res, 200, await createSession(db, b.dir, b.title));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/work/usage') { await ensureOpencode(db, Number((req.headers.host || '').split(':').pop()) || DEFAULT_PORT); sendJson(res, 200, await usageSummary(db)); return; }
      if (req.method === 'GET' && pathname === '/api/work/models') { sendJson(res, 200, { free: await listFreeModels() }); return; }
      if (req.method === 'POST' && pathname === '/api/work/session-model') { const b = await readBody(req); sendJson(res, 200, await setSessionModel(String(b.sessionID || ''), String(b.providerID || ''), String(b.id || ''))); return; }
      if (req.method === 'POST' && pathname === '/api/work/prompt') {
        const b = await readBody(req, 40 * 1024 * 1024);
        if (!String(b.text || '').trim()) throw new Error('Message vide.');
        sendJson(res, 200, await sendPrompt(b.sessionID, b.text, b.files));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/work/stop') {
        const b = await readBody(req);
        let interrupted = false;
        if (b.sessionID) { try { interrupted = await interrupt(b.sessionID); } catch { /* session absente : on coupe quand même le relais */ } }
        sendJson(res, 200, { interrupted, aborted: relayAbortAll() });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/work/engine/load') {
        const b = await readBody(req);
        const id = Number(b.assetId || getSetting(db, 'work.lastAsset', 0) || (await engineStatus(db)).current?.assetId || 0);
        const asset = id ? getAsset(db, id) : null;
        if (!asset) throw new Error("Aucun modèle mémorisé : charge-le une première fois depuis l'onglet WeightStream.");
        const r = await startEngine(db, { asset, profile: b.profile });
        setSetting(db, 'work.lastAsset', asset.id);
        if (b.profile) setSetting(db, 'engine.profile', b.profile);
        sendJson(res, 202, r);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/work/engine/gear') {
        const b = await readBody(req);
        sendJson(res, 200, { gear: await setEngineGear(db, b.gear) });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/work/engine/unload') {
        relayAbortAll();
        await stopEngine();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/engine/stop') {
        await stopEngine();
        sendJson(res, 200, { ok: true });
        return;
      }
      // Fenêtre native « choisir un dossier » (avec le bouton « Créer un dossier »), ouverte sur cette machine ; renvoie {path} ou {path:null} si annulé.
      if (req.method === 'POST' && pathname === '/api/pick-files') { const b = await readBody(req); sendJson(res, 200, { paths: await pickFiles(b.start) }); return; }
      if (req.method === 'POST' && pathname === '/api/pick-folder') { const b = await readBody(req); sendJson(res, 200, { path: await pickFolder(b.start) }); return; }
      if (req.method === 'GET' && pathname === '/api/engine/settings') { sendJson(res, 200, getEngineSettings(db)); return; }
      if (req.method === 'POST' && pathname === '/api/engine/settings') { sendJson(res, 200, setEngineSettings(db, await readBody(req))); return; }
      if (req.method === 'POST' && pathname === '/api/engine/chat-stream') {
        let b = await readBody(req); noteActivity();
        // une image jointe : l'œil de PAIZ la décrit (le moteur ne lit que du texte), comme pour les conversations de projet
        if ((b.messages || []).some((m) => Array.isArray(m.content))) { const t0 = Date.now(); try { b = JSON.parse((await replaceImages(Buffer.from(JSON.stringify(b)))).toString('utf8')); } catch { /* image illisible : texte seul */ } b.eyeMs = Date.now() - t0; }
        if (Array.isArray(b.messages)) { injectPersona(b, activePersonaText(db)); if (personaOpts(db).time) injectMemory(b, timeNote(b.messages)); } // le caractère et l'heure valent aussi en mode Test
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
        let kill = null; res.on('close', () => kill?.());
        if (b.eyeMs != null) { // temps passé par l'œil (affiché avec les chronos) et ce qu'il a vu (gardé dans l'historique du mode Test)
          const last = [...(b.messages || [])].reverse().find((m) => m.role === 'user');
          const eyeText = Array.isArray(last?.content) ? last.content.filter((p) => p?.type === 'text' && /^\[Image jointe, décrite par l'œil de PAIZ : /.test(p.text)).map((p) => p.text.replace(/^\[Image jointe, décrite par l'œil de PAIZ : /, '').replace(/\]$/, '')) : [];
          res.write(JSON.stringify({ eyeMs: b.eyeMs, eyeText }) + '\n');
        }
        try { await engineChatStream(db, b, res, (f) => { kill = f; }); } catch (e) { try { res.write(JSON.stringify({ error: e.message }) + '\n'); } catch { /* fermé */ } }
        res.end(); return;
      }
      if (req.method === 'POST' && pathname === '/api/engine/chat') { sendJson(res, 200, await engineChat(db, await readBody(req))); return; }

      if (req.method === 'POST' && pathname === '/api/engine/opencode/launch') { sendJson(res, 200, launchOpencode(db, await readBody(req))); return; }
      // ---- placement : origine, fichiers associés, déplacement précis
      if (req.method === 'GET' && pathname === '/api/engine/links') { sendJson(res, 200, { links: linksForAll(db) }); return; }
      if (req.method === 'GET' && pathname === '/api/engine/move-info') { sendJson(res, 200, moveInfo(db, Number(url.searchParams.get('assetId')))); return; }
      if (req.method === 'POST' && pathname === '/api/engine/move') {
        const b = await readBody(req);
        const r = await moveModel(db, { assetId: Number(b.assetId), toRoot: Number(b.toRoot), companionIds: Array.isArray(b.companionIds) ? b.companionIds : [] });
        sendJson(res, 202, { ...jobSummary(r.job), files: r.files });
        return;
      }
      // ---- configurations de modèles (save conf / load conf)
      if (pathname === '/api/engine/confs') {
        let result = {};
        if (req.method === 'POST') {
          const b = await readBody(req);
          if (b.action === 'save') result.conf = saveConf(db, { name: b.name });
          else if (b.action === 'delete') deleteConf(db, String(b.id));
          else if (b.action === 'update') result.conf = updateConf(db, String(b.id), b.patch || {});
          else if (b.action === 'load') result = await loadConf(db, { id: String(b.id), picks: Array.isArray(b.picks) ? b.picks : [] });
          else throw new Error('Action inconnue.');
        }
        sendJson(res, 200, { ...result, confs: listConfs(db) });
        return;
      }
      // ---- groupes de modèles : ranger / rappeler d'un coup
      if (pathname === '/api/engine/groups') {
        let result = {};
        if (req.method === 'POST') {
          const b = await readBody(req);
          if (b.action === 'create') result.group = createGroup(db, { name: b.name, assetIds: Array.isArray(b.assetIds) ? b.assetIds : [] });
          else if (b.action === 'delete') deleteGroup(db, String(b.id));
          else if (b.action === 'update') result.group = updateGroup(db, String(b.id), b.patch || {});
          else if (b.action === 'park') { const r = await parkGroup(db, { id: String(b.id), toRoot: Number(b.toRoot), allowShared: Array.isArray(b.allowShared) ? b.allowShared : [], leaveLinks: b.leaveLinks === true }); result = { job: jobSummary(r.job), moving: r.moving, skipped: r.skipped }; }
          else if (b.action === 'recall') result = await recallGroup(db, { id: String(b.id), keys: Array.isArray(b.keys) ? b.keys : null });
          else throw new Error('Action inconnue.');
        }
        sendJson(res, 200, { ...result, groups: listGroups(db) });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/hub/search') {
        const p = url.searchParams;
        sendJson(res, 200, { items: await searchModels({ q: p.get('q') || '', sort: p.get('sort') || 'downloads', gguf: p.get('gguf') !== '0', limit: p.get('limit') || 30 }) });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/hub/size') { sendJson(res, 200, await modelSizeRange(url.searchParams.get('id') || '')); return; }
      if (req.method === 'GET' && pathname === '/api/hub/files') {
        const id = url.searchParams.get('id') || '';
        const [files, arch] = await Promise.all([modelFiles(id), repoArch(id)]);
        const machine = machineSpecs(); const moe = isMoe(arch, id);
        sendJson(res, 200, { files: files.map((f) => ({ ...f, fit: /mmproj/i.test(f.name) ? null : estimateFit(f.size, { moe, machine }) })), arch, moe, machine });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/hub/download') {
        const b = await readBody(req);
        const job = startDownload(db, { id: b.id, files: b.files, toRoot: b.toRoot, toDir: b.toDir || null, folder: b.folder || null });
        sendJson(res, 202, jobSummary(job));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/transfer/check') {
        sendJson(res, 200, await checkTransferSpace(db, (url.searchParams.get('assetIds') || '').split(',').filter(Boolean).map(Number), url.searchParams.get('toRoot')));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/shelf') { sendJson(res, 200, { items: listShelf(db), state: shelfState }); return; }
      if (req.method === 'POST' && pathname === '/api/shelf/put') { const b = await readBody(req); await assertTransferSpace(db, [b.assetId], b.toRoot); sendJson(res, 202, { ...shelve(db, b) }); return; }
      if (req.method === 'POST' && pathname === '/api/shelf/restore') { const b = await readBody(req); const it = listShelf(db).find((x) => x.id === b.id); if (it) await assertTransferSpace(db, [it.assetId], it.origin.rootId); sendJson(res, 202, { ...restore(db, b.id) }); return; }

      // ---- entretien : santé, caches, sauvegarde ----------------------------
      if (req.method === 'GET' && pathname === '/api/maintenance/health') { sendJson(res, 200, await diskHealth()); return; }
      if (req.method === 'GET' && pathname === '/api/maintenance/caches') { sendJson(res, 200, { caches: await scanCaches() }); return; }
      if (req.method === 'POST' && pathname === '/api/maintenance/caches/flush') {
        const b = await readBody(req);
        if (b.confirm !== true) throw new Error('Confirmation requise.');
        sendJson(res, 200, await flushCache(db, { targetId: b.targetId, entries: b.entries }));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/maintenance/leftovers') { sendJson(res, 200, { items: await scanLeftovers(db) }); return; }
      if (req.method === 'POST' && pathname === '/api/maintenance/leftovers/remove') {
        const b = await readBody(req);
        if (b.confirm !== true) throw new Error('Confirmation requise.');
        sendJson(res, 200, await removeLeftovers(db, { ids: b.ids, permanent: b.permanent === true }));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/models/recent') { sendJson(res, 200, { recent: recentMap(db) }); return; }
      if (req.method === 'GET' && pathname === '/api/usage/models') { sendJson(res, 200, usageReport(db)); return; }
      if (req.method === 'GET' && pathname === '/api/tools/budget') { sendJson(res, 200, budgetPanel(db, relayStatus().rates?.prefill)); return; }
      if (req.method === 'POST' && pathname === '/api/tools/budget') { const b = await readBody(req); setBudget(db, b); sendJson(res, 200, budgetPanel(db, relayStatus().rates?.prefill)); return; }
      if (req.method === 'GET' && pathname === '/api/quantize/options') {
        const a = getAsset(db, Number(url.searchParams.get('assetId')));
        if (!a) throw new Error('Modèle inconnu.');
        sendJson(res, 200, quantOptions(a)); return;
      }
      if (req.method === 'GET' && pathname === '/api/quantize/status') { sendJson(res, 200, { ...quantState, fresh: freshIds(db) }); return; }
      if (req.method === 'POST' && pathname === '/api/quantize/start') {
        const b = await readBody(req);
        if (b.confirm !== true) throw new Error('Confirmation requise.');
        sendJson(res, 202, await startQuantize(db, Number(b.assetId), String(b.target || ''))); return;
      }
      if (req.method === 'POST' && pathname === '/api/quantize/seen') { const b = await readBody(req); markSeen(db, b.id); sendJson(res, 200, { ok: true }); return; }
      if (req.method === 'GET' && pathname === '/api/engine/extralight') {
        const a = getAsset(db, Number(url.searchParams.get('assetId')));
        if (!a) throw new Error('Modèle inconnu.');
        sendJson(res, 200, variantInfo(db, a)); return;
      }
      if (req.method === 'POST' && pathname === '/api/engine/extralight/build') {
        const b = await readBody(req);
        if (b.confirm !== true) throw new Error('Confirmation requise.');
        const a = getAsset(db, Number(b.assetId));
        if (!a) throw new Error('Modèle inconnu.');
        sendJson(res, 202, await buildVariant(db, a)); return;
      }
      if (req.method === 'GET' && pathname === '/api/maintenance/strays') { sendJson(res, 200, { items: findStrays(engineConfig(db).dir) }); return; }
      if (req.method === 'POST' && pathname === '/api/maintenance/strays/stop') {
        const b = await readBody(req);
        if (b.confirm !== true) throw new Error('Confirmation requise.');
        sendJson(res, 200, { stopped: stopStray(engineConfig(db).dir, b.pid) });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/liberer') { sendJson(res, 200, listLiberables(db)); return; }
      if (req.method === 'POST' && pathname === '/api/jobs/liberate') { const b = await readBody(req); sendJson(res, 202, startLiberateJob(db, { ids: b.ids, permanent: b.permanent === true })); return; }
      if (req.method === 'GET' && pathname === '/api/ecurie') { sendJson(res, 200, ecurieStatus(db)); return; }
      if (req.method === 'POST' && pathname === '/api/ecurie/clean') { const b = await readBody(req); sendJson(res, 200, setCleanRoot(db, Number(b.rootId), b.on !== false)); return; }
      if (req.method === 'GET' && pathname === '/api/ecurie/plan') { const into = Number(url.searchParams.get('into') || url.searchParams.get('rootId')); sendJson(res, 200, planReorg(db, Number(url.searchParams.get('rootId')), { into })); return; }
      if (req.method === 'POST' && pathname === '/api/ecurie/apply') { const b = await readBody(req); if (b.confirm !== true) throw new Error('Confirmation requise.'); sendJson(res, 200, await applyReorg(db, Number(b.rootId), b.ids || null, { into: Number(b.into || b.rootId) })); return; }
      if (req.method === 'POST' && pathname === '/api/ecurie/undo') { const b = await readBody(req); sendJson(res, 200, await undoLast(db, Number(b.rootId))); return; }
      if (req.method === 'POST' && pathname === '/api/ecurie/trace') { const b = await readBody(req); sendJson(res, 200, await writeTrace(db, Number(b.rootId))); return; }
      if (req.method === 'GET' && pathname === '/api/maintenance/backup') { sendJson(res, 200, backup); return; }
      if (req.method === 'POST' && pathname === '/api/maintenance/backup') { const b = await readBody(req); sendJson(res, 202, startBackup(db, { rootId: b.rootId, dest: b.dest })); return; }

      if (req.method === 'GET' && pathname === '/api/engine/opencode/status') {
        sendJson(res, 200, await opencodeStatus(db));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/engine/opencode/connect') {
        sendJson(res, 200, await connectOpencode(db));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/engine/opencode') {
        const st = await engineStatus(db);
        sendJson(res, 200, opencodeConfig(db, st.current ? st.current.path.split(/[\/]/).pop() : 'local'));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, { ok: true, app: APP_NAME, version: APP_VERSION });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        sendJson(res, 200, await buildState(db));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/export') {
        sendJson(res, 200, {
          exportedAt: nowIso(),
          app: APP_NAME,
          version: APP_VERSION,
          roots: listRoots(db),
          assets: allAssets(db).map(mapAsset),
        });
        return;
      }

      // ---- lookup (for other apps: "where is this model?") ----------------
      if (req.method === 'GET' && pathname === '/api/lookup') {
        const term = (url.searchParams.get('name') || url.searchParams.get('q') || '').trim();
        if (!term) { sendJson(res, 400, { error: 'Paramètre name requis' }); return; }
        const category = url.searchParams.get('category');
        const rows = db.prepare(`
          SELECT a.id, a.abs_path, a.file_name, a.title, a.category, a.base_model, a.size_bytes,
                 a.state, a.root_id, r.name AS root_name, r.volume
          FROM assets a LEFT JOIN roots r ON r.id = a.root_id
          WHERE a.state = 'present'
            AND (a.file_name LIKE ? OR a.title LIKE ?)
            ${category ? 'AND a.category = ?' : ''}
          ORDER BY CASE WHEN lower(a.file_name) = lower(?) THEN 0 ELSE 1 END, a.size_bytes DESC
          LIMIT 20
        `).all(...(category ? [`%${term}%`, `%${term}%`, category, term] : [`%${term}%`, `%${term}%`, term]));
        sendJson(res, 200, { query: term, count: rows.length, matches: rows });
        return;
      }

      // ---- assets -------------------------------------------------------
      if (req.method === 'GET' && pathname === '/api/assets') {
        const filters = parseAssetsQuery(url);
        const { items, total, limit, offset } = queryAssets(db, filters);
        sendJson(res, 200, { items: items.map(mapAsset), total, limit, offset });
        return;
      }

      if (pathname === '/api/eye') {
        if (req.method === 'POST') { const b = await readBody(req); setEyeMode(String(b.mode)); setSetting(db, 'eye.mode', String(b.mode)); }
        sendJson(res, 200, await eyeStatus()); return;
      }
      if (req.method === 'GET' && pathname === '/api/models/moe') { sendJson(res, 200, { moe: await moeMap(db) }); return; }
      if (req.method === 'GET' && pathname === '/api/sys') { sendJson(res, 200, await sysStats()); return; }
      if (pathname === '/api/ui') {
        if (req.method === 'POST') { const b = await readBody(req); setSetting(db, 'ui.version', b.version === 'v2' ? 'v2' : 'v1'); }
        sendJson(res, 200, { version: getSetting(db, 'ui.version', 'v1') }); return;
      }
      if (req.method === 'GET' && pathname === '/api/components') { sendJson(res, 200, componentsReport(db)); return; }
      if (req.method === 'POST' && pathname === '/api/components/program') {
        const b = await readBody(req);
        if (!['accepted', 'ignored', 'remove'].includes(b.status) || !b.dir) throw new Error('Demande invalide.');
        setProgram(db, String(b.dir), b.name, b.status); sendJson(res, 200, componentsReport(db)); return;
      }
      if (req.method === 'POST' && pathname === '/api/components/provision') {
        const b = await readBody(req);
        if (b.confirm !== true) throw new Error('Confirmation requise.');
        const rep = componentsReport(db); const out = [];
        for (const it of b.items || []) {
          const c = rep.components.find((x) => x.key === it.key); const pl = c?.places.find((x) => x.target === it.target && x.state === 'missing');
          if (!pl) { out.push({ target: it.target, error: 'emplacement inconnu ou déjà présent' }); continue; }
          try { out.push(provision(db, c.canonical, pl.target)); } catch (e) { out.push({ target: it.target, error: e.message }); }
        }
        sendJson(res, 200, { results: out }); return;
      }
      if (req.method === 'POST' && pathname === '/api/components/restore') {
        const b = await readBody(req);
        if (b.confirm !== true) throw new Error('Confirmation requise.');
        const ok = componentsReport(db).components.some((c) => c.places.some((x) => x.target === b.target));
        if (!ok) throw new Error('Emplacement inconnu.');
        sendJson(res, 200, restoreComponent(db, String(b.target))); return;
      }
      const relMatch = pathname.match(/^\/api\/assets\/(\d+)\/related$/);
      if (req.method === 'GET' && relMatch) { sendJson(res, 200, relatedTo(db, Number(relMatch[1]))); return; }
      if (req.method === 'POST' && pathname === '/api/duplicates/smart') {
        const b = await readBody(req);
        if (b.confirm !== true) throw new Error('Confirmation requise.');
        const job = startSmartMerge(db, { hashes: (b.hashes || []).map(String), keep: b.keep || {}, trash: b.trash === true, loaded: () => currentModel()?.path || null });
        sendJson(res, 202, jobSummary(job)); return;
      }
      if (req.method === 'POST' && pathname === '/api/duplicates/merge') {
        const b = await readBody(req);
        if (b.confirm !== true) throw new Error('Confirmation requise.');
        sendJson(res, 200, await mergeCopies(db, (b.ids || []).map(Number))); return;
      }
      const assetMatch = pathname.match(/^\/api\/assets\/(\d+)$/);
      if (assetMatch) {
        const id = Number(assetMatch[1]);
        if (req.method === 'GET') {
          const asset = getAsset(db, id);
          if (!asset) { sendJson(res, 404, { error: 'Modèle introuvable' }); return; }
          sendJson(res, 200, { ...mapAsset(asset), links: listLinks(db, id) });
          return;
        }
        if (req.method === 'PATCH') {
          const body = await readBody(req);
          const current = getAsset(db, id);
          if (!current) { sendJson(res, 404, { error: 'Modèle introuvable' }); return; }
          const fields = {};
          for (const key of ['title', 'category', 'base_model', 'version', 'notes', 'state']) {
            if (body[key] !== undefined) fields[key] = body[key] === '' ? null : body[key];
          }
          if (fields.base_model !== undefined) fields.base_family = baseFamily(fields.base_model);
          const updated = updateAsset(db, id, fields);
          logEvent(db, 'edit', id, fields);
          sendJson(res, 200, mapAsset(updated));
          return;
        }
        if (req.method === 'DELETE') {
          // Remove from the index only, never from disk.
          db.prepare('DELETE FROM assets WHERE id = ?').run(id);
          logEvent(db, 'forget', id, null);
          sendJson(res, 200, { ok: true });
          return;
        }
      }

      if (req.method === 'GET' && pathname === '/api/duplicates') {
        sendJson(res, 200, { groups: planAll(db, { loaded: currentModel()?.path || null, keep: (() => { try { return JSON.parse(url.searchParams.get('keep') || '{}'); } catch { return {}; } })() }) });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/events') {
        sendJson(res, 200, { events: listEvents(db, Number(url.searchParams.get('limit') || 50)) });
        return;
      }

      // ---- roots --------------------------------------------------------
      if (req.method === 'GET' && pathname === '/api/roots') {
        const roots = [];
        for (const root of listRoots(db)) roots.push(await rootWithSpace(root));
        sendJson(res, 200, { roots });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/roots') {
        const body = await readBody(req);
        if (!body.name || !body.path) { sendJson(res, 400, { error: 'Nom et chemin requis' }); return; }
        const rootPath = normalizeDir(body.path);
        if (!(await pathExists(rootPath))) {
          if (body.create === false) { sendJson(res, 400, { error: `Le dossier n'existe pas: ${rootPath}` }); return; }
          try {
            await fsp.mkdir(rootPath, { recursive: true });
          } catch (err) {
            sendJson(res, 400, { error: `Impossible de créer ${rootPath}: ${err.message}` });
            return;
          }
        }
        const root = addRoot(db, { name: body.name, path: rootPath, role: body.role || 'store', notes: body.notes || null });
        writeMarker(db, root);
        logEvent(db, 'root-add', null, { name: root.name, path: root.path, role: root.role });
        sendJson(res, 201, await rootWithSpace(root));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/roots/find') { sendJson(res, 200, await findRepos(db)); return; }
      if (req.method === 'GET' && pathname === '/api/roots/drives') {
        const out = [];
        for (const v of await listLocalVolumes({ includeRemovable: true }).catch(() => [])) {
          const p = typeof v === 'string' ? v : v.path; try { const st = await fsp.statfs(p); out.push({ path: p, free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) }); } catch { /* disque illisible */ }
        }
        sendJson(res, 200, { drives: out }); return;
      }
      if (req.method === 'GET' && pathname === '/api/setup') { sendJson(res, 200, await setupState(db)); return; }
      if (req.method === 'POST' && pathname === '/api/setup/done') { sendJson(res, 200, markSetupDone(db)); return; }
      if (pathname === '/api/setup/opencode') { sendJson(res, 200, req.method === 'POST' ? installOpencode() : opencodeJob()); return; }
      if (req.method === 'POST' && pathname === '/api/roots/merge') { const b = await readBody(req); if (b.confirm !== true) throw new Error('Confirmation requise.'); sendJson(res, 202, await mergeRoots(db, Number(b.from), Number(b.into))); return; }
      if (req.method === 'POST' && pathname === '/api/roots/standard') {
        // dossier standard, facile à retrouver : X:\PAIZ\Ready (prêts à lancer) ou X:\PAIZ\Reserve (réserve)
        const b = await readBody(req);
        const drive = String(b.drive || '').replace(/[\\/]+$/, ''); if (!/^[A-Za-z]:$/.test(drive)) throw new Error('Choose a disk.');
        const role = b.role === 'active' ? 'active' : 'store';
        const dir = path.join(drive + '\\', 'PAIZ', role === 'active' ? 'Ready' : 'Reserve');
        await fsp.mkdir(dir, { recursive: true });
        let name = `${role === 'active' ? 'Ready' : 'Reserve'} (${drive.toUpperCase()})`; let n = 2;
        while (listRoots(db).some((r) => r.name.toLowerCase() === name.toLowerCase() && r.path.toLowerCase() !== dir.toLowerCase())) name = `${role === 'active' ? 'Ready' : 'Reserve'} (${drive.toUpperCase()}) ${n++}`;
        const root = addRoot(db, { name, path: dir, role }); writeMarker(db, root);
        logEvent(db, 'root-add', null, { name: root.name, path: root.path, role: root.role });
        sendJson(res, 201, await rootWithSpace(root)); return;
      }
      const openMatch = pathname.match(/^\/api\/roots\/(\d+)\/open$/);
      if (req.method === 'POST' && openMatch) {
        const r = getRoot(db, Number(openMatch[1])); if (!r) throw new Error('Unknown folder.');
        if (process.platform === 'win32') spawn('explorer.exe', [r.path], { detached: true, stdio: 'ignore' }).unref();
        sendJson(res, 200, { ok: true }); return;
      }
      const relocMatch = pathname.match(/^\/api\/roots\/(\d+)\/relocate$/);
      if (req.method === 'POST' && relocMatch) { const b = await readBody(req); sendJson(res, 200, relocateRoot(db, Number(relocMatch[1]), String(b.path || ''))); return; }
      const rootMatch = pathname.match(/^\/api\/roots\/(\d+)$/);
      if (rootMatch) {
        const id = Number(rootMatch[1]);
        const root = getRoot(db, id);
        if (!root) { sendJson(res, 404, { error: 'Racine introuvable' }); return; }
        if (req.method === 'PATCH') {
          const body = await readBody(req);
          if (body.name) db.prepare('UPDATE roots SET name = ? WHERE id = ?').run(body.name, id);
          if (body.role) { db.prepare('UPDATE roots SET role = ? WHERE id = ?').run(body.role, id); writeMarker(db, getRoot(db, id)); }
          if (body.notes !== undefined) db.prepare('UPDATE roots SET notes = ? WHERE id = ?').run(body.notes, id);
          sendJson(res, 200, await rootWithSpace(getRoot(db, id)));
          return;
        }
        if (req.method === 'DELETE') {
          db.prepare('UPDATE assets SET managed = 0, root_id = NULL WHERE root_id = ?').run(id);
          removeRoot(db, id);
          logEvent(db, 'root-remove', null, { name: root.name, path: root.path });
          sendJson(res, 200, { ok: true });
          return;
        }
      }

      // ---- jobs ---------------------------------------------------------
      if (req.method === 'GET' && pathname === '/api/jobs') {
        sendJson(res, 200, { jobs: listJobs().map(jobSummary) });
        return;
      }

      const jobMatch = pathname.match(/^\/api\/jobs\/([\w-]+)$/);
      if (jobMatch && req.method === 'GET') {
        const job = getJob(jobMatch[1]);
        if (!job) { sendJson(res, 404, { error: 'Tâche introuvable' }); return; }
        sendJson(res, 200, jobSummary(job));
        return;
      }

      const cancelMatch = pathname.match(/^\/api\/jobs\/([\w-]+)\/cancel$/);
      if (cancelMatch && req.method === 'POST') {
        sendJson(res, 200, { ok: cancelJob(cancelMatch[1]) });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/scan/targets') { sendJson(res, 200, { targets: await listScanTargets({ includeRemovable: true, includeCaches: true }) }); return; }
      if (req.method === 'POST' && pathname === '/api/scan/disks') {
        const body = await readBody(req);
        const opts = {
          only: Array.isArray(body.only) && body.only.length ? body.only.map(String) : null,
          includeRemovable: body.includeRemovable !== false,
          includeCaches: body.includeCaches !== false,
          force: body.force === true,
        };
        if (body.minBytes != null) opts.minBytes = Math.max(Number(body.minBytes) || 0, 1);
        if (body.maxDepth != null) opts.maxDepth = Math.max(Number(body.maxDepth) || 1, 1);
        if (body.paceMs != null) opts.paceMs = Math.max(Number(body.paceMs) || 0, 0);
        const job = startScanAllJob(db, opts);
        sendJson(res, 202, jobSummary(job));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/scan') {
        const body = await readBody(req);
        if (!body.path) { sendJson(res, 400, { error: 'Chemin requis' }); return; }
        const target = normalizeDir(body.path);
        if (!(await pathExists(target))) { sendJson(res, 400, { error: `Chemin introuvable: ${target}` }); return; }
        let rootId = body.rootId ?? null;
        if (body.register) {
          if (!body.register.name) { sendJson(res, 400, { error: 'Nom de racine requis' }); return; }
          const root = addRoot(db, { name: body.register.name, path: target, role: body.register.role || 'store' });
          rootId = root.id;
          logEvent(db, 'root-add', null, { name: root.name, path: root.path, role: root.role });
        }
        const job = startScanJob(db, { dir: target, rootId, maxDepth: body.maxDepth, force: body.force === true });
        sendJson(res, 202, jobSummary(job));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/jobs/transfer') {
        const body = await readBody(req);
        if ((body.mode || 'move') !== 'link') await assertTransferSpace(db, [body.assetId], body.toRootId ?? body.toRoot);
        const job = startTransferJob(db, { assetId: body.assetId, toRoot: body.toRootId ?? body.toRoot, mode: body.mode || 'move', organize: body.organize === true });
        sendJson(res, 202, jobSummary(job));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/jobs/bulk-transfer') {
        const body = await readBody(req);
        await assertTransferSpace(db, (body.assetIds || []).map(Number), body.toRootId ?? body.toRoot);
        const job = startBulkMoveJob(db, { assetIds: (body.assetIds || []).map(Number), toRoot: body.toRootId ?? body.toRoot, mode: body.mode || 'move' });
        sendJson(res, 202, jobSummary(job));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/jobs/link') {
        const body = await readBody(req);
        const job = startLinkJob(db, { assetId: body.assetId, linkPath: body.linkPath, kind: body.kind || 'symlink' });
        sendJson(res, 202, jobSummary(job));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/jobs/trash') {
        const body = await readBody(req);
        const job = startTrashJob(db, { assetIds: (body.assetIds || []).map(Number), permanent: body.permanent === true, keepLast: body.keepLast === true });
        sendJson(res, 202, jobSummary(job));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/jobs/restore') {
        const body = await readBody(req);
        const job = startRestoreJob(db, { assetIds: (body.assetIds || []).map(Number) });
        sendJson(res, 202, jobSummary(job));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/jobs/hash') {
        const body = await readBody(req);
        const ids = body.assetId ? [Number(body.assetId)] : (body.assetIds || []).map(Number);
        const job = startHashJob(db, { assetIds: ids, full: body.full !== false });
        sendJson(res, 202, jobSummary(job));
        return;
      }

      // ---- eviction suggestions ------------------------------------------
      if (req.method === 'GET' && pathname === '/api/suggest') {
        const volume = url.searchParams.get('volume');
        const need = Number(url.searchParams.get('need') || 0);
        const sort = url.searchParams.get('sort') === 'oldest' ? 'seen' : 'size';
        if (!volume) { sendJson(res, 400, { error: 'Volume requis' }); return; }
        const { items } = queryAssets(db, { volume, sort, dir: sort === 'seen' ? 'asc' : 'desc', limit: 300 });
        let cumulative = 0;
        const picked = [];
        for (const item of items) {
          picked.push(mapAsset(item));
          cumulative += item.size_bytes;
          if (need > 0 && cumulative >= need) break;
        }
        sendJson(res, 200, {
          volume,
          need,
          available: items.reduce((s, i) => s + i.size_bytes, 0),
          cumulative,
          count: picked.length,
          items: picked,
        });
        return;
      }

      sendJson(res, 404, { error: `Route inconnue: ${req.method} ${pathname}` });
    } catch (err) {
      sendJson(res, err?.code === 'NO_SPACE' ? 409 : 400, { error: err?.message || String(err), code: err?.code, details: err?.details });
    }
  });
}

export async function startServer({ port = DEFAULT_PORT, open = false, host = '127.0.0.1', autoload = true, quiet = false } = {}) {
  sweepOrphans();
  const db = openDb();
  try { setEyeMode(getSetting(db, 'eye.mode', 'demand')); } catch { /* réglage illisible : à la demande */ } // « live » lance l'œil tout de suite
  try { markAll(db); if (listRoots(db).some((r) => !fs.existsSync(r.path))) findRepos(db).catch(() => {}); } catch { /* sans effet */ } // dossiers déplacés : retrouvés par leur repère
  const server = createServer(db);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  startTasks(db);
  startMemory(db);
  seedWebSearch(db);
  if (autoload) setTimeout(() => { autoloadLast(db).catch((e) => console.log('Chargement auto : ' + (e.message || e))); }, 1500).unref?.();
  const url = `http://${host}:${port}`;
  if (!quiet) {
    console.log(`\n  ${APP_NAME} v${APP_VERSION}`);
    console.log(`  Interface : ${url}`);
    console.log(`  Données   : ${DATA_DIR}\n`);
  }
  if (open) {
    try {
      if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    } catch { /* headless is fine */ }
  }
  return { server, db, url };
}

export function printHelp() {
  console.log(`
${APP_NAME} v${APP_VERSION} — catalogue et échange de modèles IA

Commandes:
  serve [--port 7788] [--no-open]   Lance l'interface web
  serve --headless [--model <nom|id>] [--mode normal|leger|eco|confort|tache|dialogue]
                                    Serveur sans interface pour OpenCode & co : API OpenAI sur http://127.0.0.1:7788/v1
  find-roots                        Retrouve les dossiers de modèles déplacés (repère PAIZ-repo.json)
  init                              Initialise la base locale
  add-root <nom> <chemin> [--role store|active|external]
  roots                             Liste les racines
  rm-root <nom|id>                  Retire une racine (les fichiers restent)
  scan [chemin|nom-racine]          Scanne et indexe les modèles
  list [recherche] [--category] [--base] [--json]
  disks                             Espace libre par disque/racine
  dups                              Groupes de doublons
  move <id> --to <racine> [--copy]  Déplace (ou copie) un modèle
  trash <id...>                     Met à la corbeille (.mdisp-trash)
  restore <id...>                   Restaure depuis la corbeille
  link <id> <chemin> [--hard]       Crée un lien symbolique/physique
  hash <id...> [--quick]            Calcule le SHA-256 complet
  stats                             Statistiques du catalogue
  open                              Ouvre le dossier de données

Données: ${DATA_DIR}
`);
}
