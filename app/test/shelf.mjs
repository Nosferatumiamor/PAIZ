// Test de l'étagère : ranger puis restaurer un faux modèle (dossiers temporaires, jamais de vrais modèles).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-shelf-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const hot = path.join(TMP, 'hot'); const cold = path.join(TMP, 'cold'); const appdir = path.join(TMP, 'app');
for (const d of [hot, cold, appdir]) fs.mkdirSync(d, { recursive: true });
const file = path.join(hot, 'demo-Q4_K_M.gguf');
fs.writeFileSync(file, Buffer.alloc(300000, 7));
const link = path.join(appdir, 'model.gguf');
let canLink = true;
try { fs.symlinkSync(file, link, 'file'); } catch { canLink = false; }

const { openDb, addRoot, getAssetByPath, addLink } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const { shelve, restore, listShelf, shelfState } = await import('../src/shelf.js');
const db = openDb();
const rh = addRoot(db, { name: 'hot', path: hot, role: 'active' });
const rc = addRoot(db, { name: 'cold', path: cold, role: 'store' });
await scanPath(db, { dir: hot, rootId: rh.id });
const a = getAssetByPath(db, file);
assert.ok(a, 'asset catalogué');
if (canLink) addLink(db, a.id, link, 'symlink');
const wait = async () => { for (let i = 0; i < 100 && !['done', 'error'].includes(shelfState.step); i++) await new Promise((r) => setTimeout(r, 100)); };

shelve(db, { assetId: a.id, toRoot: rc.id, leaveLink: true }); await wait();
assert.equal(shelfState.step, 'done', shelfState.error);
assert.ok(fs.existsSync(path.join(cold, 'demo-Q4_K_M.gguf')), 'fichier à froid');
const items = listShelf(db);
assert.equal(items.length, 1);
assert.equal(items[0].origin.path, file);
if (canLink) {
  assert.ok(fs.lstatSync(file).isSymbolicLink(), 'lien laissé à l\'ancien emplacement');
  assert.equal(fs.readFileSync(link).length, 300000, 'le lien d\'appli lit toujours le fichier');
}

restore(db, items[0].id); await wait();
assert.equal(shelfState.step, 'done', shelfState.error);
assert.ok(fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink(), 'fichier revenu, vrai fichier');
assert.equal(listShelf(db).length, 0);
if (canLink) assert.equal(fs.readFileSync(link).length, 300000, 'lien d\'appli rétabli');
console.log(`  ✔ étagère OK (liens symboliques : ${canLink ? 'testés' : 'non disponibles ici'})`);
