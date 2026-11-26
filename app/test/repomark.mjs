// Dossiers de modèles déplaçables : repère PAIZ-repo.json, dossier déplacé retrouvé et relocalisé avec ses modèles,
// dossier PAIZ inconnu adopté avec son rôle, copie d'un dossier non touchée.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-repo-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb, addRoot, listRoots, getRoot, queryAssets } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const R = await import('../src/repomark.js');
const db = openDb();

const disk = path.join(TMP, 'disque'); const ready = path.join(disk, 'PAIZ', 'Ready'); fs.mkdirSync(ready, { recursive: true });
const hdr = Buffer.alloc(24); hdr.write('GGUF', 0); hdr.writeUInt32LE(3, 4);
fs.mkdirSync(path.join(ready, 'gemma')); fs.writeFileSync(path.join(ready, 'gemma', 'g-Q4_K_M.gguf'), Buffer.concat([hdr, Buffer.alloc(2000, 1)]));
const root = addRoot(db, { name: 'Ready (X:)', path: ready, role: 'active' });
await scanPath(db, { dir: ready, rootId: root.id, minBytes: 1 });
R.writeMarker(db, root);
const mark = JSON.parse(fs.readFileSync(path.join(ready, R.MARKER), 'utf8'));
assert.equal(mark.paiz, 'repo'); assert.equal(mark.role, 'active'); assert.ok(mark.id);
assert.equal(R.writeMarker(db, getRoot(db, root.id)), mark.id, 'le repère garde le même identifiant');

// le dossier est déplacé (autre nom, autre endroit) : PAIZ le retrouve et met à jour le dossier et ses modèles
const moved = path.join(disk, 'Rangement', 'Mes modeles rapides'); fs.mkdirSync(path.dirname(moved), { recursive: true });
fs.renameSync(ready, moved);
let r = await R.findRepos(db, { tops: [disk] });
assert.equal(r.found.find((x) => x.name === 'Ready (X:)')?.status, 'moved');
assert.equal(path.resolve(getRoot(db, root.id).path), path.resolve(moved));
const a = queryAssets(db, { limit: 10 }).items.find((x) => x.file_name === 'g-Q4_K_M.gguf');
assert.equal(path.resolve(a.abs_path), path.resolve(moved, 'gemma', 'g-Q4_K_M.gguf'), 'les modèles suivent leur dossier');
assert.ok(fs.existsSync(a.abs_path));
r = await R.findRepos(db, { tops: [disk] });
assert.equal(r.found[0].status, 'in-place', 'une seconde recherche ne change rien');

// un dossier PAIZ venu d'ailleurs (autre machine, base réinstallée) : adopté avec son rôle
const other = path.join(disk, 'PAIZ', 'Reserve'); fs.mkdirSync(other, { recursive: true });
fs.writeFileSync(path.join(other, R.MARKER), JSON.stringify({ paiz: 'repo', id: 'abc-123', role: 'store', name: 'Reserve (Y:)' }));
r = await R.findRepos(db, { tops: [disk] });
assert.equal(r.found.find((x) => x.path === other)?.status, 'added');
assert.equal(listRoots(db).find((x) => x.name === 'Reserve (Y:)')?.role, 'store');

// une copie du dossier (l'original est toujours là) : on ne touche à rien
const copy = path.join(disk, 'Copie'); fs.cpSync(moved, copy, { recursive: true });
r = await R.findRepos(db, { tops: [disk] });
assert.equal(r.found.find((x) => x.path === copy)?.status, 'copy');
assert.equal(path.resolve(getRoot(db, root.id).path), path.resolve(moved), 'l’original reste la référence');
console.log('  ✔ dossiers de modèles : repère, dossier déplacé retrouvé avec ses modèles, dossier inconnu adopté, copie ignorée');
