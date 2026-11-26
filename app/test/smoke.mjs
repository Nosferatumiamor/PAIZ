// Smoke tests: build fake model files, scan them, move/trash/restore, hit the API.
// Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mdisp-test-'));
process.env.MDISP_HOME = path.join(TMP, 'home');
process.env.NO_COLOR = '1';
process.env.PAIZ_TRASH = 'folder'; // les tests ne touchent pas à la vraie corbeille Windows

const active = path.join(TMP, 'active');
const store = path.join(TMP, 'store');
const adhoc = path.join(TMP, 'adhoc');
for (const d of [active, store, adhoc, path.join(active, 'loras'), path.join(store, 'llm'), path.join(store, 'dupes'), path.join(adhoc, 'controlnet')]) {
  fs.mkdirSync(d, { recursive: true });
}

// --- fake safetensors -------------------------------------------------------
function writeSafetensors(file, { meta = {}, tensorKeys = [], payloadBytes = 200 * 1024 }) {
  const header = { __metadata__: meta };
  for (const key of tensorKeys) header[key] = { dtype: 'F16', shape: [2, 2], data_offsets: [0, 8] };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  fs.writeFileSync(file, Buffer.concat([len, json, Buffer.alloc(payloadBytes)]));
}

writeSafetensors(path.join(active, 'loras', 'test_lora_sdxl.safetensors'), {
  meta: { ss_base_model_version: 'sdxl_base_v1-0', ss_network_module: 'networks.lora', ss_network_dim: '16' },
  tensorKeys: ['lora_unet_down_blocks_0_lora_down', 'lora_unet_down_blocks_0_lora_up'],
});
// Real duplicate: byte-for-byte copy on another root.
fs.copyFileSync(path.join(active, 'loras', 'test_lora_sdxl.safetensors'), path.join(store, 'dupes', 'test_lora_sdxl.safetensors'));
writeSafetensors(path.join(adhoc, 'controlnet', 'control_v11p_sd15_openpose.safetensors'), {
  meta: {},
  tensorKeys: ['input_hint_block.0.weight', 'controlnet_cond_embedding.conv_in.weight'],
});

// --- fake GGUF --------------------------------------------------------------
function ggufString(s) {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(b.length));
  return Buffer.concat([len, b]);
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function kvString(key, value) { return Buffer.concat([ggufString(key), u32(8), ggufString(value)]); }
function kvU32(key, value) { return Buffer.concat([ggufString(key), u32(4), u32(value)]); }
function kvStringArray(key, values) {
  return Buffer.concat([
    ggufString(key), u32(9), u32(8), u64(values.length),
    ...values.map((v) => ggufString(v)),
  ]);
}

const ggufParts = [
  Buffer.from('GGUF', 'latin1'),
  u32(3),
  u64(0), // tensor count
  u64(6), // kv count
  kvString('general.architecture', 'llama'),
  kvString('general.name', 'TinyLlama Test'),
  kvU32('general.file_type', 15), // Q4_K_M
  kvU32('llama.context_length', 2048),
  kvU32('llama.block_count', 22),
  kvStringArray('tokenizer.ggml.tokens', ['<s>', '</s>', 'hello']),
];
fs.writeFileSync(path.join(store, 'llm', 'tinyllama-1.1b-q4_k_m.gguf'), Buffer.concat([...ggufParts, Buffer.alloc(120 * 1024)]));

// --- imports (after MDISP_HOME is set) --------------------------------------
const { openDb, addRoot, queryAssets, duplicateGroups, stats, getAsset, listRoots } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const { startTransferJob, startTrashJob, startRestoreJob, startLinkJob } = await import('../src/jobs.js');
const { createServer } = await import('../src/server.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(job) {
  let i = 0;
  while (job.status === 'running' && i++ < 200) await sleep(25);
  assert.equal(job.status, 'done', `job failed: ${job.error}`);
  return job;
}

let db = null;
try {
  db = openDb();
  const activeRoot = addRoot(db, { name: 'active', path: active, role: 'active' });
  const storeRoot = addRoot(db, { name: 'store', path: store, role: 'store' });
  assert.equal(listRoots(db).length, 2);

  // 1. Scan managed roots + an ad-hoc folder.
  let res = await scanPath(db, { dir: active, rootId: activeRoot.id });
  assert.equal(res.total, 1, 'one lora found');
  res = await scanPath(db, { dir: store, rootId: storeRoot.id });
  assert.equal(res.total, 2, 'gguf + duplicate found');
  res = await scanPath(db, { dir: adhoc });
  assert.equal(res.total, 1, 'adhoc controlnet found');

  // 1b. Whole-parent discovery reattaches files inside known roots, even though
  // the scan target itself is not a root (the all-disks scan behaves this way).
  res = await scanPath(db, { dir: TMP, perFileRoot: true, deep: true, paceMs: 0 });
  assert.equal(res.total, 4, 'discovery finds the four models');
  assert.equal(queryAssets(db, { rootId: activeRoot.id }).total, 1, 'active root reattached');
  assert.equal(queryAssets(db, { rootId: storeRoot.id }).total, 2, 'store root reattached');

  // 2. Classification.
  const loras = queryAssets(db, { category: 'lora' }).items;
  assert.equal(loras.length, 2, 'two lora copies');
  assert.equal(loras[0].base_model, 'sdxl', 'lora base detected from metadata');
  const llms = queryAssets(db, { category: 'llm' }).items;
  assert.equal(llms.length, 1, 'gguf classified as llm');
  assert.equal(llms[0].base_model, 'llama', 'gguf architecture mapped');
  assert.equal(llms[0].version, 'Q4_K_M', 'gguf quant detected');
  const cn = queryAssets(db, { category: 'controlnet' }).items;
  assert.equal(cn.length, 1, 'controlnet category detected');
  assert.equal(cn[0].base_model, 'sd15', 'controlnet base detected from name');
  assert.equal(cn[0].managed, 0, 'adhoc file is unmanaged');

  // 3. Duplicates.
  const dups = duplicateGroups(db);
  assert.equal(dups.length, 1, 'one duplicate group');
  assert.equal(dups[0].items.length, 2);
  assert.ok(dups[0].size > 100 * 1024);

  // 4. Move a model between roots (same volume → instant rename).
  const source = queryAssets(db, { category: 'lora', rootId: activeRoot.id }).items[0];
  const job = await wait(startTransferJob(db, { assetId: source.id, toRoot: storeRoot.id, mode: 'move' }));
  const moved = getAsset(db, job.result.assetId);
  assert.ok(moved.abs_path.toLowerCase().startsWith(path.join(store, 'loras').toLowerCase()), 'moved into store/loras');
  assert.equal(fs.existsSync(source.abs_path), false, 'source removed');
  assert.ok(fs.existsSync(moved.abs_path), 'destination exists');
  assert.equal(moved.base_model, 'sdxl', 'metadata preserved');
  assert.equal(moved.root_id, storeRoot.id);

  // 4b. Hardlink (same volume, zero extra bytes) and copy.
  const linkPath = path.join(TMP, 'links', 'lora-link.safetensors');
  await wait(startLinkJob(db, { assetId: moved.id, linkPath, kind: 'hardlink' }));
  assert.ok(fs.existsSync(linkPath), 'hardlink created');
  assert.equal(fs.statSync(linkPath).size, moved.size_bytes);
  fs.rmSync(linkPath);

  const copyJob = await wait(startTransferJob(db, { assetId: moved.id, toRoot: activeRoot.id, mode: 'copy' }));
  assert.notEqual(copyJob.result.assetId, moved.id, 'copy registers a new asset');
  assert.ok(fs.existsSync(copyJob.result.path), 'copy exists on disk');
  assert.ok(fs.existsSync(moved.abs_path), 'original still exists after copy');

  // 5. Trash then restore.
  const t = await wait(startTrashJob(db, { assetIds: [moved.id] }));
  const trashed = getAsset(db, moved.id);
  assert.equal(trashed.state, 'trashed');
  assert.ok(fs.existsSync(trashed.abs_path), 'trashed file kept on disk');
  assert.ok(trashed.abs_path.includes('.mdisp-trash'));
  await wait(startRestoreJob(db, { assetIds: [moved.id] }));
  const restored = getAsset(db, moved.id);
  assert.equal(restored.state, 'present');
  assert.equal(restored.abs_path, moved.abs_path);
  assert.ok(fs.existsSync(restored.abs_path));

  // 6. Stats.
  const s = stats(db);
  assert.equal(s.totals.count, 5);
  assert.equal(s.unmanaged, 1);
  assert.equal(s.duplicateGroups, 1);
  assert.ok(s.totals.bytes > 300 * 1024);

  // 7. HTTP API.
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const health = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(health.ok, true);
    const stateData = await (await fetch(`${baseUrl}/api/state`)).json();
    assert.equal(stateData.stats.totals.count, 5);
    assert.equal(stateData.roots.length, 2);
    const list = await (await fetch(`${baseUrl}/api/assets?category=lora&sort=size&dir=desc`)).json();
    assert.equal(list.total, 3);
    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.ok(html.includes('PAIZ'), 'UI served');
    const dupRes = await (await fetch(`${baseUrl}/api/duplicates`)).json();
    assert.equal(dupRes.groups.length, 1);
    const lookup = await (await fetch(`${baseUrl}/api/lookup?name=tinyllama`)).json();
    assert.equal(lookup.count, 1);
    assert.ok(lookup.matches[0].abs_path.endsWith('.gguf'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // 8. CLI still works end to end.
  const cli = path.resolve(import.meta.dirname, '..', 'src', 'cli.js');
  const out = execFileSync(process.execPath, [cli, 'list', '--json'], {
    env: { ...process.env, MDISP_HOME: process.env.MDISP_HOME, NO_COLOR: '1' },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.total, 5);

  console.log('\n  ✔ Smoke tests passed');
  console.log(`  temp: ${TMP}\n`);
} finally {
  try { db?.close(); } catch { /* ignore */ }
  // Leave the temp folder for inspection when MDISP_KEEP is set.
  if (!process.env.MDISP_KEEP) {
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (err) { console.error('cleanup:', err.code); }
  }
}
