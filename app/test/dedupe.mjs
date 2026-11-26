// Doublons : fusion par lien dur (contenu vérifié, rien de perdu) et « modèles liés » déduits des noms.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-dedupe-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb, addRoot, duplicateGroups, queryAssets } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const { mergeCopies, annotateGroups, inodeKey } = await import('../src/dedupe.js');
const { relatedTo } = await import('../src/related.js');
const db = openDb();

const a = path.join(TMP, 'clip'); const b = path.join(TMP, 'text_encoders'); const c = path.join(TMP, 'diffusion_models');
for (const d of [a, b, c]) fs.mkdirSync(d);
const big = Buffer.alloc(3_000_000, 5);
fs.writeFileSync(path.join(a, 'qwen_3_4b.safetensors'), big);
fs.writeFileSync(path.join(b, 'qwen_3_4b.safetensors'), big);
fs.writeFileSync(path.join(c, 'fluxKleinFP8_flux2Klein4bFp8.safetensors'), Buffer.alloc(2_000_000, 9));
fs.writeFileSync(path.join(c, 'flux2_vae.safetensors'), Buffer.alloc(1_100_000, 3));
const hdr = Buffer.alloc(24); hdr.write('GGUF', 0); hdr.writeUInt32LE(3, 4);
fs.writeFileSync(path.join(c, 'Huihui-Qwen3-VL-4B-Q4_K_M.gguf'), Buffer.concat([hdr, Buffer.alloc(1_500_000, 1)]));
fs.writeFileSync(path.join(c, 'mmproj-Huihui-Qwen3-VL-4B-F16.gguf'), Buffer.concat([hdr, Buffer.alloc(1_200_000, 2)]));
const root = addRoot(db, { name: 'r', path: TMP, role: 'active' });
await scanPath(db, { dir: TMP, rootId: root.id, minBytes: 1 });

let g = annotateGroups(duplicateGroups(db)).find((x) => x.items[0].file_name === 'qwen_3_4b.safetensors');
assert.ok(g, 'le doublon est détecté'); assert.equal(g.merged, false); assert.equal(g.physicalCopies, 2);
const ids = g.items.map((i) => i.id);

// fusion : un seul fichier physique, les deux chemins restent lisibles
const r = await mergeCopies(db, ids);
assert.equal(r.report[0].status, 'fusionnée'); assert.equal(r.saved, big.length);
assert.equal(inodeKey(path.join(a, 'qwen_3_4b.safetensors')), inodeKey(path.join(b, 'qwen_3_4b.safetensors')));
assert.ok(fs.readFileSync(path.join(a, 'qwen_3_4b.safetensors')).equals(big) && fs.readFileSync(path.join(b, 'qwen_3_4b.safetensors')).equals(big));
assert.equal(fs.readdirSync(a).concat(fs.readdirSync(b)).filter((n) => n.endsWith('.paiz-lien')).length, 0, 'pas de fichier temporaire');
g = annotateGroups(duplicateGroups(db)).find((x) => x.items[0].file_name === 'qwen_3_4b.safetensors');
assert.equal(g.merged, true, 'groupe signalé fusionné');
assert.equal((await mergeCopies(db, ids)).report[0].status, 'déjà fusionnée', 'idempotent');

// contenu différent (même taille) : on ne touche à rien
const x1 = path.join(a, 'x.bin'); const x2 = path.join(b, 'x.bin');
fs.writeFileSync(x1, Buffer.alloc(2_000_000, 1)); fs.writeFileSync(x2, Buffer.alloc(2_000_000, 2));
await scanPath(db, { dir: TMP, rootId: root.id, minBytes: 1 });
const ax = queryAssets(db, { limit: 100 }).items.filter((i) => i.file_name === 'x.bin');
if (ax.length === 2) { const rr = await mergeCopies(db, ax.map((i) => i.id)); assert.match(rr.report[0].status, /différent/); assert.notEqual(inodeKey(x1), inodeKey(x2)); }

// modèles liés
const find = (n) => queryAssets(db, { limit: 100 }).items.find((i) => i.file_name === n);
let rel = relatedTo(db, find('qwen_3_4b.safetensors').id);
assert.ok(rel.usedBy.some((x) => /Klein/i.test(x.file)), 'l’encodeur est utilisé par Flux Klein');
assert.ok(rel.same.length === 1 && rel.same[0].linked, 'même fichier ailleurs, lien dur');
rel = relatedTo(db, find('fluxKleinFP8_flux2Klein4bFp8.safetensors').id);
assert.ok(rel.uses.some((x) => x.file === 'flux2_vae.safetensors') && rel.uses.some((x) => x.file === 'qwen_3_4b.safetensors'), 'Klein utilise son VAE et son encodeur');
rel = relatedTo(db, find('Huihui-Qwen3-VL-4B-Q4_K_M.gguf').id);
assert.ok(rel.uses.some((x) => /^mmproj/.test(x.file)), 'le modèle de langage utilise son module d’image');
rel = relatedTo(db, find('mmproj-Huihui-Qwen3-VL-4B-F16.gguf').id);
assert.ok(rel.usedBy.some((x) => /Q4_K_M/.test(x.file)), 'le module d’image est utilisé par son modèle');
console.log('  ✔ doublons : fusion par lien dur sans perte ; modèles liés');
