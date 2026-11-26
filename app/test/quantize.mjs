// Quantification : niveaux proposés selon le modèle, fabrication (faux llama-quantize), progression, nouveau modèle « frais ».
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-quant-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb, addRoot, setSetting, getAssetByPath } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const { quantOptions, startQuantize, quantState, freshIds, markSeen, detectQuant } = await import('../src/quantize.js');
const db = openDb();

// propositions selon le modèle
assert.equal(detectQuant('gemma-4-26B-A4B-it-Q4_K_M.gguf'), 'Q4_K_M');
assert.equal(detectQuant('model-BF16.gguf'), 'BF16');
let o = quantOptions({ file_name: 'x-BF16.gguf', size_bytes: 50e9 });
assert.deepEqual(o.levels.map((l) => l.q), ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'Q3_K_M', 'Q2_K']);
assert.ok(!o.levels[0].warn, 'depuis BF16 : pas d’avertissement de cumul');
o = quantOptions({ file_name: 'x-Q4_K_M.gguf', size_bytes: 16e9 });
assert.deepEqual(o.levels.map((l) => l.q), ['Q3_K_M', 'Q2_K']);
assert.match(o.levels[0].warn, /déjà quantifié/); assert.match(o.levels[0].warn, /trop quantifié/);
assert.equal(quantOptions({ file_name: 'gpt-oss-MXFP4.gguf', size_bytes: 59e9 }).ok, false);
assert.equal(quantOptions({ file_name: 'x-Q2_K.gguf', size_bytes: 5e9 }).ok, false, 'déjà au plus bas');
assert.equal(quantOptions({ file_name: 'inconnu.gguf', size_bytes: 5e9 }).ok, false, 'niveau inconnu : rien');
assert.equal(quantOptions({ file_name: 'v.safetensors', size_bytes: 5e9 }).ok, false);
assert.ok(!quantOptions({ file_name: 'petit-Q8_0.gguf', size_bytes: 0.8e9 }).levels.some((l) => l.risk >= 2), 'petit modèle : pas de Q3 / Q2');

// fabrication avec un faux llama-quantize (script node : écrit la progression puis le fichier)
const dir = path.join(TMP, 'm'); fs.mkdirSync(dir);
const src = path.join(dir, 'jouet-Q8_0.gguf');
const hdr = Buffer.alloc(24); hdr.write('GGUF', 0); hdr.writeUInt32LE(3, 4);
fs.writeFileSync(src, Buffer.concat([hdr, Buffer.alloc(4000, 7)]));
const fake = path.join(TMP, 'fakequant.cmd');
const js = path.join(TMP, 'fakequant.js');
fs.writeFileSync(js, "const a=process.argv.slice(2).filter(x=>!x.startsWith('--'));for(let i=1;i<=4;i++)console.log('['+i+'/4] blk.'+i);require('fs').writeFileSync(a[1],Buffer.concat([Buffer.from('GGUF'),Buffer.alloc(2000,1)]));");
fs.writeFileSync(fake, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
setSetting(db, 'engine.quantizeExe', fake);
const root = addRoot(db, { name: 'm', path: dir, role: 'active' });
await scanPath(db, { dir, rootId: root.id, minBytes: 1 });
const a = getAssetByPath(db, src);
assert.ok(a, 'modèle au catalogue');
await assert.rejects(() => startQuantize(db, a.id, 'Q2_K'), /non proposé|Niveau/, 'Q2_K pas proposé pour ce modèle (< 1 Go)');
await startQuantize(db, a.id, 'Q4_K_M');
assert.equal(quantState.running, true);
await assert.rejects(() => startQuantize(db, a.id, 'Q5_K_M'), /déjà en cours/);
for (let i = 0; i < 100 && quantState.running; i++) await new Promise((r) => setTimeout(r, 100));
assert.equal(quantState.running, false); assert.equal(quantState.error, null, quantState.error);
const out = path.join(dir, 'jouet-Q4_K_M.gguf');
assert.ok(fs.existsSync(out) && !fs.existsSync(out + '.building'), 'fichier final présent, temporaire disparu');
const n = getAssetByPath(db, out);
assert.ok(n, 'le nouveau modèle est au catalogue'); assert.deepEqual(freshIds(db), [n.id], 'surligné jusqu’au premier clic');
assert.equal(quantState.pct, 100);
markSeen(db, n.id); assert.deepEqual(freshIds(db), []);
const { usageReport } = await import('../src/usage.js');
const origine = usageReport(db).rows.find((r) => r.file_name === 'jouet-Q4_K_M.gguf')?.source;
assert.equal(origine?.derivedFrom, 'jouet-Q8_0.gguf'); assert.equal(origine?.quant, 'Q4_K_M'); assert.match(origine.how, /allégée par PAIZ/);
console.log('  ✔ quantification : niveaux selon le modèle, fabrication, progression, modèle surligné');

// extra-light : une Q3 déjà là (fabriquée par « Quantifier », ou le modèle lui-même en Q3) est reconnue, plus d'avertissement
const { findVariant } = await import('../src/engine.js');
const q4 = path.join(dir, 'gem-Q4_K_M.gguf'); fs.writeFileSync(q4, 'x');
assert.equal(findVariant(q4), null, 'pas de Q3 : absente');
const q3 = path.join(dir, 'gem-Q3_K_M.gguf'); fs.writeFileSync(q3, 'x');
assert.equal(findVariant(q4), q3, 'Q3 fabriquée par Quantifier reconnue');
assert.equal(findVariant(q3), q3, 'le modèle déjà en Q3 sert directement');
console.log('  ✔ extra-light : Q3 existante reconnue');
