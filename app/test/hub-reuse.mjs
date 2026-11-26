// Téléchargement : un fichier déjà au catalogue (même nom, même taille) n'est pas re-téléchargé, il est relié. Hors ligne : aucun accès réseau.
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-reuse-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb, addRoot } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const { getJob } = await import('../src/jobs.js');
const { startDownload } = await import('../src/hub.js');
const db = openDb();
const have = path.join(TMP, 'have'); const store = path.join(TMP, 'store'); fs.mkdirSync(have); fs.mkdirSync(store);
const hdr = Buffer.alloc(24); hdr.write('GGUF', 0); hdr.writeUInt32LE(3, 4);
const body = Buffer.concat([hdr, Buffer.alloc(300000, 5)]);
fs.writeFileSync(path.join(have, 'mmproj-test-F16.gguf'), body);
const r1 = addRoot(db, { name: 'have', path: have, role: 'active' }); addRoot(db, { name: 'store', path: store, role: 'store' });
await scanPath(db, { dir: have, rootId: r1.id, minBytes: 1 });
const realFetch = globalThis.fetch; let calls = 0; globalThis.fetch = async (...a) => { calls++; return realFetch(...a); };
const job = startDownload(db, { id: 'org/modele', files: [{ path: 'mmproj-test-F16.gguf', size: body.length }], toRoot: 'store', folder: 'nouveau' });
let j; for (let i = 0; i < 100; i++) { j = getJob(job.id); if (j.status !== 'running') break; await new Promise((r) => setTimeout(r, 100)); }
assert.equal(j.status, 'done', j.error);
assert.equal(calls, 0, 'aucun téléchargement : le fichier existait déjà');
assert.equal(j.result.reused.length, 1);
assert.ok(fs.readFileSync(path.join(store, 'nouveau', 'mmproj-test-F16.gguf')).equals(body), 'le fichier est bien là, relié');
globalThis.fetch = realFetch;
console.log('  ✔ téléchargement : fichier déjà au catalogue relié, pas re-téléchargé');
