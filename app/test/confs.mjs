// Configurations de modèles : sauvegarde des modèles actifs, état (actif / en stock / disparu, repo disparu), mise à jour, rechargement par déplacement.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-confs-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const act = path.join(TMP, 'act'); const act2 = path.join(TMP, 'act2'); const sto = path.join(TMP, 'sto');
for (const d of [act, act2, sto]) fs.mkdirSync(d, { recursive: true });
for (const n of ['Qwen-a-Q4_K_M.gguf', 'Decide-c-Q8_0.gguf']) fs.writeFileSync(path.join(act, n), Buffer.alloc(100000, n.length));
fs.writeFileSync(path.join(act2, 'Gemma-b-Q4_K_M.gguf'), Buffer.alloc(100000, 7));
const { openDb, addRoot, removeRoot, queryAssets } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const { startTransferJob, getJob } = await import('../src/jobs.js');
const { saveConf, listConfs, updateConf, deleteConf, loadConf, itemKey, activeModels } = await import('../src/confs.js');
const db = openDb();
const rA = addRoot(db, { name: 'act', path: act, role: 'active' });
const rA2 = addRoot(db, { name: 'act2', path: act2, role: 'active' });
const rS = addRoot(db, { name: 'sto', path: sto, role: 'store' });
await scanPath(db, { dir: act, rootId: rA.id, maxDepth: 1 });
await scanPath(db, { dir: act2, rootId: rA2.id, maxDepth: 1 });
const wait = async (id) => { for (let i = 0; i < 200; i++) { const j = getJob(id); if (j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 100)); } throw new Error('délai'); };
const idOf = (name) => queryAssets(db, { q: name, limit: 10 }).items.find((a) => a.file_name === name).id;

assert.equal(activeModels(db).length, 3);
const conf = saveConf(db, { name: 'Mon set' });
assert.equal(conf.items.length, 3); assert.equal(conf.name, 'Mon set'); assert.ok(conf.items.filter((i) => i.file_name !== 'Gemma-b-Q4_K_M.gguf').every((i) => i.repo?.name === 'act'));
assert.ok(listConfs(db)[0].state.every((s) => s.status === 'active' && s.repoState === 'ok'));
console.log('  ✔ configurations : sauvegarde des modèles actifs avec leur repo');

// un modèle part en stock, un autre disparaît du disque
const j = await wait(startTransferJob(db, { assetId: idOf('Qwen-a-Q4_K_M.gguf'), toRoot: rS.id, mode: 'move' }).id);
assert.equal(j.status, 'done', j.error);
fs.rmSync(path.join(act, 'Decide-c-Q8_0.gguf'));
let st = listConfs(db)[0].state; const by = (n) => st.find((s) => s.file_name === n);
assert.equal(by('Qwen-a-Q4_K_M.gguf').status, 'stock');
assert.equal(by('Gemma-b-Q4_K_M.gguf').status, 'active');
assert.equal(by('Decide-c-Q8_0.gguf').status, 'missing');
// le repo d'origine est supprimé : à re-indiquer
removeRoot(db, rA.id);
st = listConfs(db)[0].state;
assert.equal(by('Qwen-a-Q4_K_M.gguf').repoState, 'gone');
console.log('  ✔ configurations : états actif / en stock / disparu, repo disparu');

// charger sans repo valide : refusé ; avec un repo actif : déplacé
const K = (n) => itemKey(conf.items.find((i) => i.file_name === n));
const key = K('Qwen-a-Q4_K_M.gguf');
await assert.rejects(loadConf(db, { id: conf.id, picks: [{ key, toRoot: rS.id }] }), /repo actif/);
const r = await loadConf(db, { id: conf.id, picks: [{ key, toRoot: rA2.id }, { key: K('Gemma-b-Q4_K_M.gguf'), toRoot: rA2.id }] });
assert.equal(r.models, 1); assert.equal(r.skipped, 1);
for (let i = 0; i < 100 && !fs.existsSync(path.join(act2, 'Qwen-a-Q4_K_M.gguf')); i++) await new Promise((x) => setTimeout(x, 100));
await new Promise((x) => setTimeout(x, 500));
assert.ok(fs.existsSync(path.join(act2, 'Qwen-a-Q4_K_M.gguf')), 'le modèle en stock est revenu dans le repo actif choisi');
assert.ok(!fs.existsSync(path.join(sto, 'Qwen-a-Q4_K_M.gguf')), 'déplacé, pas copié');
await assert.rejects(loadConf(db, { id: conf.id, picks: [{ key: K('Decide-c-Q8_0.gguf'), toRoot: rA2.id }] }), /disparu/);
console.log('  ✔ configurations : chargement par déplacement vers le repo choisi (jamais de copie), disparus refusés');

// mise à jour : retirer le modèle disparu, re-indiquer le repo
const up = updateConf(db, conf.id, { remove: [K('Decide-c-Q8_0.gguf')], repos: { [key]: rA2.id } });
assert.equal(up.items.length, 2); assert.equal(up.items.find((i) => itemKey(i) === key).repo.name, 'act2');
assert.equal(listConfs(db)[0].state.find((s) => s.key === key).repoState, 'ok');
assert.throws(() => updateConf(db, conf.id, { remove: up.items.map(itemKey) }), /au moins un/);
deleteConf(db, conf.id); assert.equal(listConfs(db).length, 0);
console.log('  ✔ configurations : mise à jour (retrait, nouveau repo) et suppression');
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* base SQLite encore ouverte : le dossier jetable reste dans Temp */ }
process.exit(0);
