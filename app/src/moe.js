// MoE ou dense ? Le streaming de PAIZ porte sur les EXPERTS des modèles MoE (seule une petite partie du modèle sert à chaque mot).
// Un modèle dense utilise tous ses poids à chaque mot : rien à streamer, PAIZ ne l'allège pas.
// Source sûre : l'en-tête GGUF (<arch>.expert_count). Pour un modèle en ligne (pas encore téléchargé), on devine d'après le nom.
import { readGgufHeader } from './detect.js';
import { getSetting, setSetting, queryAssets } from './db.js';

const KEY = 'models.moe'; // cache : « nom|taille » -> { moe, experts, used, arch }
const rd = (db) => { try { return JSON.parse(getSetting(db, KEY, '{}')) || {}; } catch { return {}; } };

/** D'après le nom (modèles en ligne) : true = MoE, false = probablement dense, null = on ne sait pas. */
export function guessMoeFromName(name) {
  const n = String(name || '');
  if (/(^|[-_ .])A\d+(\.\d+)?B([-_ .]|$)|\bMoE\b|mixtral|\d+x\d+B|gpt-oss|qwen3-next|qwen3-coder-next|glm-4\.5|glm-4\.6|deepseek-?v[23]|deepseek-r1|olmoe|granite.*moe|lfm2-8b-a1b|ernie.*a\d+b|kimi-k2|minimax-m|llama-?4|dbrx|jamba|phi-3\.5-moe|hunyuan-a/i.test(n)) return true;
  if (/mmproj|clip|vae|lora/i.test(n)) return null;
  return null;
}

/** Pour chaque modèle .gguf du catalogue : { id: { moe, experts, used, arch } }. Lit l'en-tête GGUF une fois, puis garde le résultat. */
export async function moeMap(db) {
  const cache = rd(db); let changed = false; const out = {};
  const items = queryAssets(db, { q: '.gguf', limit: 5000 }).items.filter((a) => /\.gguf$/i.test(a.file_name) && !/mmproj/i.test(a.file_name) && a.state === 'present');
  for (const a of items) {
    const k = `${a.file_name.toLowerCase()}|${a.size_bytes}`;
    let v = cache[k];
    if (!v) {
      try {
        const h = await readGgufHeader(a.abs_path);
        const arch = h?.arch || null; const ex = Number(h?.values?.[`${arch}.expert_count`] || 0); const used = Number(h?.values?.[`${arch}.expert_used_count`] || 0);
        v = { moe: ex > 1, experts: ex || null, used: used || null, arch };
      } catch { v = { moe: guessMoeFromName(a.file_name) === true, experts: null, used: null, arch: null, guessed: true }; }
      cache[k] = v; changed = true;
    }
    out[a.id] = v;
  }
  if (changed) setSetting(db, KEY, JSON.stringify(cache));
  return out;
}
