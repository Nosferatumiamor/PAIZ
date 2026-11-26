// Verrou du serveur local : un site web ouvert dans le navigateur ne peut ni lire ni piloter l'API de PAIZ.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-guard-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb } = await import('../src/db.js');
const { createServer } = await import('../src/server.js');
const srv = createServer(openDb());
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const ask = (p, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  });
  r.on('error', reject); r.end(method === 'POST' ? '{}' : undefined);
});

let r = await ask('/api/health');
assert.equal(r.status, 200, 'un programme local (sans Origin) est accepté');
assert.equal(r.headers['access-control-allow-origin'], undefined, 'plus de CORS ouvert sur l’API');
assert.equal((await ask('/api/health', { origin: `http://127.0.0.1:${port}` })).status, 200, 'l’interface de PAIZ est acceptée');
assert.equal((await ask('/api/health', { origin: 'tauri://localhost' })).status, 200, 'la fenêtre Tauri est acceptée');
assert.equal((await ask('/api/health', { origin: 'https://site-malveillant.example' })).status, 403, 'un autre site est refusé');
assert.equal((await ask('/api/jobs/trash', { origin: 'https://site-malveillant.example', 'content-type': 'text/plain' }, 'POST')).status, 403, 'une action venue d’un autre site est refusée');
assert.equal((await ask('/api/health', { 'sec-fetch-site': 'cross-site' })).status, 403, 'requête « cross-site » refusée');
assert.equal((await ask('/api/health', { host: `pirate.example:${port}` })).status, 403, 'hôte inconnu refusé (DNS rebinding)');
assert.equal((await ask('/', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })).status, 200, 'l’écran de démarrage de l’exe peut ouvrir l’interface');
assert.equal((await ask('/nouvelle', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })).status, 200);
assert.equal((await ask('/api/health', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })).status, 403, 'mais pas l’API');
assert.equal((await ask('/oc/session', { origin: 'https://site-malveillant.example' })).status, 403, 'OpenCode non pilotable depuis un autre site');
assert.equal((await ask('/', { origin: 'https://site-malveillant.example' })).status, 403);
r = await ask('/v1/models', { origin: 'https://chat.example' });
assert.notEqual(r.status, 403, '/v1 (discussion) reste ouvert aux interfaces de chat du navigateur');
srv.close();
console.log('  ✔ verrou local : autres sites, faux hôtes et requêtes cross-site refusés ; interface et programmes locaux acceptés');
