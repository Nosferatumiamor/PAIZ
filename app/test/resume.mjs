// Pause / reprise exacte / plantage du moteur / stop, avec un faux moteur qui imite les travaux reprenables de ws_npc_server
// (corps « ws_job », POST /api/jobs/<id>/pause|resume|cancel, GET /api/jobs/<id>, flux gardé ouvert pendant la pause, rattachement
// après coupure avec « ws_skip_chars »). Vérifie que le flux reçu par le client (OpenCode) est identique à un run sans interruption.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-resume-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb, setSetting } = await import('../src/db.js');
const { startServer } = await import('../src/server.js');
const { relayStatus, relayRefresh } = await import('../src/proxy.js');
const db = openDb();

const WORDS = 'Voici une réponse longue découpée en jetons pour tester la pause exacte de la génération, puis la reprise sans doublon ni perte, même après un plantage du moteur.'.split(' ').map((w, i) => `${i ? ' ' : ''}${w}`);
const FULL = WORDS.join('');
const TICK = 25;
const jobs = new Map(); // id -> { n, status, pauseReq, cancelReq, resumeReq, crashAt, attached, reason }
let crashAfter = null; // nombre de jetons après lesquels le prochain flux est coupé (simule un plantage)
let engineUp = true;
const log = [];
const sockets = new Set();

const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    if (!engineUp) { req.socket.destroy(); return; }
    const m = req.url.match(/^\/api\/jobs\/([^/]+)(?:\/(pause|resume|cancel))?$/);
    if (m) {
      const j = jobs.get(m[1]);
      const reply = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method === 'GET') return j ? reply(200, { id: m[1], status: j.status, n_generated: j.n, pausing: j.pauseReq && j.status === 'running', pause_reason: j.reason, last_checkpoint: Math.round(Date.now() / 1000), resume_prefill_s: j.resumePrefill }) : reply(404, { error: { message: 'unknown job' } });
      if (!j) return reply(400, { error: { message: 'unknown job' } });
      log.push(`${m[2]} ${j.status}`);
      if (m[2] === 'pause') { if (j.status === 'running') j.pauseReq = true; return reply(200, { ok: true }); }
      if (m[2] === 'resume') { if (j.status === 'paused') { j.resumeReq = true; return reply(200, { ok: true }); } if (j.pauseReq) { j.pauseReq = false; return reply(200, { ok: true }); } return reply(400, { error: { message: `job is ${j.status}` } }); }
      if (m[2] === 'cancel') { j.cancelReq = true; if (!j.attached) jobs.delete(m[1]); return reply(200, { ok: true }); }
    }
    const j = JSON.parse(b || '{}');
    const id = j.ws_job;
    let job = jobs.get(id);
    if (!job) { job = { n: 0, status: 'running', pauseReq: false, cancelReq: false, resumeReq: false }; jobs.set(id, job); }
    if (job.attached) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'this job is already attached to a running request' } })); return; }
    job.attached = true; job.status = 'running'; job.cancelReq = false;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sockets.add(req.socket);
    let gone = false; res.on('close', () => { gone = true; });
    const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    send({ role: 'assistant' });
    const prior = Buffer.from(WORDS.slice(0, job.n).join('')).subarray(j.ws_skip_chars || 0).toString();
    if (prior) send({ content: prior });
    const t0 = Date.now(); let firstNew = true;
    while (job.n < WORDS.length) {
      if (job.cancelReq) { job.status = 'cancelled'; job.attached = false; jobs.delete(id); res.end(); return; }
      if (gone) { job.status = 'interrupted'; job.attached = false; return; }
      if (job.pauseReq) {
        job.pauseReq = false; job.status = 'paused'; job.reason = 'user'; job.resumeReq = false;
        while (!job.resumeReq && !job.cancelReq && !gone) { res.write(': ws-working\n\n'); await new Promise((r) => setTimeout(r, 100)); }
        if (gone) { job.attached = false; return; }
        job.status = 'running'; job.reason = undefined; job.resumePrefill = 0.5;
      }
      if (crashAfter != null && job.n >= crashAfter) { crashAfter = null; job.status = 'running'; job.attached = false; sockets.forEach((s) => s.destroy()); sockets.clear(); engineUp = false; return; }
      await new Promise((r) => setTimeout(r, TICK));
      send({ content: WORDS[job.n] }); job.n++;
      if (firstNew) { firstNew = false; log.push(`first-token +${Date.now() - t0}ms`); }
    }
    send({}, 'stop'); res.write('data: [DONE]\n\n'); res.end();
    job.status = 'done'; job.attached = false;
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
setSetting(db, 'engine.port', fake.address().port);
const { server } = await startServer({ port: 0, open: false });
const url = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// client « OpenCode » : lit le flux, rassemble le texte, note les erreurs
function client(tag) {
  const out = { text: '', err: null, done: false, events: 0, roles: 0 };
  out.finished = (async () => {
    const r = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: tag }] }) });
    const t = await r.text();
    for (const e of t.split('\n\n')) {
      if (e.startsWith('data: [DONE]')) out.done = true;
      else if (e.startsWith('data: {')) { const d = JSON.parse(e.slice(6)); out.events++; if (d.error) out.err = d.error.message; const dl = d.choices?.[0]?.delta; if (dl?.role) out.roles++; if (typeof dl?.content === 'string') out.text += dl.content; }
    }
  })();
  return out;
}
const post = (p, body = {}) => fetch(`${url}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const state = async () => { await relayRefresh(); return relayStatus().active?.state; };
const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; };

// 1) run sans interruption
let c = client('plain');
await c.finished;
assert.equal(c.text, FULL); assert.ok(c.done && !c.err); assert.equal(c.roles, 1);
console.log('  ✔ run sans interruption : texte complet');

// 2) pause au milieu puis reprise : le flux reste ouvert, aucun doublon, texte identique
jobs.clear();
c = client('pause');
await until(() => jobs.size && [...jobs.values()][0].n >= 6);
assert.equal(relayStatus().active.job, true, 'requête suivie comme travail reprenable');
await post('/api/work/pause', { paused: true });
assert.ok(await until(async () => (await state()) === 'paused'), 'état « en pause » lu depuis le moteur');
const nAtPause = [...jobs.values()][0].n;
await sleep(500);
assert.equal([...jobs.values()][0].n, nAtPause, 'plus aucun jeton produit pendant la pause');
assert.equal(c.text, '', 'le client n a pas reçu de fin (flux gardé ouvert)'); // texte rassemblé seulement à la fin
assert.ok(relayStatus().active.jobN >= nAtPause - 1);
await post('/api/work/pause', { paused: false });
await c.finished;
assert.equal(c.text, FULL, 'texte identique après pause/reprise'); assert.ok(c.done && !c.err); assert.equal(c.roles, 1);
console.log('  ✔ pause / reprise : flux gardé, texte identique, aucune erreur');

// 3) pause puis reprise rapprochées (pause pas encore prise)
jobs.clear();
c = client('flip');
await until(() => jobs.size && [...jobs.values()][0].n >= 3);
await post('/api/work/pause', { paused: true }); await post('/api/work/pause', { paused: false });
await c.finished;
assert.equal(c.text, FULL); assert.ok(c.done && !c.err);
console.log('  ✔ pause annulée aussitôt : aucun blocage');

// 4) plantage du moteur : la connexion d'OpenCode reste ouverte, le relais se rattache au retour du moteur, texte identique
jobs.clear(); engineUp = true; crashAfter = 8;
c = client('crash');
assert.ok(await until(async () => (await state()) === 'interrupted', 8000), 'état « interrompu » visible');
const cut = [...jobs.values()][0].n;
assert.ok(cut >= 8 && cut < WORDS.length);
let ended = false; c.finished.then(() => { ended = true; });
await sleep(800);
assert.equal(ended, false, 'la requête d OpenCode est toujours ouverte pendant la panne');
engineUp = true; // le moteur revient (relancé par « Reprendre »)
await c.finished;
assert.equal(c.text, FULL, 'texte identique après plantage + reprise'); assert.ok(c.done && !c.err); assert.equal(c.roles, 1, 'pas de « role » en double');
console.log('  ✔ plantage du moteur : rattachement automatique, texte identique, une seule réponse pour OpenCode');

// 5) plantage PENDANT une pause : repris en pause
jobs.clear(); engineUp = true; crashAfter = null;
c = client('pause-crash');
await until(() => jobs.size && [...jobs.values()][0].n >= 5);
await post('/api/work/pause', { paused: true });
assert.ok(await until(async () => (await state()) === 'paused'));
engineUp = false; sockets.forEach((s) => s.destroy()); sockets.clear();
assert.ok(await until(async () => (await state()) === 'interrupted', 8000));
engineUp = true;
assert.ok(await until(async () => (await state()) === 'paused', 8000), 'après le plantage le travail est retrouvé en pause');
await post('/api/work/pause', { paused: false });
await c.finished;
assert.equal(c.text, FULL); assert.ok(c.done && !c.err);
console.log('  ✔ plantage pendant une pause : retrouvé en pause, repris exactement');

// 6) stop : le travail est annulé côté moteur et la requête abandonnée
jobs.clear(); engineUp = true;
c = client('stop');
await until(() => jobs.size && [...jobs.values()][0].n >= 4);
await post('/api/work/stop', {});
await c.finished;
assert.ok(!c.done, 'pas de fin normale après stop');
assert.ok(await until(() => jobs.size === 0), 'travail oublié côté moteur');
assert.equal(relayStatus().active, null);
console.log('  ✔ stop : travail annulé côté moteur, requête abandonnée');

// 7) livraison complète : le travail est oublié côté moteur
jobs.clear();
c = client('forget'); await c.finished; await sleep(200);
assert.ok(log.some((l) => l.startsWith('cancel')), 'travail terminé oublié (la même requête rejouée ne recevra pas l ancienne réponse)');
console.log('  ✔ travail terminé oublié côté moteur');

server.closeAllConnections(); fake.closeAllConnections(); server.close(); fake.close();
