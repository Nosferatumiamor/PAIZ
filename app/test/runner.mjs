// Bouton « ▶ Lancer » : seuls les scripts d'un projet connu se lancent ; erreurs renvoyées ; arrêt possible.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.homedir(), '.paiz-runner-test-'));
process.env.PAIZ_HOME = path.join(HOME, 'data');
const proj = path.join(HOME, 'projet'); const other = path.join(HOME, 'ailleurs');
fs.mkdirSync(proj, { recursive: true }); fs.mkdirSync(other, { recursive: true });
fs.writeFileSync(path.join(proj, 'long.js'), 'setInterval(() => {}, 1000); console.log("go");');
fs.writeFileSync(path.join(proj, 'court.js'), 'console.log("fini");');
fs.writeFileSync(path.join(proj, 'casse.js'), 'throw new Error("boum");');
fs.writeFileSync(path.join(proj, 'notes.txt'), 'x');
fs.writeFileSync(path.join(proj, 'jeu.py'), 'import module_qui_nexiste_pas_paiz\n');
fs.writeFileSync(path.join(other, 'hors.js'), 'console.log(1)');
const { openDb } = await import('../src/db.js');
const { saveProjects } = await import('../src/projects.js');
const { runScript, stopScript, runningFiles, isRunnable } = await import('../src/runner.js');
const db = openDb(); saveProjects(db, { projects: [proj] });

assert.ok(isRunnable('a.py') && isRunnable('b.mjs') && !isRunnable('c.exe') && !isRunnable('d.bat'));
await assert.rejects(runScript(db, { file: path.join(other, 'hors.js') }), /aucun projet connu/);
await assert.rejects(runScript(db, { file: path.join(proj, 'notes.txt') }), /Seuls les scripts/);
await assert.rejects(runScript(db, { file: path.join(proj, 'absent.js') }), /introuvable/);
console.log('  ✔ lanceur : hors projet, mauvaise extension et fichier absent refusés');

const quick = await runScript(db, { file: 'court.js', dir: proj });
assert.equal(quick.exited, true); assert.equal(quick.code, 0); assert.match(quick.output, /fini/);
const bad = await runScript(db, { file: path.join(proj, 'casse.js') });
assert.equal(bad.exited, true); assert.notEqual(bad.code, 0); assert.match(bad.output, /boum/);
const py = await runScript(db, { file: path.join(proj, 'jeu.py') });
assert.equal(py.exited, true); assert.match(py.hint || '', /Module Python manquant : module_qui_nexiste_pas_paiz/);
console.log('  ✔ lanceur : fin rapide, erreur et module Python manquant renvoyés avec la sortie');

const live = await runScript(db, { file: path.join(proj, 'long.js') });
assert.equal(live.running, true); assert.ok(live.pid);
assert.equal(runningFiles().length, 1);
await assert.rejects(runScript(db, { file: path.join(proj, 'long.js') }), /tourne déjà/);
assert.equal(stopScript(path.join(proj, 'long.js')).stopped, true);
await new Promise((r) => setTimeout(r, 600));
assert.equal(runningFiles().length, 0);
console.log('  ✔ lanceur : programme long lancé, une seule instance, arrêt');
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* verrou sqlite */ }
process.exit(0);
