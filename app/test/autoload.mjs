// Chargement auto : réglage persistant, désactivé par défaut, aucun lancement si rien à charger.
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.PAIZ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-al-'));
const { openDb } = await import('../src/db.js');
const { getEngineSettings, setEngineSettings, autoloadLast } = await import('../src/engine.js');
const db = openDb();
assert.equal(getEngineSettings(db).autoload, false);
assert.deepEqual(await autoloadLast(db), { skipped: 'désactivé' });
assert.equal(setEngineSettings(db, { autoload: true }).autoload, true);
assert.match((await autoloadLast(db)).skipped, /introuvable/);
assert.equal(setEngineSettings(db, { autoload: false }).autoload, false);
console.log('autoload : OK');
