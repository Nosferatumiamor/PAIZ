// Second moteur (llama.cpp récent) : choix selon l'architecture, traduction des modes en plafond de RAM, arguments, message clair si absent.
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-stock-'));
process.env.PAIZ_HOME = path.join(tmp, 'home');
process.env.WS_STOCK_HOME = path.join(tmp, 'no-stock'); // dossier vide : le moteur secondaire est « absent »
const { openDb, setSetting } = await import('../src/db.js');
const S = await import('../src/stockengine.js');
const E = await import('../src/engine.js');
const db = openDb();

// faux GGUF : en-tête minimal avec general.architecture
function fakeGguf(file, arch) {
  const str = (s) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(8); l.writeBigUInt64LE(BigInt(b.length)); return Buffer.concat([l, b]); };
  const head = Buffer.alloc(24); head.write('GGUF', 0, 'latin1'); head.writeUInt32LE(3, 4); head.writeBigUInt64LE(0n, 8); head.writeBigUInt64LE(1n, 16);
  const t = Buffer.alloc(4); t.writeUInt32LE(8);
  fs.writeFileSync(file, Buffer.concat([head, str('general.architecture'), t, str(arch), Buffer.alloc(64)]));
}
const ink = path.join(tmp, 'ink.gguf'); fakeGguf(ink, 'inkling2_loop');
const gem = path.join(tmp, 'gem.gguf'); fakeGguf(gem, 'gemma4');
assert.equal(await S.isStockModel(db, ink), true, 'Inkling va sur le second moteur');
assert.equal(await S.isStockModel(db, gem), false, 'Gemma reste sur notre moteur');
assert.equal(await S.isStockModel(db, path.join(tmp, 'absent.gguf')), false);
setSetting(db, 'engine.stockArchs', 'gemma4, autre'); // architectures ajoutées par réglage
assert.equal(await S.isStockModel(db, gem), true);
setSetting(db, 'engine.stockArchs', '');

// chaque mode de PAIZ se traduit en palier ; les sobres plafonnent la RAM, aucun ne remplit la VRAM (pas d'offload des opérations)
for (const name of Object.keys(E.PROFILES)) {
  const p = S.stockPlan(name);
  assert.ok(['sobre', 'equilibre', 'libre'].includes(p.tier), name);
}
assert.equal(S.stockPlan('eco').capMib, 4096);
assert.equal(S.stockPlan('normal').capMib, 8192);
assert.equal(S.stockPlan('confort').capMib, 0);
const args = S.stockArgs(db, { model: 'C:/m/ink.gguf', port: 8770, ctx: 16384, slots: 1 });
assert.ok(args.includes('--cpu-moe') && args.includes('--no-op-offload'));
assert.equal(args[args.indexOf('-np') + 1], '1');
assert.ok(args.includes('--reasoning-budget'), 'réflexion coupée par défaut');
setSetting(db, 'engine.stockReasoning', 'on');
assert.ok(!S.stockArgs(db, { model: 'm', port: 1, ctx: 1, slots: 1 }).includes('--reasoning-budget'));

// moteur secondaire absent : message clair, et le moteur habituel n'est pas touché
await assert.rejects(() => E.startEngine(db, { asset: { id: 1, abs_path: ink, file_name: 'ink.gguf' }, profile: 'normal' }), /moteur secondaire/);
assert.equal((await E.engineStatus(db)).current, null);
// un modèle ordinaire garde le message de notre moteur
setSetting(db, 'engine.exe', path.join(tmp, 'ws_npc_server.exe'));
await assert.rejects(() => E.startEngine(db, { asset: { id: 2, abs_path: gem, file_name: 'gem.gguf' }, profile: 'normal' }), /ws_npc_server introuvable/);
console.log('stock-engine : OK');
