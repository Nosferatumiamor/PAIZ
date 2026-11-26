// Téléchargement depuis Hugging Face d'un fichier minuscule (1,2 Mo), vérifié par le SHA-256 publié. Ignoré hors ligne.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-hub-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const store = path.join(TMP, 'store'); fs.mkdirSync(store);
const { openDb, addRoot } = await import('../src/db.js');
const { getJob } = await import('../src/jobs.js');
const { modelFiles, startDownload, searchModels } = await import('../src/hub.js');
const db = openDb();
addRoot(db, { name: 'store', path: store, role: 'store' });

let files;
try { files = await modelFiles('ggml-org/tiny-llamas'); } catch (e) { console.log(`  (hors ligne ou API indisponible : test ignoré — ${e.message})`); process.exit(0); }
const g = files.find((x) => x.name === 'stories260K.gguf');
assert.ok(g && g.parts[0].sha256, 'fichier et SHA-256 publiés');
const f = g.parts[0];
const found = await searchModels({ q: 'tiny-llamas', limit: 5 });
assert.ok(Array.isArray(found));

const job = startDownload(db, { id: 'ggml-org/tiny-llamas', files: g.parts, toRoot: 'store', folder: 'hub-test' });
let j; for (let i = 0; i < 300; i++) { j = getJob(job.id); if (j.status !== 'running') break; await new Promise((r) => setTimeout(r, 100)); }
assert.equal(j.status, 'done', j.error);
assert.equal(j.result.verified, true);
assert.equal(j.result.files.length, 1);
assert.equal(fs.statSync(path.join(store, 'hub-test', 'stories260K.gguf')).size, f.size);
assert.ok(!fs.existsSync(path.join(store, 'hub-test', 'stories260K.gguf.part')), 'pas de .part restant');
console.log('  ✔ téléchargement Hugging Face : taille + SHA-256 vérifiés, fichier catalogué');

// destination « ailleurs » / projet actif : dossier au choix (hors écurie, non catalogué), sous-dossier cantonné, lieux interdits refusés
const other = fs.mkdtempSync(path.join(os.homedir(), 'paiz-hub-other-')); // hors AppData (dossier protégé)
const job2 = startDownload(db, { id: 'ggml-org/tiny-llamas', files: g.parts, toDir: other, folder: '..' });
let j2; for (let i = 0; i < 300; i++) { j2 = getJob(job2.id); if (j2.status !== 'running') break; await new Promise((r) => setTimeout(r, 100)); }
assert.equal(j2.status, 'done', j2.error);
assert.ok(fs.existsSync(path.join(other, 'stories260K.gguf')), 'un sous-dossier « .. » ne sort pas de la destination');
assert.throws(() => startDownload(db, { id: 'ggml-org/tiny-llamas', files: g.parts, toDir: os.homedir(), folder: 'x' }), /personnel/);
assert.throws(() => startDownload(db, { id: 'ggml-org/tiny-llamas', files: g.parts, toDir: 'C:\\', folder: 'x' }), /racine/);
console.log('  ✔ téléchargement vers un dossier au choix (hors écurie), lieux interdits refusés');
fs.rmSync(other, { recursive: true, force: true });
