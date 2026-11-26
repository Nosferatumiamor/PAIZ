// Composants partagés : détection des dossiers de programmes, liens (dur / symbolique), restauration en vraie copie.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-comp-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb, addRoot } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const C = await import('../src/components.js');
const db = openDb();

const swarm = path.join(TMP, 'SwarmUI', 'Models');
for (const d of ['clip', 'text_encoders', 'vae', 'diffusion_models', 'clip_vision']) fs.mkdirSync(path.join(swarm, d), { recursive: true });
const big = Buffer.alloc(2_000_000, 4);
fs.writeFileSync(path.join(swarm, 'clip', 'qwen_3_4b.safetensors'), big);
fs.writeFileSync(path.join(swarm, 'vae', 'flux2_vae.safetensors'), Buffer.alloc(1_000_000, 6));
fs.writeFileSync(path.join(swarm, 'diffusion_models', 'modele-maitre.safetensors'), Buffer.alloc(1_500_000, 8));
fs.writeFileSync(path.join(swarm, 'clip_vision', 'clip_vision_h.safetensors'), Buffer.alloc(1_100_000, 2));
const root = addRoot(db, { name: 'swarm', path: path.join(TMP, 'SwarmUI'), role: 'active' });
await scanPath(db, { dir: path.join(TMP, 'SwarmUI'), rootId: root.id, minBytes: 1 });

// le dossier du programme est repéré tout seul, et proposé (pas utilisé d'office)
let r = C.componentsReport(db);
assert.equal(r.programs.length, 0);
assert.equal(r.candidates.length, 1); assert.equal(r.candidates[0].name, 'SwarmUI');
assert.ok(r.candidates[0].subs.includes('text_encoders') && r.candidates[0].subs.includes('clip'));
C.setProgram(db, r.candidates[0].dir, 'SwarmUI', 'accepted');
r = C.componentsReport(db); assert.equal(r.candidates.length, 0); assert.equal(r.programs.length, 1);
C.setProgram(db, r.programs[0].dir, 'SwarmUI', 'accepted'); // idempotent

// l'encodeur n'est que dans clip/ : manque dans text_encoders/
const enc = r.components.find((c) => c.file_name === 'qwen_3_4b.safetensors');
assert.ok(enc); assert.equal(enc.kind, 'text-encoder');
const miss = enc.places.find((p) => p.state === 'missing'); assert.equal(miss.sub, 'text_encoders');
assert.equal(enc.places.find((p) => p.sub === 'clip').state, 'real');
assert.ok(!r.components.some((c) => c.file_name === 'modele-maitre.safetensors'), 'un modèle principal n’est pas un composant');

// lien : même disque → lien dur ; rien n'est copié ; jamais d'écrasement
const lk = C.provision(db, enc.canonical, miss.target);
assert.equal(lk.method, 'hardlink'); assert.ok(fs.readFileSync(miss.target).equals(big));
assert.throws(() => C.provision(db, enc.canonical, miss.target), /Déjà présent/);
r = C.componentsReport(db);
assert.equal(r.components.find((c) => c.file_name === 'qwen_3_4b.safetensors').places.find((p) => p.sub === 'text_encoders').state, 'hardlink');

// restauration : vraie copie, l'exemplaire d'origine intact
C.restore(db, miss.target);
assert.ok(fs.readFileSync(miss.target).equals(big)); assert.equal(fs.statSync(miss.target, { bigint: true }).nlink, 1n);
assert.ok(fs.readFileSync(enc.canonical).equals(big));
assert.throws(() => C.restore(db, miss.target), /déjà une vraie copie/);

// lien symbolique (autre disque) : restauration en vraie copie
const vae = r.components.find((c) => c.file_name === 'flux2_vae.safetensors');
assert.equal(vae.kind, 'vae'); assert.equal(vae.places.length, 1);
const other = path.join(TMP, 'ailleurs.safetensors'); fs.writeFileSync(other, Buffer.alloc(1000, 1));
const sl = path.join(swarm, 'vae', 'lien.safetensors'); fs.symlinkSync(other, sl, 'file');
C.restore(db, sl);
assert.equal(fs.lstatSync(sl).isSymbolicLink(), false); assert.equal(fs.statSync(sl).size, 1000); assert.ok(fs.existsSync(other));
console.log('  ✔ composants : détection des programmes, liens, restauration');
