// Placement : origine mémorisée au rangement, retour à l'adresse exacte, repo d'origine disparu, fichiers associés (mmproj, VAE) et « besoins ».
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-place-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const act = path.join(TMP, 'act'); const sto = path.join(TMP, 'sto'); const sto2 = path.join(TMP, 'sto2');
const sub = path.join(act, 'Projet', 'models');
for (const d of [act, sto, sto2, sub]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(sub, 'Nemo-Base-Q4_K_M.gguf'), Buffer.alloc(100000, 1));
fs.writeFileSync(path.join(sub, 'mmproj-Nemo-Base-F16.gguf'), Buffer.alloc(30000, 2));
fs.writeFileSync(path.join(act, 'Solo-Q4_K_M.gguf'), Buffer.alloc(50000, 3));
const { openDb, addRoot, queryAssets } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const { getJob } = await import('../src/jobs.js');
const { moveModel, moveInfo, linksForAll } = await import('../src/placement.js');
const db = openDb();
const rA = addRoot(db, { name: 'act', path: act, role: 'active' });
const rS = addRoot(db, { name: 'sto', path: sto, role: 'store' });
const rS2 = addRoot(db, { name: 'sto2', path: sto2, role: 'store' });
await scanPath(db, { dir: act, rootId: rA.id, maxDepth: 4, minBytes: 1 });
const idOf = (name) => queryAssets(db, { q: name, limit: 20 }).items.find((a) => a.file_name === name).id;
const wait = async (id) => { for (let i = 0; i < 200; i++) { const j = getJob(id); if (j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 100)); } throw new Error('délai'); };

// besoins détectés : le mmproj rangé à côté
const nemo = idOf('Nemo-Base-Q4_K_M.gguf');
let info = moveInfo(db, nemo);
assert.equal(info.needs.length, 1); assert.equal(info.needs[0].where, 'together'); assert.equal(info.needs[0].role, 'mmproj');
assert.equal(moveInfo(db, idOf('Solo-Q4_K_M.gguf')).needs.length, 0);
console.log('  ✔ placement : fichier associé détecté');

// Ranger avec son mmproj
let r = await moveModel(db, { assetId: nemo, toRoot: rS.id, companionIds: [idOf('mmproj-Nemo-Base-F16.gguf')] });
assert.equal(r.files, 2); assert.equal((await wait(r.job.id)).status, 'done');
assert.ok(fs.existsSync(path.join(sto, 'Projet', 'models', 'Nemo-Base-Q4_K_M.gguf')) || fs.existsSync(path.join(sto, 'Nemo-Base-Q4_K_M.gguf')));
info = moveInfo(db, idOf('Nemo-Base-Q4_K_M.gguf'));
assert.equal(info.origin.state, 'ok'); assert.equal(info.origin.rootId, rA.id);
assert.equal(info.origin.path.toLowerCase(), path.join(sub, 'Nemo-Base-Q4_K_M.gguf').toLowerCase());
console.log('  ✔ placement : rangé avec son mmproj, origine mémorisée');

// Invoquer : retour à l'adresse exacte (sous-dossier compris), mmproj avec
r = await moveModel(db, { assetId: idOf('Nemo-Base-Q4_K_M.gguf'), toRoot: rA.id, companionIds: [idOf('mmproj-Nemo-Base-F16.gguf')] });
assert.equal((await wait(r.job.id)).status, 'done');
assert.ok(fs.existsSync(path.join(sub, 'Nemo-Base-Q4_K_M.gguf')), 'retour exactement au même endroit');
assert.ok(fs.existsSync(path.join(sub, 'mmproj-Nemo-Base-F16.gguf')));
assert.equal(moveInfo(db, idOf('Nemo-Base-Q4_K_M.gguf')).origin.state, 'none', 'origine effacée au retour');
console.log('  ✔ placement : retour à l\'adresse exacte avec ses fichiers associés');

// Rangement SANS le mmproj : le lien « a besoin de » est conservé, il est rangé ailleurs
r = await moveModel(db, { assetId: idOf('Nemo-Base-Q4_K_M.gguf'), toRoot: rS2.id, companionIds: [] });
assert.equal(r.files, 1); assert.equal((await wait(r.job.id)).status, 'done');
const n = moveInfo(db, idOf('Nemo-Base-Q4_K_M.gguf')).needs[0];
assert.equal(n.file_name, 'mmproj-Nemo-Base-F16.gguf'); assert.equal(n.where, 'apart'); assert.equal(n.role, 'mmproj');
assert.ok(linksForAll(db)[idOf('Nemo-Base-Q4_K_M.gguf')].needs.length === 1);
console.log('  ✔ placement : séparés, « ce modèle a besoin de mmproj-… » est retenu');

// repo d'origine disparu / plus actif
db.prepare('UPDATE roots SET role = ? WHERE id = ?').run('store', rA.id);
assert.equal(moveInfo(db, idOf('Nemo-Base-Q4_K_M.gguf')).origin.state, 'not-active');
db.prepare('UPDATE roots SET role = ? WHERE id = ?').run('active', rA.id);
fs.renameSync(act, act + '-x');
assert.equal(moveInfo(db, idOf('Nemo-Base-Q4_K_M.gguf')).origin.state, 'gone');
console.log('  ✔ placement : repo d\'origine plus actif / disparu signalé');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou sqlite */ }
process.exit(0);
