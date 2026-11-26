// Groupes de modèles : ranger tout un groupe d'un coup, le rappeler d'un coup, chaque modèle à son adresse exacte (repos différents),
// modèle peut-être partagé (autre groupe) non rangé sans accord, repo d'origine disparu signalé, suppression refusée tant que rangé.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-groups-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const a1 = path.join(TMP, 'act1'); const a2 = path.join(TMP, 'act2'); const st = path.join(TMP, 'stock'); const sub = path.join(a1, 'Projet', 'm');
for (const d of [a1, a2, st, sub]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(sub, 'Gemma-Q4_K_M.gguf'), Buffer.alloc(100000, 1));
fs.writeFileSync(path.join(sub, 'mmproj-Gemma-Q4_F16.gguf'), Buffer.alloc(20000, 2));
fs.writeFileSync(path.join(a2, 'Decide-Q4_K_M.gguf'), Buffer.alloc(60000, 3));
fs.writeFileSync(path.join(a2, 'Commun-Q4_K_M.gguf'), Buffer.alloc(40000, 4));
const { openDb, addRoot, queryAssets } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const { getJob } = await import('../src/jobs.js');
const { createGroup, listGroups, parkGroup, recallGroup, deleteGroup } = await import('../src/groups.js');
const db = openDb();
const r1 = addRoot(db, { name: 'act1', path: a1, role: 'active' });
const r2 = addRoot(db, { name: 'act2', path: a2, role: 'active' });
const rs = addRoot(db, { name: 'stock', path: st, role: 'store' });
await scanPath(db, { dir: a1, rootId: r1.id, maxDepth: 5, minBytes: 1 });
await scanPath(db, { dir: a2, rootId: r2.id, maxDepth: 5, minBytes: 1 });
const idOf = (n) => queryAssets(db, { q: n, limit: 20 }).items.find((a) => a.file_name === n).id;
const waitJob = async (id) => { for (let i = 0; i < 300; i++) { const j = getJob(id); if (j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 100)); } throw new Error('délai'); };
const until = async (fn) => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('délai'); };
const at = (...p) => path.join(...p);

// groupe « Projet » : modèle + mmproj (repo 1), modèle d'un AUTRE repo (repo 2) ; le mmproj suit tout seul
const g = createGroup(db, { name: 'Projet', assetIds: [idOf('Gemma-Q4_K_M.gguf'), idOf('Decide-Q4_K_M.gguf')] });
assert.equal(g.items.length, 3, 'le mmproj est ajouté avec son modèle');
console.log('  ✔ groupe créé avec ses fichiers associés');

// Rangement d'un coup, depuis deux repos différents
let r = await parkGroup(db, { id: g.id, toRoot: rs.id });
assert.equal(r.moving, 3);
assert.ok(listGroups(db).find((x) => x.id === g.id).parked, 'lister PENDANT le déplacement ne doit pas effacer les adresses notées');
assert.equal((await waitJob(r.job.id)).status, 'done');
assert.ok(!fs.existsSync(at(sub, 'Gemma-Q4_K_M.gguf')) && !fs.existsSync(at(a2, 'Decide-Q4_K_M.gguf')));
let gs = listGroups(db).find((x) => x.id === g.id);
assert.ok(gs.parked && gs.state.every((s) => s.state === 'parked'));
console.log('  ✔ rangé d\'un coup depuis deux repos');

// Suppression refusée tant que rangé
assert.throws(() => deleteGroup(db, g.id), /rangé/);

// Rappel d'un coup : chacun à son adresse exacte (sous-dossier compris), dans son propre repo
r = await recallGroup(db, { id: g.id });
assert.equal(r.models, 3); assert.equal(r.repos, 2); assert.equal(r.problems.length, 0);
await until(() => fs.existsSync(at(sub, 'Gemma-Q4_K_M.gguf')) && fs.existsSync(at(a2, 'Decide-Q4_K_M.gguf')) && fs.existsSync(at(sub, 'mmproj-Gemma-Q4_F16.gguf')));
await until(() => !listGroups(db).find((x) => x.id === g.id).parked);
assert.equal(fs.statSync(at(sub, 'Gemma-Q4_K_M.gguf')).size, 100000);
console.log('  ✔ rappelé d\'un coup, chacun à son adresse exacte, note « rangé » effacée');

// Modèle peut-être partagé : aussi dans un autre groupe -> pas rangé sans accord explicite
const g2 = createGroup(db, { name: 'Code', assetIds: [idOf('Commun-Q4_K_M.gguf')] });
const g3 = createGroup(db, { name: 'Jeu', assetIds: [idOf('Commun-Q4_K_M.gguf'), idOf('Decide-Q4_K_M.gguf')] });
await assert.rejects(parkGroup(db, { id: g2.id, toRoot: rs.id }), /partagé/);
await assert.rejects(parkGroup(db, { id: g3.id, toRoot: rs.id }), /partagé/); // Commun et Decide sont chacun dans un autre groupe
assert.ok(fs.existsSync(at(a2, 'Decide-Q4_K_M.gguf')) && fs.existsSync(at(a2, 'Commun-Q4_K_M.gguf')), 'rien n\'a bougé');
console.log('  ✔ modèle partagé non rangé sans accord');
r = await parkGroup(db, { id: g2.id, toRoot: rs.id, allowShared: [listGroups(db).find((x) => x.id === g2.id).state[0].key] });
assert.equal(r.moving, 1); assert.equal((await waitJob(r.job.id)).status, 'done');
assert.ok(!fs.existsSync(at(a2, 'Commun-Q4_K_M.gguf')));
console.log('  ✔ modèle partagé rangé avec accord explicite');

// repo d'origine disparu : signalé, le modèle reste en stock
fs.renameSync(a2, a2 + '-x');
await assert.rejects(recallGroup(db, { id: g2.id }), /n'existe plus/);
fs.renameSync(a2 + '-x', a2);
r = await recallGroup(db, { id: g2.id }); assert.equal(r.models, 1);
await until(() => fs.existsSync(at(a2, 'Commun-Q4_K_M.gguf')));
console.log('  ✔ repo d\'origine disparu signalé, puis rappel quand il revient');

// lien laissé à l'ancien emplacement (si Windows autorise les liens symboliques)
const g4 = createGroup(db, { name: 'Lien', assetIds: [idOf('Decide-Q4_K_M.gguf')] });
r = await parkGroup(db, { id: g4.id, toRoot: rs.id, allowShared: [listGroups(db).find((x) => x.id === g4.id).state[0].key], leaveLinks: true });
await waitJob(r.job.id); await new Promise((x) => setTimeout(x, 800));
const linked = fs.existsSync(at(a2, 'Decide-Q4_K_M.gguf')) && fs.lstatSync(at(a2, 'Decide-Q4_K_M.gguf')).isSymbolicLink();
r = await recallGroup(db, { id: g4.id });
await until(() => fs.existsSync(at(a2, 'Decide-Q4_K_M.gguf')) && !fs.lstatSync(at(a2, 'Decide-Q4_K_M.gguf')).isSymbolicLink());
assert.equal(fs.statSync(at(a2, 'Decide-Q4_K_M.gguf')).size, 60000);
console.log(`  ✔ lien laissé (${linked ? 'créé' : 'non permis par Windows ici, ignoré'}) puis retiré au rappel, fichier revenu`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou sqlite */ }
process.exit(0);
