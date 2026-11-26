// Fusion intelligente des doublons : la copie gardée est celle du dossier « prêts à lancer » le plus actif, les autres copies du
// même disque deviennent des liens durs ; garde-fous : contenu différent jamais touché, copie chargée dans le moteur jamais touchée,
// la corbeille depuis l'écran Doublons n'emporte jamais la dernière copie.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-dsmart-'));
process.env.PAIZ_HOME = path.join(TMP, 'home'); process.env.PAIZ_TRASH = 'folder';
const { openDb, addRoot, duplicateGroups, getAsset } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const { planAll, startSmartMerge, inodeKey } = await import('../src/dedupe.js');
const { getJob, startTrashJob } = await import('../src/jobs.js');
const db = openDb();
const wait = async (job) => { for (;;) { const j = getJob(job.id); if (j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 50)); } };

const ready = path.join(TMP, 'Ready'); const reserve = path.join(TMP, 'Reserve');
fs.mkdirSync(ready); fs.mkdirSync(reserve);
const body = Buffer.alloc(3_000_000, 7);
fs.writeFileSync(path.join(reserve, 'model.safetensors'), body); // la plus ancienne, en réserve
await new Promise((r) => setTimeout(r, 20));
fs.writeFileSync(path.join(ready, 'model.safetensors'), body);
// même taille, même début et même fin (même empreinte rapide) mais milieu différent : PAS un doublon
const bait = Buffer.alloc(3_000_000, 8); const twin = Buffer.from(bait); twin[1_500_000] = 1;
fs.writeFileSync(path.join(reserve, 'piege.safetensors'), bait); fs.writeFileSync(path.join(ready, 'piege.safetensors'), twin);
const rReady = addRoot(db, { name: 'Ready', path: ready, role: 'active' }); const rRes = addRoot(db, { name: 'Reserve', path: reserve, role: 'store' });
await scanPath(db, { dir: ready, rootId: rReady.id, minBytes: 1 }); await scanPath(db, { dir: reserve, rootId: rRes.id, minBytes: 1 });

let plan = planAll(db);
const pm = plan.find((g) => g.items[0].file_name === 'model.safetensors');
assert.ok(pm.keep.abs_path.startsWith(ready), 'la copie gardée est celle du dossier prêt à lancer (pas la plus ancienne)');
assert.match(pm.keepWhy.join(' '), /prêts à lancer/);
assert.equal(pm.actions[0].action, 'link', 'même disque : lien dur');

// garde-fou : copie chargée dans le moteur
plan = planAll(db, { loaded: path.join(reserve, 'model.safetensors') });
assert.ok(plan.find((g) => g.items[0].file_name === 'model.safetensors').keep.abs_path.startsWith(reserve), 'la copie chargée devient celle qu’on garde');

// fusion : le vrai doublon est lié, le faux doublon (contenu différent) n'est pas touché
const hashes = planAll(db).map((g) => g.hash);
const j = await wait(startSmartMerge(db, { hashes }));
assert.equal(j.status, 'done', j.error);
assert.equal(inodeKey(path.join(ready, 'model.safetensors')), inodeKey(path.join(reserve, 'model.safetensors')), 'fusionnées en un seul fichier');
assert.notEqual(inodeKey(path.join(ready, 'piege.safetensors')), inodeKey(path.join(reserve, 'piege.safetensors')), 'contenu différent : rien touché');
assert.ok(j.result.skipped.some((x) => /contenu différent/.test(x.why)));
assert.equal(fs.readFileSync(path.join(ready, 'piege.safetensors'))[1_500_000], 1, 'le fichier différent est intact');

// garde-fou : le moteur charge une copie au moment de la fusion → on n'y touche pas
const c = path.join(reserve, 'autre.safetensors'); const d = path.join(ready, 'autre.safetensors');
fs.writeFileSync(c, Buffer.alloc(2_000_000, 3)); fs.writeFileSync(d, Buffer.alloc(2_000_000, 3));
await scanPath(db, { dir: ready, rootId: rReady.id, minBytes: 1 }); await scanPath(db, { dir: reserve, rootId: rRes.id, minBytes: 1 });
const g2 = planAll(db).find((g) => g.items[0].file_name === 'autre.safetensors');
const j2 = await wait(startSmartMerge(db, { hashes: [g2.hash], keep: { [g2.hash]: g2.items.find((i) => i.abs_path === d).id }, loaded: () => c }));
assert.notEqual(inodeKey(c), inodeKey(d), 'la copie chargée dans le moteur n’est pas remplacée');
assert.ok(j2.result.skipped.some((x) => /moteur/.test(x.why)));

// garde-fou : corbeille depuis l'écran Doublons avec TOUTES les copies cochées → la dernière est épargnée
const ids = duplicateGroups(db).find((g) => g.items[0].file_name === 'autre.safetensors').items.map((i) => i.id);
const j3 = await wait(startTrashJob(db, { assetIds: ids, keepLast: true }));
assert.equal(j3.result.spared.length, 1, 'une copie épargnée');
assert.equal(ids.filter((id) => getAsset(db, id).state === 'present').length, 1, 'il reste une copie');
console.log('  ✔ doublons intelligents : copie gardée bien choisie, liens durs, faux doublon / moteur / dernière copie protégés');
