// Fusionner deux dossiers : tous les modèles du dossier source partent dans la cible (rangés par type si c'est une écurie propre).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-merge-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const src = path.join(TMP, 'vieux'); const dst = path.join(TMP, 'propre');
fs.mkdirSync(path.join(src, 'vrac'), { recursive: true }); fs.mkdirSync(dst, { recursive: true });
const put = (p, n, fill) => fs.writeFileSync(p, Buffer.alloc(n, fill));
put(path.join(src, 'astolfo_lora.safetensors'), 30000, 3);
put(path.join(src, 'vrac', 'skin_texture_lora.safetensors'), 31000, 4);
const { openDb, addRoot, queryAssets } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const { getJob } = await import('../src/jobs.js');
const { mergeRoots } = await import('../src/placement.js');
const E = await import('../src/ecurie.js');
const db = openDb();
const rS = addRoot(db, { name: 'vieux', path: src, role: 'store' });
const rD = addRoot(db, { name: 'propre', path: dst, role: 'store' });
E.setCleanRoot(db, rD.id, true);
await scanPath(db, { dir: src, rootId: rS.id, maxDepth: 5, minBytes: 1 });
await assert.rejects(() => mergeRoots(db, rS.id, rS.id), /différents/);
const res = await mergeRoots(db, rS.id, rD.id);
assert.equal(res.files, 2);
let j; for (let i = 0; i < 200; i++) { j = getJob(res.job.id); if (j.status !== 'running') break; await new Promise((r) => setTimeout(r, 100)); }
assert.equal(j.status, 'done', j.error);
const items = queryAssets(db, { rootId: rD.id, limit: 50 }).items;
assert.equal(items.length, 2);
assert.ok(items.every((a) => a.abs_path.startsWith(dst) && fs.existsSync(a.abs_path) && /[\\/]Images[\\/]LoRA[\\/]/.test(a.abs_path)), 'rangés par type dans l\'écurie propre');
assert.equal(queryAssets(db, { rootId: rS.id, limit: 50 }).items.length, 0);
assert.ok(!fs.existsSync(path.join(src, 'astolfo_lora.safetensors')));
await assert.rejects(() => mergeRoots(db, rS.id, rD.id), /aucun modèle/);
console.log('  ✔ fusion de dossiers : modèles déplacés et rangés par type dans l\'écurie propre, source vidée');
