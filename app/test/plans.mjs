// Brouillons, plans rédigés par un modèle, ordre de la file, play / pause / stop, bloc-notes du projet.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-plans-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb, setSetting } = await import('../src/db.js');
const E = await import('../src/engine.js');
const T = await import('../src/tasks.js');
const P = await import('../src/plans.js');
const I = await import('../src/ideas.js');
const db = openDb();

const seen = []; const jobCalls = [];
const srv = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  if (req.url.startsWith('/api/jobs/')) { jobCalls.push(req.url.split('/').pop()); res.end('{}'); return; }
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    const j = JSON.parse(b); seen.push(j.messages[0].content);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const parts = /lent/.test(j.messages[0].content) ? Array.from({ length: 30 }, (_, i) => 'x' + i) : ['Étape ', '1 : ', 'faire.']; let i = 0;
    const tick = setInterval(() => {
      if (i < parts.length) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] })}\n\n`);
      else { clearInterval(tick); res.write(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`); res.end(); }
    }, 100);
    res.on('close', () => clearInterval(tick));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
setSetting(db, 'engine.port', port);
if (E.engineConfig(db).port !== port) { console.log('  (port moteur non réglable : test sauté)'); srv.close(); process.exit(0); }
const wait = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 60)); } throw new Error('délai dépassé'); };
T._setProbe(async () => ({ ramMb: 20000, vramMb: 8000 }));
T.startTasks(db);

// brouillon : ne part jamais seul ; modifiable ; Lancer le met en file
const d1 = T.addTask(db, { title: 'X', spec: 'brouillon x', status: 'draft' });
await new Promise((r) => setTimeout(r, 700));
assert.equal(T.getTask(d1.id).status, 'draft'); assert.equal(seen.length, 0);
T.editTask(db, d1.id, { title: 'X2', spec: 'brouillon x modifié' });
assert.equal(T.getTask(d1.id).title, 'X2'); assert.throws(() => T.editTask(db, d1.id, { spec: ' ' }), /vide/);
const d2 = T.addTask(db, { title: 'Y', spec: 'brouillon y', status: 'draft' });
T.reorderTasks([d2.id, d1.id]);
assert.deepEqual(T.listTasks().map((t) => t.id), [d2.id, d1.id]);
T.launchTasks(db, [d1.id, d2.id]);
await wait(() => T.listTasks().every((t) => t.status === 'done'));
assert.deepEqual(seen, ['brouillon y', 'brouillon x modifié'], 'ordre choisi respecté');
console.log('  ✔ brouillons : jamais lancés seuls, modifiables, ordre, lancement');

// plan : tâche de type « plan » ; à la fin un brouillon apparaît avec le texte du plan
const p = P.createPlan(db, { title: 'Pong', messages: [{ role: 'user', text: 'je veux un pong' }, { role: 'assistant', text: 'ok, en Python ?' }], ideas: [{ title: 'Style Mario Paint', body: 'pixel art' }], notes: 'simple' });
assert.equal(p.kind, 'plan');
await wait(() => T.getTask(p.id).status === 'done');
const done = T.getTask(p.id); assert.ok(done.draftId, 'un brouillon est créé');
const draft = T.getTask(done.draftId); assert.equal(draft.status, 'draft'); assert.equal(draft.spec, 'Étape 1 : faire.'); assert.equal(draft.title, 'Pong');
const prompt = seen.at(-1); assert.match(prompt, /PLAN/); assert.match(prompt, /je veux un pong/); assert.match(prompt, /Mario Paint/); assert.match(prompt, /simple/);
console.log('  ✔ plan : tâche de rédaction, brouillon créé, contexte transmis');

// pause / reprise manuelles, stop
const s = T.addTask(db, { title: 'S', spec: 'tâche lente' });
await wait(() => T.getTask(s.id).status === 'running');
await T.queueControl(db, 'pause'); assert.equal(T.getTask(s.id).status, 'paused'); assert.ok(jobCalls.includes('pause'));
await T.queueControl(db, 'play'); assert.equal(T.getTask(s.id).status, 'running'); assert.ok(jobCalls.includes('resume'));
await T.queueControl(db, 'stop'); assert.equal(T.getTask(s.id).status, 'cancelled');
const n = seen.length; const q = T.addTask(db, { title: 'Q', spec: 'après stop' });
await new Promise((r) => setTimeout(r, 700)); assert.equal(seen.length, n, 'la file reste arrêtée après stop');
await T.queueControl(db, 'play'); await wait(() => T.getTask(q.id).status === 'done');
console.log('  ✔ pilotage : pause / reprise exactes, stop, la file attend play');

// To-do par consigne : le texte du modèle devient un élément du bloc-notes du projet
const nt = P.createNotes(db, { project: 'D:\proj2', instruction: 'note cette idée : pixel art', messages: [{ role: 'user', text: 'pixel art' }], existing: [] });
assert.equal(nt.kind, 'notes'); await wait(() => T.getTask(nt.id).status === 'done');
assert.match(seen.at(-1), /pixel art/); assert.equal(I.listIdeas('D:\proj2').length, 1); assert.equal(I.listIdeas('D:\proj2')[0].body, 'Étape 1 : faire.');
console.log('  ✔ to-do par consigne : tâche de notes, élément ajouté au projet');

// bloc-notes
const a = I.addIdea({ project: 'D:\\proj', title: 'Pixel art', body: 'bouton' }); I.addIdea({ project: 'D:\\autre', title: 'Autre' });
assert.equal(I.listIdeas('d:\\proj\\').length, 1); I.updateIdea(a.id, { body: 'nouveau' }); assert.equal(I.listIdeas('D:\\proj')[0].body, 'nouveau');
I.removeIdea(a.id); assert.equal(I.listIdeas('D:\\proj').length, 0); assert.throws(() => I.addIdea({ project: 'x', title: ' ' }), /vide/);
console.log('  ✔ bloc-notes : ajout, projet, modification, suppression');
srv.close(); process.exit(0);
