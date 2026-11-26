// Test du chat en flux (mode Test de Travail) : un faux moteur compatible OpenAI envoie des morceaux, PAIZ les relaie avec les durées.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-cs-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb } = await import('../src/db.js');
const { setEngineSettings, engineChatStream } = await import('../src/engine.js');
const db = openDb();

const fake = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  setTimeout(() => send({ choices: [{ delta: { content: 'Bon' } }] }), 150);
  setTimeout(() => send({ choices: [{ delta: { content: 'jour' } }] }), 250);
  setTimeout(() => { send({ choices: [], usage: { completion_tokens: 2, prompt_tokens: 9 }, timings: { predicted_ms: 100 } }); res.write('data: [DONE]\n\n'); res.end(); }, 320);
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
setEngineSettings(db, { port: fake.address().port });

const lines = [];
await engineChatStream(db, { messages: [{ role: 'user', content: 'salut' }] }, { write: (l) => lines.push(JSON.parse(l)) });
const deltas = lines.filter((l) => l.delta).map((l) => l.delta);
const fin = lines.at(-1);
assert.deepEqual(deltas, ['Bon', 'jour']);
assert.equal(fin.done, true); assert.equal(fin.text, 'Bonjour'); assert.equal(fin.tokens, 2); assert.equal(fin.promptTokens, 9);
assert.ok(fin.readMs >= 100, 'durée de lecture mesurée'); assert.ok(fin.writeMs > 0 && fin.ms >= fin.readMs + fin.writeMs - 5);
assert.equal(fin.tps, 20);
console.log('  ✔ chat en flux : morceaux relayés, durées lecture / écriture, jetons par seconde');
fake.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou sqlite */ }
process.exit(0);
