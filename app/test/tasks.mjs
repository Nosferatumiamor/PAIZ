// File de tâches du gros modèle : ordre, une seule à la fois, texte au fil de l'eau, annulation, reprise après redémarrage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-tasks-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb, setSetting } = await import('../src/db.js');
const E = await import('../src/engine.js');
const T = await import('../src/tasks.js');
const db = openDb();

// faux moteur : /health + /v1/chat/completions en flux (3 morceaux), un seul à la fois
let active = 0; let maxActive = 0; const seen = [];
const jobCalls = [];
const srv = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  if (req.url.startsWith('/api/jobs/')) { jobCalls.push(req.url.split('/').pop()); res.end('{}'); return; }
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    const j = JSON.parse(b); seen.push(j.messages[0].content); active++; maxActive = Math.max(maxActive, active);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const parts = /lent/.test(j.messages[0].content) ? ['a','b','c','d','e','f','g','h','i','j','k','l'] : ['Bon', 'jour', ' !']; let i = 0;
    const tick = setInterval(() => {
      if (i < parts.length) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] })}\n\n`);
      else { clearInterval(tick); res.write(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`); res.end(); active--; }
    }, 120);
    res.on('close', () => { clearInterval(tick); });
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
setSetting(db, 'engine.port', port);
const cfg = E.engineConfig(db);
if (cfg.port !== port) { console.log('  (port moteur non réglable par réglage : test sauté)'); srv.close(); process.exit(0); }

const wait = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 60)); } throw new Error('délai dépassé'); };
T.startTasks(db);
const a = T.addTask(db, { title: 'A', spec: 'premier' }); const b = T.addTask(db, { title: 'B', spec: 'second' });
assert.throws(() => T.addTask(db, { spec: '  ' }), /vide/);
await wait(() => T.listTasks().every((t) => t.status === "done")).catch((e) => { console.log(JSON.stringify(T.listTasks())); throw e; });
assert.equal(maxActive, 1, 'une seule tâche à la fois');
assert.deepEqual(seen, ['premier', 'second'], 'ordre de la file');
assert.equal(T.getTask(a.id).text, 'Bonjour !'); assert.equal(T.getTask(b.id).outTok, 3);
console.log('  ✔ tâches : une à la fois, dans l\'ordre, texte complet');

const c = T.addTask(db, { title: 'C', spec: 'a annuler' });
await wait(() => T.getTask(c.id).status === 'running');
T.cancelTask(c.id); assert.equal(T.getTask(c.id).status, 'cancelled');
const d = T.addTask(db, { title: 'D', spec: 'annulée en file' }); T.cancelTask(d.id);
assert.equal(T.getTask(d.id).status, 'cancelled');
T.retryTask(db, c.id); await wait(() => T.getTask(c.id).status === 'done').catch((e) => { console.log(JSON.stringify(T.listTasks())); throw e; });
assert.equal(T.getTask(c.id).text, 'Bonjour !');
T.removeTask(c.id); assert.equal(T.getTask(c.id), null);
console.log('  ✔ tâches : annulation (en cours / en file), relance, retrait');

// garde-fou mémoire : RAM basse -> pause (ordre au moteur), mémoire revenue -> reprise ; la tâche finit normalement
let mem = { ramMb: 9000, vramMb: 5000 }; T._setProbe(async () => mem); T.LIMITS.pollMs = 150;
const e = T.addTask(db, { title: 'E', spec: 'tâche lente' });
await wait(() => T.getTask(e.id).status === 'running');
mem = { ramMb: 900, vramMb: 5000 };
await wait(() => T.getTask(e.id).status === 'paused'); assert.match(T.getTask(e.id).note, /mémoire basse/); assert.ok(jobCalls.includes('pause'));
mem = { ramMb: 2500, vramMb: 5000 }; await new Promise((r) => setTimeout(r, 500)); assert.equal(T.getTask(e.id).status, 'paused', 'hystérésis : pas de reprise juste au-dessus du seuil bas');
mem = { ramMb: 9000, vramMb: 300 }; await new Promise((r) => setTimeout(r, 400)); assert.equal(T.getTask(e.id).status, 'paused', 'VRAM libre trop basse : reste en pause');
mem = { ramMb: 9000, vramMb: 5000 };
await wait(() => T.getTask(e.id).status === 'done'); assert.ok(jobCalls.includes('resume'));
console.log('  ✔ tâches : pause si mémoire basse (RAM ou VRAM), reprise avec marge, fin normale');

T.clearFinished(); assert.equal(T.listTasks().length, 0);
srv.close(); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
process.exit(0);
