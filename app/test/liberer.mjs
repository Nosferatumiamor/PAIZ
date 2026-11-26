// Libérer : une copie active déjà rangée à l'identique en stockage est retirée seulement après vérification complète ; l'adresse exacte est retenue pour « Invoquer ».
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-liberer-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const act = path.join(TMP, 'swarm'); const sto = path.join(TMP, 'stock');
for (const d of [path.join(act, 'Lora', 'styles'), path.join(sto, 'LoRA')]) fs.mkdirSync(d, { recursive: true });
const rnd = (n, seed) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 17 + (i >> 8)) & 255; return b; };
const A = rnd(200000, 1); const B = rnd(210000, 2); const C = rnd(220000, 3);
fs.writeFileSync(path.join(act, 'Lora', 'styles', 'alpha_lora.safetensors'), A);   // copie identique en stock -> libérable
fs.writeFileSync(path.join(sto, 'LoRA', 'alpha_lora.safetensors'), A);
fs.writeFileSync(path.join(act, 'Lora', 'beta_lora.safetensors'), B);               // même taille et même début en stock, mais contenu différent à un octet près -> refusé
const B2 = Buffer.from(B); fs.writeFileSync(path.join(sto, 'LoRA', 'beta_lora.safetensors'), B2);
fs.writeFileSync(path.join(act, 'Lora', 'gamma_lora.safetensors'), C);              // aucune copie en stock -> jamais proposé
const { openDb, addRoot, queryAssets } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const { getJob } = await import('../src/jobs.js');
const { moveModel } = await import('../src/placement.js');
const { listLiberables, startLiberateJob } = await import('../src/liberer.js');
const { getOrigin } = await import('../src/origins.js');
const db = openDb();
const rA = addRoot(db, { name: 'swarm', path: act, role: 'active' });
const rS = addRoot(db, { name: 'stock', path: sto, role: 'store' });
await scanPath(db, { dir: act, rootId: rA.id, maxDepth: 5, minBytes: 1 });
await scanPath(db, { dir: sto, rootId: rS.id, maxDepth: 5, minBytes: 1 });
const byName = (n, role) => queryAssets(db, { q: n, limit: 20 }).items.find((a) => a.file_name === n && (!role || a.root_role === role));
const wait = async (id) => { for (let i = 0; i < 300; i++) { const j = getJob(id); if (j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 100)); } throw new Error('délai'); };

// candidats : seulement ceux qui ont une copie en stock (même taille + même empreinte rapide)
const L = listLiberables(db);
const names = L.items.map((x) => x.file);
assert.ok(names.includes('alpha_lora.safetensors')); assert.ok(!names.includes('gamma_lora.safetensors'));
console.log('  ✔ libérer : seuls les fichiers déjà rangés en double sont proposés');

// un octet change dans la copie de stock APRÈS le listage (même taille) : la vérification complète le voit, rien n'est retiré
const betaStock = path.join(sto, 'LoRA', 'beta_lora.safetensors'); const mid = Buffer.from(B2); mid[B2.length >> 1] ^= 0xff; fs.writeFileSync(betaStock, mid);
const beta = L.items.find((x) => x.file === 'beta_lora.safetensors');
if (beta) {
  const jb = await wait(startLiberateJob(db, { ids: [beta.id], permanent: true }).id);
  assert.equal(jb.status, 'done'); assert.equal(jb.result.freed, 0); assert.match(jb.result.failed[0].error, /PAS identiques/);
  assert.ok(fs.existsSync(path.join(act, 'Lora', 'beta_lora.safetensors')), 'la copie active est intacte');
  assert.equal(getOrigin(db, byName('beta_lora.safetensors', 'store')), null, 'pas de fausse adresse d\'origine');
  console.log('  ✔ libérer : copies différentes à un octet près -> refusé, rien touché');
}

// libération (effacement direct pour le test : pas de corbeille Windows ici) de la copie identique
const alpha = L.items.find((x) => x.file === 'alpha_lora.safetensors');
const activePath = alpha.path;
const j = await wait(startLiberateJob(db, { ids: [alpha.id], permanent: true }).id);
assert.equal(j.status, 'done'); assert.equal(j.result.freed, 1); assert.equal(j.result.bytes, A.length);
assert.ok(!fs.existsSync(activePath), 'copie active retirée'); assert.ok(fs.existsSync(path.join(sto, 'LoRA', 'alpha_lora.safetensors')), 'copie de stock gardée');
assert.equal(byName('alpha_lora.safetensors', 'active'), undefined, 'plus de ligne fantôme « absente » dans le catalogue');
const kept = byName('alpha_lora.safetensors', 'store');
assert.equal(getOrigin(db, kept).path.toLowerCase(), activePath.toLowerCase());
assert.equal(listLiberables(db).items.some((x) => x.file === 'alpha_lora.safetensors'), false);
console.log('  ✔ libérer : copie active retirée après vérification, adresse exacte retenue');

// Invoquer : le modèle revient PILE à son adresse d'avant (sous-dossier « styles » compris)
const r = await moveModel(db, { assetId: kept.id, toRoot: rA.id, companionIds: [] });
assert.equal((await wait(r.job.id)).status, 'done');
assert.ok(fs.existsSync(activePath) && fs.readFileSync(activePath).equals(A));
console.log('  ✔ libérer : Invoquer remet le fichier au même endroit, contenu identique');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou sqlite */ }
process.exit(0);
