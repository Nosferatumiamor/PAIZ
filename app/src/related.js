// « Modèles liés » : quel modèle sert à quel autre (encodeur de texte, VAE, CLIP vision, module d'image…).
// Suggestions déduites des NOMS de fichiers (aucune information de ce genre dans les fichiers eux-mêmes) : une table de familles, à corriger au fil de l'eau.
import { queryAssets, getAsset } from './db.js';
import { inodeKey } from './dedupe.js';

// main : modèles principaux de la famille ; needs : éléments dont ils ont besoin (nom de fichier)
export const FAMILIES = [
  { name: 'Flux 2 Klein', main: /flux[-_ ]?2.*klein|klein.*flux/i, needs: [/^qwen_3_4b\b/i, /flux2[-_]vae/i] },
  { name: 'Flux 1', main: /^flux1|flux[-_.]1|fluxdev|flux_dev|flux-dev|^flux(?![-_ ]?2)/i, needs: [/^clip_l\b/i, /^t5xxl/i, /^ae\.safetensors$/i] },
  { name: 'Wan', main: /\bwan\b|wan2|wan_2|wan[-_]?2\.[12]/i, needs: [/umt5/i, /wan.*vae|vae.*wan/i, /^clip_vision_h/i, /xlm-roberta/i] },
  { name: 'Qwen Image', main: /qwen[-_ ]image/i, needs: [/^qwen_2\.5_vl|qwen2\.5[-_]vl/i, /^qwen_vae|qwen[-_]image.*vae/i, /^qwen_3_8b\b/i] },
  { name: 'HunyuanVideo', main: /hunyuan/i, needs: [/hunyuan.*vae/i, /^clip_l\b/i, /llava|llm/i] },
  { name: 'LTX Video', main: /ltx/i, needs: [/^ltxv_vae/i, /^t5xxl/i] },
  { name: 'SDXL / Pony', main: /sdxl|pony|xl[-_]?v?\d|realvisxl|juggernaut/i, needs: [/^sdxl_vae/i, /^clip_l\b/i, /^clip_g\b/i] },
];
// Rôle des accessoires connus, d'après leur nom : à quoi ils servent, et quels modèles principaux en ont besoin (`mains`).
// Si aucun modèle principal de ce type n'est présent sur tes disques, l'accessoire est un candidat sûr à la corbeille.
export const ACCESSORY_ROLES = [
  { re: /^gemma[-_]3[-_]12b/i, role: 'Encodeur de texte Gemma 3 12B', who: 'LTX-2 (vidéo + audio)', mains: /ltx/i },
  { re: /^llava[-_]llama3.*vision/i, role: 'Encodeur d’image LLaVA', who: 'HunyuanVideo (image → vidéo)', mains: /hunyuan/i },
  { re: /^llava[-_]llama3/i, role: 'Encodeur de texte LLaVA-Llama3', who: 'HunyuanVideo', mains: /hunyuan/i },
  { re: /^qwen[-_]3[-_]4b/i, role: 'Encodeur de texte Qwen3 4B', who: 'Flux 2 Klein, Z-Image', mains: /klein|z[-_ ]?image/i },
  { re: /^qwen[-_]3[-_]8b/i, role: 'Encodeur de texte Qwen3 8B', who: 'Flux 2 Klein 9B, Qwen Image', mains: /klein|flux[-_ ]?2|qwen[-_ ]?image/i },
  { re: /^qwen[-_](2\.5[-_]vl|vae)|qwen[-_]image.*vae/i, role: 'Encodeur / VAE Qwen Image', who: 'Qwen Image', mains: /qwen[-_ ]?image/i },
  { re: /umt5/i, role: 'Encodeur de texte UMT5-XXL', who: 'Wan 2.1 / 2.2', mains: /wan|wan[-_]?2/i },
  { re: /t5xxl/i, role: 'Encodeur de texte T5-XXL', who: 'Flux 1, SD3, LTX Video, Chroma', mains: /flux|sd3|ltx|chroma/i },
  { re: /^clip[-_]vision|clip[-_]vit[-_]h|laion2b/i, role: 'Encodeur d’image CLIP-ViT-H', who: 'Wan image → vidéo, IP-Adapter', mains: /wan|wan[-_]?2|ip[-_]?adapter/i },
  { re: /^clip[-_][lg]/i, role: 'Encodeur de texte CLIP', who: 'SDXL, Pony, Flux 1', mains: /sdxl|pony|xl|flux/i },
  { re: /ip[-_]adapter/i, role: 'IP-Adapter (image comme consigne)', who: 'SDXL / Pony', mains: /sdxl|pony|xl/i },
  { re: /controlnet|xinsir|openpose|scribble|canny|depth/i, role: 'ControlNet (guide par pose / contour)', who: 'SDXL / Pony', mains: /sdxl|pony|xl/i },
  { re: /ltxv?[-_]vae/i, role: 'VAE LTX Video', who: 'LTX Video / LTX-2', mains: /ltx/i },
  { re: /hunyuan.*vae/i, role: 'VAE HunyuanVideo', who: 'HunyuanVideo', mains: /hunyuan/i },
  { re: /flux[-_]?2[-_]vae/i, role: 'VAE Flux 2', who: 'Flux 2 Klein', mains: /flux[-_ ]?2|klein/i },
  { re: /flux.*(autoencoder|vae)|^ae\.safetensors$/i, role: 'VAE Flux 1', who: 'Flux 1', mains: /flux/i },
  { re: /wan.*vae/i, role: 'VAE Wan', who: 'Wan 2.1 / 2.2', mains: /wan|wan[-_]?2/i },
  { re: /sdxl.*vae|vae.*sdxl|vaeFinalPrune|vaeFtMse|vae[-_]ft[-_]mse/i, role: 'VAE image', who: 'SDXL / Pony / SD 1.5', mains: /sdxl|pony|xl|sd[-_ ]?1/i },
];
const isMmproj = (n) => /^mmproj/i.test(n);
const mmBase = (n) => n.replace(/^mmproj[-_]?/i, '').replace(/[-_.](F16|BF16|F32|Q\d\w*)\.gguf$/i, '').replace(/\.gguf$/i, '').toLowerCase();
const llmBase = (n) => n.replace(/[-_.](Q\d\w*|I?Q\d\w*|BF16|F16|F32|MXFP4)\.gguf$/i, '').replace(/\.gguf$/i, '').toLowerCase();

/** { uses:[assets que celui-ci utilise], usedBy:[assets qui l'utilisent], same:[mêmes fichiers ailleurs] } */
export function relatedTo(db, id) {
  const a = getAsset(db, id); if (!a) throw new Error('Modèle inconnu.');
  const all = queryAssets(db, { limit: 5000 }).items.filter((x) => x.id !== a.id && x.state === 'present');
  const slim = (x) => ({ id: x.id, name: x.title || x.file_name, file: x.file_name, size: x.size_bytes, root: x.root_name });
  const uses = new Map(); const usedBy = new Map(); const reasons = new Map();
  const add = (m, x, why) => { m.set(x.id, slim(x)); reasons.set(x.id, why); };
  const n = a.file_name;
  // module d'image d'un modèle de langage (mmproj) ↔ son modèle
  if (isMmproj(n)) { const b = mmBase(n); for (const x of all) if (/\.gguf$/i.test(x.file_name) && !isMmproj(x.file_name) && llmBase(x.file_name) === b) add(usedBy, x, 'module d’image de ce modèle'); }
  else if (/\.gguf$/i.test(n)) { const b = llmBase(n); for (const x of all) if (isMmproj(x.file_name) && mmBase(x.file_name) === b) add(uses, x, 'module d’image (vision)'); }
  for (const f of FAMILIES) {
    if (f.main.test(n) && !f.needs.some((r) => r.test(n))) for (const x of all) if (f.needs.some((r) => r.test(x.file_name)) && !f.main.test(x.file_name)) add(uses, x, `utilisé par la famille ${f.name} (d’après le nom)`);
    if (f.needs.some((r) => r.test(n))) for (const x of all) if (f.main.test(x.file_name) && !f.needs.some((r) => r.test(x.file_name))) add(usedBy, x, `famille ${f.name} (d’après le nom)`);
  }
  const key = inodeKey(a.abs_path);
  const same = all.filter((x) => x.file_name.toLowerCase() === n.toLowerCase() && x.size_bytes === a.size_bytes)
    .map((x) => ({ ...slim(x), path: x.abs_path, linked: !!key && inodeKey(x.abs_path) === key }));
  const out = (m) => [...m.values()].map((x) => ({ ...x, why: reasons.get(x.id) }));
  // verdict pour un accessoire reconnu : y a-t-il, sur tes disques, un modèle principal qui s'en sert ?
  const rule = ACCESSORY_ROLES.find((r) => r.re.test(n));
  let role = null;
  if (rule) {
    const isAcc = (x) => ACCESSORY_ROLES.some((r) => r.re.test(x.file_name)) || /mmproj/i.test(x.file_name);
    const mains = all.filter((x) => !isAcc(x) && x.category !== 'lora' && rule.mains.test(`${x.title || ''} ${x.file_name}`) && x.size_bytes > 1.5 * 1024 ** 3).map(slim);
    role = { role: rule.role, who: rule.who, mains: mains.slice(0, 12), orphan: !mains.length };
  }
  return { uses: out(uses), usedBy: out(usedBy), same, role, note: 'Suggestions déduites des noms de fichiers : à prendre comme un repère, pas comme une certitude.' };
}
