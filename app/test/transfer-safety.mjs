// Déplacement entre deux DISQUES (C: -> D:) : contrôle de place avant, SHA-256 complet après, source supprimée seulement si tout concorde.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-xfer-'));
const here = path.dirname(fileURLToPath(import.meta.url));
const OTHER = fs.mkdtempSync(path.join(here, '.xfer-'));               // le dépôt est sur D: ; le temporaire sur C: => deux volumes
process.env.PAIZ_HOME = path.join(TMP, 'home');
const a = path.join(TMP, 'a'); const b = path.join(OTHER, 'b');
fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
const file = path.join(a, 'demo.gguf');
const data = Buffer.alloc(6 * 1024 * 1024); for (let i = 0; i < data.length; i += 4096) data[i] = (i / 4096) % 251;
fs.writeFileSync(file, data);
const sha = createHash('sha256').update(data).digest('hex');

const { openDb, addRoot, getAssetByPath, getAsset } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const { startTransferJob, checkTransferSpace, assertTransferSpace, getJob } = await import('../src/jobs.js');
const db = openDb();
const ra = addRoot(db, { name: 'a', path: a, role: 'active' });
const rb = addRoot(db, { name: 'b', path: b, role: 'store' });
await scanPath(db, { dir: a, rootId: ra.id });
const asset = getAssetByPath(db, file);
const volA = path.parse(a).root.toLowerCase(); const volB = path.parse(b).root.toLowerCase();
const wait = async (id) => { for (let i = 0; i < 300; i++) { const j = getJob(id); if (j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 100)); } };

if (volA === volB) { console.log('  (même volume : test inter-disques ignoré)'); fs.rmSync(OTHER, { recursive: true, force: true }); process.exit(0); }

// 1. pas assez de place : refus AVANT toute copie, source intacte
process.env.PAIZ_TEST_FREE = '1000';
const chk = await checkTransferSpace(db, [asset.id], rb.id);
assert.equal(chk.ok, false); assert.match(chk.message, /Pas assez de place/);
await assert.rejects(() => assertTransferSpace(db, [asset.id], rb.id), (e) => e.code === 'NO_SPACE');
const refused = startTransferJob(db, { assetId: asset.id, toRoot: rb.id, mode: 'move' });
const rj = await wait(refused.id);
assert.equal(rj.status, 'error'); assert.match(rj.error, /Espace insuffisant/);
assert.ok(fs.existsSync(file), 'source intacte'); assert.ok(!fs.existsSync(path.join(b, 'demo.gguf')), 'rien copié');
delete process.env.PAIZ_TEST_FREE;

// 2. assez de place : copie, SHA-256 complet relu sur la cible, puis seulement suppression de la source
assert.equal((await checkTransferSpace(db, [asset.id], rb.id)).ok, true);
const job = startTransferJob(db, { assetId: asset.id, toRoot: rb.id, mode: 'move' });
const done = await wait(job.id);
assert.equal(done.status, 'done', done.error);
const dst = path.join(b, 'demo.gguf');
assert.ok(fs.existsSync(dst) && !fs.existsSync(file), 'déplacé, source supprimée');
assert.equal(createHash('sha256').update(fs.readFileSync(dst)).digest('hex'), sha, 'contenu identique');
assert.equal(getAsset(db, asset.id).sha256, sha, 'SHA-256 complet enregistré');
fs.rmSync(OTHER, { recursive: true, force: true });
console.log('  ✔ déplacement inter-disques : place contrôlée avant, SHA-256 vérifié, source supprimée après');
