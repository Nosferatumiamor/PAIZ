// Pastille de famille de modèle (Qwen, Gemma, Llama…), partagée par tous les écrans qui listent des modèles.
// Dessinée localement : aucune image n'est chargée depuis Internet. Premier motif trouvé dans le nom ; sinon pastille grise.
const FAMILIES = [
  ['qwen', 'Qw', '#7c5cff'], ['gemma', 'Ge', '#4285f4'], ['llama', 'Ll', '#0a84ff'], ['mistral', 'Mi', '#ff8a00'], ['mixtral', 'Mx', '#ff8a00'],
  ['deepseek', 'DS', '#3b6cf6'], ['glm', 'GL', '#14b8a6'], ['kimi', 'Ki', '#374151'], ['moonshot', 'Ki', '#374151'], ['minimax', 'MM', '#ef4444'],
  ['gpt-oss', 'OS', '#10a37f'], ['phi', 'Φ', '#00a4ef'], ['granite', 'Gr', '#0f62fe'], ['yi-', 'Yi', '#16a34a'], ['falcon', 'Fa', '#a16207'],
  ['smol', 'Sm', '#f59e0b'], ['starcoder', 'SC', '#22c55e'], ['codestral', 'Cs', '#ff8a00'], ['command-r', 'Co', '#d946ef'], ['nemotron', 'Nv', '#76b900'],
  ['hermes', 'He', '#a855f7'], ['mythomax', 'Mm', '#ec4899'], ['whisper', 'Wh', '#10a37f'], ['flux', 'Fl', '#6366f1'], ['stable-diffusion', 'SD', '#8b5cf6'], ['sdxl', 'SD', '#8b5cf6'],
];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function family(name) {
  const low = String(name || '').toLowerCase();
  for (const [k, label, color] of FAMILIES) if (low.includes(k)) return { label, color, known: true };
  const base = (String(name || '').split(/[\\/]/).pop() || '?').replace(/^[^a-z0-9]+/i, '');
  return { label: base.slice(0, 2).replace(/^./, (c) => c.toUpperCase()) || '?', color: '#64748b', known: false };
}
export const famBadge = (name) => { const f = family(name); return `<span class="fam" style="background:${f.color}" title="${f.known ? 'famille reconnue' : 'famille non reconnue'}">${esc(f.label)}</span>`; };
