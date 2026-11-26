// Demo sandbox: builds a fake multi-disk library in your temp folder and starts the UI.
// Nothing outside the demo folder is touched. Run with: npm run demo
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.tmpdir(), 'paiz-demo');
fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 3 });

const roots = {
  active: path.join(DIR, 'C-nvme', 'models'),
  archive: path.join(DIR, 'D-archive', 'models'),
  external: path.join(DIR, 'I-external', 'civitai'),
};
for (const p of Object.values(roots)) fs.mkdirSync(p, { recursive: true });

function safetensors(file, { meta = {}, tensors = [], payload = 180 * 1024 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = { __metadata__: meta };
  for (const t of tensors) header[t] = { dtype: 'F16', shape: [2, 2], data_offsets: [0, 8] };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  fs.writeFileSync(file, Buffer.concat([len, json, Buffer.alloc(payload)]));
}

function str(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(8); l.writeBigUInt64LE(BigInt(b.length)); return Buffer.concat([l, b]); }
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const kvS = (k, v) => Buffer.concat([str(k), u32(8), str(v)]);
const kvU = (k, v) => Buffer.concat([str(k), u32(4), u32(v)]);
function gguf(file, arch, name, fileType, payloadKb = 220) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.concat([
    Buffer.from('GGUF', 'latin1'), u32(3), u64(0), u64(4),
    kvS('general.architecture', arch), kvS('general.name', name), kvU('general.file_type', fileType),
    kvU(`${arch}.context_length`, 8192),
    Buffer.alloc(payloadKb * 1024),
  ]);
  fs.writeFileSync(file, buf);
}

safetensors(path.join(roots.active, 'checkpoints', 'juggernautXL_v9.safetensors'), {
  meta: { 'modelspec.title': 'Juggernaut XL v9', 'modelspec.architecture': 'stable-diffusion-xl-v1-base', 'ss_base_model_version': 'sdxl_base_v1-0' },
  tensors: ['model.diffusion_model.input_blocks.0.0.weight', 'first_stage_model.decoder.conv_in.weight'],
  payload: 900 * 1024,
});
safetensors(path.join(roots.active, 'loras', 'detail_slider_xl.safetensors'), {
  meta: { ss_base_model_version: 'sdxl_base_v1-0', ss_network_module: 'networks.lora', ss_network_dim: '32', ss_output_name: 'Detail Slider XL' },
  tensors: ['lora_unet_down_blocks_0_lora_down', 'lora_unet_down_blocks_0_lora_up'],
});
safetensors(path.join(roots.archive, 'loras', 'watercolor_pony.safetensors'), {
  meta: { ss_base_model_version: 'sdxl_base_v1-0', ss_network_module: 'networks.lora', ss_network_dim: '16', ss_output_name: 'Watercolor Pony' },
  tensors: ['lora_unet_down_blocks_1_lora_down', 'lora_unet_down_blocks_1_lora_up'],
});
safetensors(path.join(roots.archive, 'controlnet', 'control_v11p_sd15_openpose.safetensors'), {
  meta: {},
  tensors: ['input_hint_block.0.weight', 'controlnet_cond_embedding.conv_in.weight'],
});
safetensors(path.join(roots.archive, 'vae', 'sdxl_vae.safetensors'), {
  meta: {},
  tensors: ['encoder.down_blocks.0.weight', 'decoder.up_blocks.0.weight', 'quant_conv.weight'],
});
safetensors(path.join(roots.external, 'loras', 'anime_style_illustrious.safetensors'), {
  meta: { ss_base_model_version: 'sdxl_base_v1-0', ss_network_module: 'networks.lora', ss_network_dim: '64', ss_output_name: 'Anime Style Illustrious' },
  tensors: ['lora_unet_down_blocks_2_lora_down', 'lora_unet_down_blocks_2_lora_up'],
  payload: 320 * 1024,
});
gguf(path.join(roots.archive, 'llm', 'llama-3.1-8b-instruct-q4_k_m.gguf'), 'llama', 'Llama 3.1 8B Instruct', 15, 1200);
gguf(path.join(roots.active, 'llm', 'qwen2.5-7b-instruct-q5_k_m.gguf'), 'qwen2', 'Qwen2.5 7B Instruct', 17, 800);

process.env.PAIZ_HOME = path.join(DIR, 'data');
process.env.NO_COLOR = '1';

const { openDb, addRoot } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const { startServer } = await import('../src/server.js');

const db = openDb();
const active = addRoot(db, { name: 'active', path: roots.active, role: 'active' });
const archive = addRoot(db, { name: 'archive-D', path: roots.archive, role: 'store' });
const external = addRoot(db, { name: 'civitai-K', path: roots.external, role: 'external' });

console.log('\n  Préparation de la démo…');
await scanPath(db, { dir: roots.active, rootId: active.id });
await scanPath(db, { dir: roots.archive, rootId: archive.id });
await scanPath(db, { dir: roots.external, rootId: external.id });

console.log(`  Dossier de démo : ${DIR}`);
console.log('  (les fichiers sont factices, aucune donnée réelle n\'est touchée)\n');
await startServer({
  port: Number(process.env.PAIZ_DEMO_PORT || 7799),
  open: !process.argv.includes('--no-open') && process.env.PAIZ_NO_OPEN !== '1',
});
