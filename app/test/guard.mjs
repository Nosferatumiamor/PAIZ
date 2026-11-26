// Garde-fous du modèle : un vrai OpenCode (serveur jetable) piloté par un faux modèle qui demande une écriture / une commande.
// Les règles viennent de src/guard.js ; on vérifie ce qui est bloqué (dossier protégé, commandes destructrices) et ce qui reste libre.
// Ignoré si OpenCode n'est pas installé.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// ménage des dossiers jetables laissés par une exécution précédente interrompue (fichier encore ouvert) : > 1 h, et reconnaissables à leur contenu
for (const d of fs.readdirSync(os.homedir())) {
  const full = path.join(os.homedir(), d);
  try { if (/^paiz-guard-/.test(d) && fs.existsSync(path.join(full, 'prot')) && Date.now() - fs.statSync(full).mtimeMs > 3600e3) fs.rmSync(full, { recursive: true, force: true }); } catch { /* en cours d'utilisation */ }
}
const TMP = fs.mkdtempSync(path.join(os.homedir(), 'paiz-guard-')); // hors AppData (protégé) et hors dépôt git (sinon le dossier protégé serait « dans le projet »)
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb, setSetting } = await import('../src/db.js');
const { guardRules, assertProjectAllowed } = await import('../src/guard.js');
const { opencodeExe } = await import('../src/engine.js');
const db = openDb();

const work = path.join(TMP, 'work'); const prot = path.join(TMP, 'prot'); const free = path.join(work, 'free');
for (const d of [work, prot, free]) fs.mkdirSync(d, { recursive: true });
setSetting(db, 'work.protected', JSON.stringify([prot]));

// --- sans serveur : projets interdits
assert.throws(() => assertProjectAllowed(db, 'C:\\'), /racine/);
assert.throws(() => assertProjectAllowed(db, os.homedir()), /personnel/);
assert.throws(() => assertProjectAllowed(db, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')), /protégé/);
assert.throws(() => assertProjectAllowed(db, path.join(prot, 'sub')), /protégé/);
assert.doesNotThrow(() => assertProjectAllowed(db, free));
console.log('  ✔ projets interdits (racine de disque, dossier personnel, système, protégé)');

const exe = opencodeExe();
if (!exe) { console.log('  - OpenCode absent : test de blocage ignoré'); process.exit(0); }

let step = { tool: 'write', args: {} };
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    let j = {}; try { j = JSON.parse(b); } catch { /* vide */ }
    const hasTool = (j.messages || []).some((m) => m.role === 'tool');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'local' };
    const send = (o) => res.write(`data: ${JSON.stringify({ ...base, ...o })}\n\n`);
    if (!hasTool) {
      send({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ choices: [{ index: 0, delta: { role: 'assistant', content: 'fini' }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    res.write('data: [DONE]\n\n'); res.end();
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const cfg = { $schema: 'https://opencode.ai/config.json', provider: { paiz: { npm: '@ai-sdk/openai-compatible', name: 'm', options: { baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: { local: { name: 'local', limit: { context: 8192, output: 1024 } } } } }, model: 'paiz/local' };
const conf = path.join(TMP, 'c.json'); fs.writeFileSync(conf, JSON.stringify(cfg));
const dirs = ['data', 'state', 'cache', 'config'].map((d) => { const p = path.join(TMP, d); fs.mkdirSync(p); return p; });
const port = 47000 + Math.floor(Math.random() * 1000);
const proc = spawn(exe, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { env: { ...process.env, OPENCODE_CONFIG: conf, XDG_DATA_HOME: dirs[0], XDG_STATE_HOME: dirs[1], XDG_CACHE_HOME: dirs[2], XDG_CONFIG_HOME: dirs[3] }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; let auth = null;
const onD = (d) => { out += d; const m = out.match(/server password\s+(\S+)/); if (m) auth = `Basic ${Buffer.from(`opencode:${m[1]}`).toString('base64')}`; };
proc.stdout.on('data', onD); proc.stderr.on('data', onD);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (m, p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, t: await r.text() }; };
async function attempt(tool, args) {
  step = { tool, args };
  const s = await call('POST', '/api/session', { location: { directory: work }, title: 't', model: { id: 'local', providerID: 'paiz' }, permissions: guardRules(db) });
  if (s.s !== 200) console.log('SESSION', s.s, s.t.slice(0, 300));
  const id = JSON.parse(s.t).data.id;
  await call('POST', `/api/session/${id}/prompt`, { text: 'go' });
  for (let i = 0; i < 60; i++) { await sleep(500); const a = await call('GET', '/api/session/active'); if (!JSON.parse(a.t).data?.[id]) break; }
  await sleep(300);
}
try {
  for (let i = 0; i < 100 && !auth; i++) await sleep(200);
  assert.ok(auth, `OpenCode n'a pas démarré : ${out.slice(-200)}`);
  for (let i = 0; i < 50; i++) { try { if ((await call('GET', '/api/info')).s === 200) break; } catch { /* pas prêt */ } await sleep(200); }

  const okFile = path.join(free, 'ok.txt');
  await attempt('write', { path: okFile, content: 'x' });
  assert.ok(fs.existsSync(okFile), 'écriture dans le projet : doit passer');

  const badFile = path.join(prot, 'bad.txt');
  await attempt('write', { path: badFile, content: 'x' });
  assert.ok(!fs.existsSync(badFile), 'écriture dans un dossier protégé : doit être refusée');
  console.log('  ✔ écriture : libre dans le projet, refusée dans un dossier protégé');

  const victim = path.join(prot, 'victim.txt'); fs.writeFileSync(victim, 'important');
  await attempt('bash', { command: `del /q "${victim}"`, description: 'x' });
  assert.ok(fs.existsSync(victim), 'del sur un dossier protégé : doit être refusé');
  await attempt('bash', { command: `rm -f "${victim.replace(/\\/g, '/')}"`, description: 'x' });
  assert.ok(fs.existsSync(victim), 'rm sur un dossier protégé : doit être refusé');
  await attempt('bash', { command: 'shutdown /s /t 600', description: 'x' });
  const okShell = path.join(free, 'shell.txt');
  await attempt('bash', { command: `echo hi > "${okShell}"`, description: 'x' });
  assert.ok(fs.existsSync(okShell), 'commande ordinaire dans le projet : doit passer');
  console.log('  ✔ commandes : del/rm sur dossier protégé et shutdown refusés, commande ordinaire libre');

  // un skill activé vit dans le dossier de données (protégé) : sa lecture doit rester permise, le reste du dossier non
  const { SKILLS_ON } = await import('../src/skills.js');
  fs.mkdirSync(path.join(SKILLS_ON, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(SKILLS_ON, 'demo', 'ref.txt'), 'SKILLREF');
  fs.writeFileSync(path.join(process.env.PAIZ_HOME, 'secret.txt'), 'SECRET');
  const readTool = async (file) => {
    step = { tool: 'read', args: { path: file } };
    const s = await call('POST', '/api/session', { location: { directory: work }, title: 't', model: { id: 'local', providerID: 'paiz' }, permissions: guardRules(db) });
    const id = JSON.parse(s.t).data.id;
    await call('POST', `/api/session/${id}/prompt`, { text: 'go' });
    for (let i = 0; i < 60; i++) { await sleep(500); const a = await call('GET', '/api/session/active'); if (!JSON.parse(a.t).data?.[id]) break; }
    return (await call('GET', `/api/session/${id}/message`)).t;
  };
  const okRead = await readTool(path.join(SKILLS_ON, 'demo', 'ref.txt'));
  assert.ok(okRead.includes('SKILLREF'), 'lecture d un skill activé : doit passer');
  const badRead = await readTool(path.join(process.env.PAIZ_HOME, 'secret.txt'));
  assert.ok(!badRead.includes('SECRET'), 'lecture du reste du dossier de données : doit être refusée');
  console.log('  ✔ skills : lisibles dans le dossier de données protégé, le reste reste interdit');
} finally {
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true }); } catch { proc.kill(); } // OpenCode lance des sous-processus qui gardent des fichiers ouverts
  mock.close();
}
await sleep(1500);
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* fichier encore ouvert : le dossier jetable reste dans le dossier personnel */ }
process.exit(0);
