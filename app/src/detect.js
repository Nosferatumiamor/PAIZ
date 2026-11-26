// Model identification: category, base model / family, title, version.
// Reads safetensors + GGUF headers directly (no dependency, no full file read).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJsonSafe, cleanTitle } from './util.js';

export const CATEGORIES = [
  { id: 'checkpoint', label: 'Checkpoint / modèle principal', short: 'Checkpoint' },
  { id: 'lora', label: 'LoRA / LyCORIS', short: 'LoRA' },
  { id: 'controlnet', label: 'ControlNet', short: 'ControlNet' },
  { id: 'vae', label: 'VAE', short: 'VAE' },
  { id: 'embedding', label: 'Embedding / Textual inversion', short: 'Embedding' },
  { id: 'upscaler', label: 'Upscaler', short: 'Upscaler' },
  { id: 'clip', label: 'CLIP / T5 / encodeur texte', short: 'CLIP/T5' },
  { id: 'ipadapter', label: 'IP-Adapter', short: 'IP-Adapter' },
  { id: 'faceid', label: 'FaceID / InsightFace', short: 'FaceID' },
  { id: 'motion', label: 'Motion / AnimateDiff', short: 'Motion' },
  { id: 'llm', label: 'LLM / GGUF', short: 'LLM' },
  { id: 'onnx', label: 'ONNX', short: 'ONNX' },
  { id: 'other', label: 'Autre', short: 'Autre' },
];

export const BASE_MODELS = [
  { id: 'sd15', label: 'SD 1.5', family: 'sd15' },
  { id: 'sd20', label: 'SD 2.0', family: 'sd2' },
  { id: 'sd21', label: 'SD 2.1', family: 'sd2' },
  { id: 'sdxl', label: 'SDXL', family: 'sdxl' },
  { id: 'pony', label: 'Pony', family: 'sdxl' },
  { id: 'illustrious', label: 'Illustrious', family: 'sdxl' },
  { id: 'noobai', label: 'NoobAI', family: 'sdxl' },
  { id: 'sd3', label: 'SD 3', family: 'sd3' },
  { id: 'sd35', label: 'SD 3.5', family: 'sd3' },
  { id: 'flux', label: 'FLUX', family: 'flux' },
  { id: 'kolors', label: 'Kolors', family: 'kolors' },
  { id: 'pixart', label: 'PixArt', family: 'pixart' },
  { id: 'hunyuan', label: 'Hunyuan', family: 'hunyuan' },
  { id: 'wan', label: 'Wan', family: 'wan' },
  { id: 'llama', label: 'Llama', family: 'llama' },
  { id: 'qwen', label: 'Qwen', family: 'qwen' },
  { id: 'mistral', label: 'Mistral', family: 'mistral' },
  { id: 'gemma', label: 'Gemma', family: 'gemma' },
  { id: 'phi', label: 'Phi', family: 'phi' },
  { id: 'deepseek', label: 'DeepSeek', family: 'deepseek' },
];

const BASE_BY_ID = new Map(BASE_MODELS.map((b) => [b.id, b]));

export function baseLabel(id) {
  return id ? (BASE_BY_ID.get(id)?.label || id) : null;
}

export function baseFamily(id) {
  return id ? (BASE_BY_ID.get(id)?.family || id) : null;
}

// Word-boundary regex that treats `_`, `.` and `-` as separators (JS \b does not).
const W = (pattern) => new RegExp(`(?<![a-z0-9])(?:${pattern})(?![a-z0-9])`, 'i');

// Loose textual detection, ordered from most specific to least.
const BASE_RULES = [
  [W('pony|ponyv\\d+|pony[_ .-]?diffusion|autismmix'), 'pony'],
  [W('illustrious|noobai|noob-ai'), 'illustrious'],
  [W('sdxl|sd[_ .-]?xl|stable[_ .-]?diffusion[_ .-]?xl'), 'sdxl'],
  [W('flux'), 'flux'],
  [W('sd[_ .-]?3[._]?5|sd3\\.5'), 'sd35'],
  [W('sd[_ .-]?3'), 'sd3'],
  [W('sd[_ .-]?2[._]?1|sd21|v2\\.1'), 'sd21'],
  [W('sd[_ .-]?2|sd20|v2\\.0'), 'sd20'],
  [W('sd[_ .-]?1[._]?5|sd15|sd[_ .-]?v1|v1\\.5'), 'sd15'],
  [W('wan[._-]?2|wan2'), 'wan'],
  [W('hunyuan'), 'hunyuan'],
  [W('kolors'), 'kolors'],
  [W('pixart'), 'pixart'],
  [W('qwen'), 'qwen'],
  [W('llama|llama3'), 'llama'],
  [W('mistral|mixtral'), 'mistral'],
  [W('gemma'), 'gemma'],
  [W('phi[._-]?[34]'), 'phi'],
  [W('deepseek'), 'deepseek'],
  [W('stable[_ .-]?diffusion'), 'sd15'],
];

const META_BASE_RULES = [
  [/^sd_v1$/i, 'sd15'],
  [/^sd_v2$/i, 'sd20'],
  [/^sdxl/i, 'sdxl'],
  [/^sd_xl/i, 'sdxl'],
  [/^pony/i, 'pony'],
  [/^illustrious/i, 'illustrious'],
  [/^flux/i, 'flux'],
  [/^(sd_?3|sd3)/i, 'sd3'],
  [/stable-diffusion-xl/i, 'sdxl'],
  [/stable-diffusion-v1/i, 'sd15'],
  [/stable-diffusion-v2/i, 'sd20'],
];

const GGUF_ARCH = {
  llama: 'llama', qwen2: 'qwen', qwen3: 'qwen', qwen2vl: 'qwen', qwen2moe: 'qwen',
  mistral: 'mistral', mixtral: 'mistral', gemma: 'gemma', gemma2: 'gemma', gemma3: 'gemma',
  phi2: 'phi', phi3: 'phi', deepseek2: 'deepseek', deepseek: 'deepseek',
  'stable-diffusion': 'sd15', 'sd-xl': 'sdxl', flux: 'flux',
};

const CATEGORY_ORDER = ['lora', 'controlnet', 'vae', 'embedding', 'upscaler', 'clip', 'ipadapter', 'faceid', 'motion', 'llm', 'onnx'];

const NAME_RULES = [
  [W('lora|lycoris|locon|loha|dora|hada'), 'lora'],
  [W('control[_-]?net|control[_-]?lora|t2i[_-]?adapter|t2iadapter'), 'controlnet'],
  [W('vae|vae-ft|kl-f8'), 'vae'],
  [W('embedding|textual[_-]?inversion|textualinversion|ti'), 'embedding'],
  [W('upscale|upscaler|esrgan|swinir|swin2sr|hat-gan|4x|2x'), 'upscaler'],
  [W('clip[_-]?vision|clip[_-]?l|t5xxl|t5[_-]?encoder|text[_-]?encoder'), 'clip'],
  [W('ip[_-]?adapter|ipadapter'), 'ipadapter'],
  [W('insightface|faceid|instantid|reactor|roop'), 'faceid'],
  [W('animatediff|motion[_-]?module|mm_sd'), 'motion'],
];

const QUANT_RE = /\b(IQ\d+_[A-Z0-9_]+|Q\d+_K_[SML]|Q\d+_\d|Q\d+_K|Q\d+|BF16|F16|F32|FP16|FP32|MXFP4)\b/i;

// ---------------------------------------------------------------------------
// Low-level readers
// ---------------------------------------------------------------------------

export async function readSafetensorsHeader(absPath) {
  const fh = await fsp.open(absPath, 'r');
  try {
    const b = Buffer.alloc(8);
    await fh.read(b, 0, 8, 0);
    const headerLen = Number(b.readBigUInt64LE(0));
    if (!Number.isSafeInteger(headerLen) || headerLen <= 2 || headerLen > 64 * 1024 * 1024) return null;
    const buf = Buffer.alloc(headerLen);
    await fh.read(buf, 0, headerLen, 8);
    const json = JSON.parse(buf.toString('utf8'));
    if (!json || typeof json !== 'object') return null;
    const meta = (json.__metadata__ && typeof json.__metadata__ === 'object') ? json.__metadata__ : {};
    const tensorKeys = Object.keys(json).filter((k) => k !== '__metadata__');
    return { meta, tensorKeys };
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

class GgufReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  has(n) { return this.pos + n <= this.buf.length; }
  skip(n) { if (!this.has(n)) throw new Error('gguf: out of bounds'); this.pos += n; }
  u32() { if (!this.has(4)) throw new Error('gguf: eof'); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  u64() { if (!this.has(8)) throw new Error('gguf: eof'); const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return Number(v); }
  str() {
    const len = this.u64();
    if (len < 0 || len > 64 * 1024 * 1024 || !this.has(len)) throw new Error('gguf: bad string');
    const s = this.buf.subarray(this.pos, this.pos + len).toString('utf8');
    this.pos += len;
    return s;
  }
  bytes(n) { if (!this.has(n)) throw new Error('gguf: eof'); const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
}

const FIXED = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

function ggufValue(r, type) {
  switch (type) {
    case 0: return r.bytes(1)[0];
    case 1: return r.bytes(1).readInt8(0);
    case 2: return r.bytes(2).readUInt16LE(0);
    case 3: return r.bytes(2).readInt16LE(0);
    case 4: return r.u32();
    case 5: return r.bytes(4).readInt32LE(0);
    case 6: return r.bytes(4).readFloatLE(0);
    case 7: return r.bytes(1)[0] !== 0;
    case 8: return r.str();
    case 10: return r.u64();
    case 11: return r.bytes(8).readBigInt64LE(0).toString();
    case 12: return r.bytes(8).readDoubleLE(0);
    default: throw new Error(`gguf: unknown type ${type}`);
  }
}

function skipGgufValue(r, type) {
  if (type === 8) { const len = r.u64(); if (len > 512 * 1024 * 1024) throw new Error('gguf: huge string'); r.skip(len); return; }
  if (type === 9) {
    const sub = r.u32();
    const count = r.u64();
    if (count > 10_000_000) throw new Error('gguf: huge array');
    for (let i = 0; i < count; i++) skipGgufValue(r, sub);
    return;
  }
  if (!FIXED[type]) throw new Error(`gguf: unknown type ${type}`);
  r.skip(FIXED[type]);
}

const GGUF_FILE_TYPES = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
  10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M',
  16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S',
  22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M',
  28: 'IQ2_S', 29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16', 33: 'Q4_0_4_4',
  34: 'Q4_0_4_8', 35: 'Q4_0_8_8', 36: 'TQ1_0', 37: 'TQ2_0', 38: 'MXFP4', 39: 'NVFP4', 40: 'Q1_0', 41: 'Q2_0', // Q1_0 / Q2_0 : modèles 1 bit / ternaires (Bonsai)
};

const GGUF_INTERESTING = [
  'general.architecture', 'general.name', 'general.file_type', 'general.quantization_version',
  'general.size_label', 'general.parameter_count', 'general.organization',
];
const GGUF_ARCH_SUFFIXES = ['context_length', 'embedding_length', 'block_count', 'expert_count', 'expert_used_count', 'attention.head_count'];

export async function readGgufHeader(absPath) {
  const fh = await fsp.open(absPath, 'r');
  try {
    const st = await fh.stat();
    if (st.size < 24) return null;
    const cap = Math.min(st.size, 24 * 1024 * 1024);
    const buf = Buffer.alloc(cap);
    await fh.read(buf, 0, cap, 0);
    if (buf.toString('latin1', 0, 4) !== 'GGUF') return null;
    const rd = new GgufReader(buf);
    rd.pos = 4;
    const version = rd.u32();
    const tensorCount = rd.u64();
    const kvCount = rd.u64();

    const values = {};
    let arch = null;
    for (let i = 0; i < kvCount; i++) {
      const key = rd.str();
      const type = rd.u32();
      const interesting = GGUF_INTERESTING.includes(key)
        || (arch && key.startsWith(`${arch}.`) && GGUF_ARCH_SUFFIXES.some((s) => key.endsWith(s)))
        || (!arch && /^[a-z0-9_]+\.[a-z0-9_.]+$/.test(key) && GGUF_ARCH_SUFFIXES.some((s) => key.endsWith(s)));
      if (interesting && type !== 9) {
        let value;
        try { value = ggufValue(rd, type); } catch { break; }
        values[key] = value;
        if (key === 'general.architecture') arch = String(value);
      } else {
        try { skipGgufValue(rd, type); } catch { break; }
      }
    }
    return {
      version,
      tensorCount,
      kvCount,
      arch: values['general.architecture'] || null,
      name: values['general.name'] || null,
      quant: GGUF_FILE_TYPES[values['general.file_type']] || null,
      values,
    };
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Sidecar metadata (Civitai helper etc.)
// ---------------------------------------------------------------------------

export async function readSidecars(absPath) {
  const ext = path.extname(absPath);
  const base = absPath.slice(0, -ext.length);
  const candidates = [
    `${absPath}.civitai.info`,
    `${base}.civitai.info`,
    `${absPath}.json`,
    `${base}.json`,
    `${absPath}.metadata.json`,
  ];
  for (const p of candidates) {
    const data = await readJsonSafe(p);
    if (!data || typeof data !== 'object') continue;
    const looksLikeCivitai = data.baseModel || data.model || data.trainedWords || data.modelId;
    const looksLikeModel = data.baseModel || data.architecture || data.model_name || data.name;
    if (looksLikeCivitai || looksLikeModel) return data;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function normBaseFromMetadata(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  for (const [re, id] of META_BASE_RULES) if (re.test(s)) return id;
  for (const [re, id] of BASE_RULES) if (re.test(s)) return id;
  return null;
}

export function detectBaseFromText(text) {
  if (!text) return null;
  for (const [re, id] of BASE_RULES) if (re.test(text)) return id;
  return null;
}

function detectVersion(fileName, sidecar) {
  const sidecarVersion = sidecar?.versionName || sidecar?.version?.name;
  if (sidecarVersion && String(sidecarVersion).trim()) return String(sidecarVersion).trim();
  const matches = String(fileName).match(/(?:^|[_\-. ])(v(?:er(?:sion)?[ _.-]?)?\d+(?:[._]\d+)*)/gi);
  if (matches?.length) return matches[matches.length - 1].replace(/^[_\-. ]/, '').trim();
  const q = String(fileName).match(QUANT_RE);
  if (q) return q[1].toUpperCase();
  return null;
}

function detectCategory({ ext, nameText, tensorKeys, meta, gguf }) {
  if (gguf) {
    const arch = (gguf.arch || '').toLowerCase();
    if (arch.includes('stable-diffusion') || arch === 'sd-xl' || arch === 'flux') return 'checkpoint';
    if (arch.includes('clip')) return 'clip';
    return 'llm';
  }

  const keys = tensorKeys || [];
  if (keys.length) {
    if (keys.some((k) => /lora[_.](down|up|a|b|te)|hada_w[12]_[ab]|lokr_|dora_scale|diff_b/i.test(k))) return 'lora';
    if (keys.some((k) => /input_hint_block|controlnet_cond_embedding|zero_convs|control_model/i.test(k))) return 'controlnet';
    if (keys.some((k) => /^first_stage_model\.|^vae\.|encoder\.down_blocks|decoder\.up_blocks/i.test(k)) && !keys.some((k) => /diffusion_model/i.test(k))) return 'vae';
  }
  if (meta?.ss_network_module || meta?.['modelspec.architecture']?.toLowerCase().includes('lora')) return 'lora';

  const n = nameText || '';
  for (const [re, cat] of NAME_RULES) if (re.test(n)) return cat;

  if (keys.length) {
    if (keys.some((k) => /model\.diffusion_model\.|first_stage_model\./i.test(k))) return 'checkpoint';
    if (keys.some((k) => /conditioner\.|cond_stage_model\./i.test(k))) return 'clip';
  }
  if (ext === '.onnx') return 'onnx';
  if (ext === '.ckpt') return 'checkpoint';
  return 'other';
}

/**
 * Analyze one model file. `stat` must be provided.
 * Returns the DB-ready description of the file.
 */
export async function analyzeFile({ absPath, size, ext }) {
  const fileName = path.basename(absPath);
  const relHint = path.basename(path.dirname(absPath));
  const nameText = `${relHint} ${fileName}`.toLowerCase();

  let safetensors = null;
  let gguf = null;
  if (ext === '.safetensors' || ext === '.sft') safetensors = await readSafetensorsHeader(absPath);
  if (ext === '.gguf' || ext === '.ggml') gguf = await readGgufHeader(absPath);

  const sidecar = await readSidecars(absPath);
  const meta = safetensors?.meta || {};

  const category = detectCategory({ ext, nameText, tensorKeys: safetensors?.tensorKeys, meta, gguf });

  let base =
    normBaseFromMetadata(meta['ss_base_model_version'])
    || normBaseFromMetadata(meta['modelspec.architecture'])
    || normBaseFromMetadata(sidecar?.baseModel)
    || (gguf?.arch ? (GGUF_ARCH[gguf.arch.toLowerCase()] || detectBaseFromText(gguf.arch)) : null)
    || detectBaseFromText(nameText);

  // A "Pony" or "Illustrious" filename is more specific than a generic SDXL
  // metadata tag: keep the wide family but refine the displayed base.
  const nameBase = detectBaseFromText(nameText);
  if (['sdxl', 'sd15'].includes(base) && ['pony', 'illustrious', 'noobai'].includes(nameBase)) {
    base = nameBase;
  }

  // Refine obvious cases: a LoRA named "pony" on an unknown base is SDXL-family.
  if (!base && category === 'lora') base = null;

  const version = detectVersion(fileName, sidecar) || gguf?.quant || null;

  const title =
    meta['modelspec.title']
    || meta['ss_output_name']
    || gguf?.name
    || (sidecar?.model?.name && sidecar?.version?.name ? `${sidecar.model.name} — ${sidecar.version.name}` : sidecar?.model?.name)
    || cleanTitle(fileName);

  const tags = [];
  if (Array.isArray(sidecar?.trainedWords)) tags.push(...sidecar.trainedWords.slice(0, 30));
  if (Array.isArray(sidecar?.model?.tags)) tags.push(...sidecar.model.tags.slice(0, 20));
  if (gguf?.quant) tags.push(gguf.quant);
  if (meta['ss_network_module']) tags.push(String(meta['ss_network_module']));

  const summary = {};
  if (safetensors) {
    summary.format = 'safetensors';
    summary.tensors = safetensors.tensorKeys.length;
    if (meta['ss_network_module']) summary.networkModule = String(meta['ss_network_module']);
    if (meta['ss_network_dim']) summary.networkDim = Number(meta['ss_network_dim']);
    if (meta['ss_network_alpha']) summary.networkAlpha = Number(meta['ss_network_alpha']);
    if (meta['ss_base_model_version']) summary.baseModelRaw = String(meta['ss_base_model_version']);
    if (meta['modelspec.architecture']) summary.architecture = String(meta['modelspec.architecture']);
    if (meta['ss_sd_model_name']) summary.trainedOn = String(meta['ss_sd_model_name']);
  }
  if (gguf) {
    summary.format = 'gguf';
    summary.gguf = {
      version: gguf.version,
      arch: gguf.arch,
      name: gguf.name,
      tensors: gguf.tensorCount,
      quant: gguf.quant,
      contextLength: gguf.values[`${gguf.arch}.context_length`] ?? null,
      blockCount: gguf.values[`${gguf.arch}.block_count`] ?? null,
      embeddingLength: gguf.values[`${gguf.arch}.embedding_length`] ?? null,
      parameterCount: gguf.values['general.parameter_count'] ?? null,
      expertCount: gguf.values[`${gguf.arch}.expert_count`] ?? null, // > 1 : modèle MoE (ce que PAIZ sait streamer)
      expertUsed: gguf.values[`${gguf.arch}.expert_used_count`] ?? null,
    };
  }
  if (sidecar) {
    summary.sidecar = {
      modelName: sidecar.model?.name || null,
      versionName: sidecar.versionName || sidecar.version?.name || null,
      baseModel: sidecar.baseModel || null,
      modelId: sidecar.modelId || sidecar.model?.id || null,
      sha256: sidecar.sha256 || null,
    };
  }

  return {
    category,
    base_model: base,
    base_family: baseFamily(base),
    title: String(title).slice(0, 300),
    version: version ? String(version).slice(0, 100) : null,
    format: ext.replace('.', '') || null,
    tags: [...new Set(tags.map(String))].slice(0, 40),
    meta: summary,
  };
}

export function categoryLabel(id) {
  return CATEGORIES.find((c) => c.id === id)?.short || id;
}
