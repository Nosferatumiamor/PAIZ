// Préchauffage du prompt : capture du début de prompt de l'agent, requête de chauffe, exclusions (gros modèle, réglage, rien capturé).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-warm-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const W = await import('../src/warm.js');

const req = { model: 'x', stream: true, stream_options: { include_usage: true }, max_tokens: 4000, ws_job: 'p1', tool_choice: 'auto', chat_template_kwargs: { enable_thinking: false },
  tools: [{ type: 'function', function: { name: 'read', parameters: {} } }], messages: [{ role: 'system', content: 'Consignes' }, { role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'suite' }] };
assert.equal(W.capturePrefix('M1', { ...req, tools: [] }), false, 'sans outils : ignoré (titres, tests)');
assert.equal(W.capturePrefix('M1', { ...req, messages: [{ role: 'user', content: 'x' }] }), false, 'sans consignes : ignoré');
assert.equal(W.capturePrefix('M1', req), true); assert.equal(W.capturePrefix('M1', req), false, 'même début : pas de réécriture');
const e = W.loadPrefix('M1'); const b = W.buildWarmBody(e);
assert.equal(b.max_tokens, 1); assert.equal(b.stream, false); assert.equal(b.tools.length, 1);
assert.deepEqual(b.messages.map((m) => m.role), ['system', 'user'], 'consignes + un message minimal, pas la conversation');
assert.equal(b.ws_job, undefined); assert.equal(b.tool_choice, undefined); assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false }, 'réglages du gabarit gardés');
console.log('  ✔ préchauffage : début de prompt capturé (consignes + outils), requête de chauffe à 1 jeton');

let got = null; let hits = 0;
const srv = http.createServer((q, r) => { let s = ''; q.on('data', (c) => { s += c; }); q.on('end', () => { hits++; got = JSON.parse(s); r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ usage: { prompt_tokens: 1557 }, choices: [] })); }); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
const ok = await W.warmEngine({ port, modelPath: 'M1', sizeBytes: 17e9 });
assert.equal(ok.ok, true); assert.equal(ok.promptTokens, 1557); assert.equal(got.max_tokens, 1);
assert.match((await W.warmEngine({ port, modelPath: 'M1', sizeBytes: 63e9 })).skipped, /gros/, 'très gros modèle : pas de chauffe');
assert.match((await W.warmEngine({ port, modelPath: 'M1', sizeBytes: 17e9, enabled: false })).skipped, /désactivé/);
assert.match((await W.warmEngine({ port, modelPath: 'M2', sizeBytes: 17e9 })).skipped, /aucun début/, 'rien capturé : pas de chauffe');
assert.equal(hits, 1, 'les cas exclus n\'envoient rien au moteur');
srv.close();
const bad = await W.warmEngine({ port: 1, modelPath: 'M1', sizeBytes: 17e9, timeoutMs: 1500 });
assert.equal(bad.ok, false, 'moteur injoignable : échec silencieux, le chargement continue');
console.log('  ✔ préchauffage : gros modèle, réglage coupé, rien capturé et moteur absent sont gérés sans rien envoyer / sans bloquer');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
process.exit(0);
