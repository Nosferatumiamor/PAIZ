// Choix des serveurs MCP par question (idée reprise d'AnythingLLM, « Intelligent Skill Selection ») : chaque serveur activé ajoute son
// catalogue d'outils au prompt (souvent des milliers de jetons, relus à chaque nouvelle session : c'est du prefill, notre goulot).
// On ne garde que les serveurs dont la conversation parle :
//   • son nom ou un synonyme connu (« blender », « 3d », « mesh »… ; « comfyui », « image », « workflow »…) → gardé ;
//   • sinon au moins deux mots distincts tirés de ses outils et de sa description → gardé ;
//   • un serveur déjà appelé plus tôt dans la conversation reste gardé.
// La sélection se calcule sur TOUS les messages de l'utilisateur : elle ne fait que grossir au fil de la conversation, donc le début
// du prompt reste identique (et en cache) tant que rien de nouveau n'est demandé. Réglage engine.mcpSelect = 'all' pour tout garder.

const SYN = {
  blender: ['blender', '3d', 'mesh', 'maillage', 'modelisation', 'modeliser', 'rig', 'rigging', 'uv', 'texture', 'materiau', 'shader', 'rendu', 'render', 'scene 3d', 'objet 3d', 'sculpt', 'bpy', 'fbx', 'gltf', 'glb', 'obj'],
  comfyui: ['comfy', 'comfyui', 'workflow', 'image', 'images', 'genere une image', 'dessine', 'illustration', 'stable diffusion', 'sdxl', 'flux', 'lora', 'checkpoint', 'upscale', 'inpaint', 'img2img', 'txt2img', 'photo'],
  godot: ['godot', 'gdscript', 'jeu', 'game', 'scene', 'node2d', 'node3d', 'tscn', 'sprite', 'niveau', 'level', 'joueur', 'player'],
  unity: ['unity', 'prefab', 'gameobject', 'c#', 'csharp', 'jeu', 'game'],
  web: ['web', 'internet', 'site', 'url', 'http', 'cherche en ligne', 'recherche en ligne', 'google', 'actualite', 'news'],
  exa: ['exa', 'cherche', 'recherche', 'search', 'web', 'internet', 'en ligne', 'actualite', 'news', 'documentation', 'site', 'url'],
  search: ['cherche', 'recherche', 'search', 'web', 'internet', 'en ligne', 'actualite', 'news'],
  github: ['github', 'pull request', 'pr ', 'issue', 'repo', 'depot', 'commit'],
  git: ['git', 'commit', 'branche', 'branch', 'merge', 'diff'],
  browser: ['navigateur', 'browser', 'page web', 'clique', 'site', 'onglet', 'chrome'],
  playwright: ['navigateur', 'browser', 'page web', 'clique', 'site', 'onglet', 'test e2e', 'playwright'],
  filesystem: ['fichier', 'dossier', 'file', 'folder'],
  memory: ['souviens', 'memoire', 'retiens', 'remember', 'memory'],
  sqlite: ['sql', 'sqlite', 'base de donnees', 'database', 'table', 'requete'],
  postgres: ['sql', 'postgres', 'base de donnees', 'database', 'requete'],
  figma: ['figma', 'maquette', 'design', 'ui'],
  krita: ['krita', 'peinture', 'dessin', 'calque'],
  gimp: ['gimp', 'retouche', 'calque', 'photo'],
  obs: ['obs', 'stream', 'enregistrement', 'scene obs'],
  spotify: ['spotify', 'musique', 'playlist', 'chanson'],
  youtube: ['youtube', 'video', 'transcription'],
};
const STOP = new Set('alors aussi avec avoir cette comme dans depuis elles entre faire leurs mais meme moins notre nous pour plus quand quel quelle sans sera sont sous tout toute tous tres votre vous with that this from into your have will only when then than them they what which while about after before other each also just like make more most some such use used using return returns value values string number object array tools tool call calls given list name names file files data true false null none default optional required'.split(' '));
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const words = (s) => fold(s).replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-z0-9#+]+/).filter((w) => w.length >= 5 && !STOP.has(w));

/** Texte de tous les messages de l'utilisateur (la sélection ne dépend que de lui : stable d'une requête à l'autre). */
export function userText(messages) {
  return fold((messages || []).filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((c) => c.text || '').join(' ') : '')).join('\n'));
}
/** Espaces de noms déjà appelés par le modèle (code passé à `execute`, ou outil MCP direct « ns_outil »). */
export function usedNamespaces(messages, names) {
  const used = new Set();
  for (const m of messages || []) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) {
      const fn = c.function?.name || ''; const a = String(c.function?.arguments || '');
      for (const n of names) if (a.includes(`tools.${n}.`) || fn === n || fn.startsWith(`${n}_`)) used.add(n);
    }
  }
  return used;
}
/** Le serveur `ns` (dont `text` décrit les outils) concerne-t-il la conversation ? Renvoie la raison, ou null. */
export function relevance(ns, text, utext) {
  const base = fold(ns).replace(/[-_](mcp|server)$/g, '').replace(/^mcp[-_]/, '');
  const syn = [base, ...base.split(/[-_]/).filter((x) => x.length >= 3), ...(SYN[base] || []), ...Object.entries(SYN).filter(([k]) => base.includes(k)).flatMap(([, v]) => v)];
  const hasWord = (w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(utext);
  const s = syn.find((w) => w && hasWord(w));
  if (s) return `« ${s} »`;
  const hits = [...new Set(words(text))].filter((w) => w !== base && hasWord(w));
  return hits.length >= 2 ? `« ${hits.slice(0, 2).join(' », « ')} »` : null;
}

let last = null; // dernière sélection (pour le panneau du budget d'outils)
export const lastPick = () => last;
/** Ce que le tri a réellement retiré du prompt (catalogue Code Mode + outils), noté par le relais après coup. */
export function noteSaved(chars) { if (last) { last.savedChars = chars; last.savedTok = Math.round(chars / 3.4); } }

/** Parmi les serveurs `enabled` ({ ns: texte du bloc }), ceux à garder pour cette conversation. */
export function pickNamespaces(blocks, messages, { mode = 'smart' } = {}) {
  const names = Object.keys(blocks);
  if (mode === 'all' || !names.length) { last = { kept: names.map((n) => ({ ns: n, why: 'tous gardés' })), dropped: [] }; return new Set(names); }
  const ut = userText(messages); const used = usedNamespaces(messages, names);
  const kept = []; const dropped = [];
  for (const n of names) {
    const why = used.has(n) ? 'déjà utilisé dans la conversation' : relevance(n, blocks[n], ut);
    (why ? kept : dropped).push({ ns: n, why: why || 'pas concerné par la conversation', chars: blocks[n].length });
  }
  last = { at: Date.now(), kept, dropped, savedChars: dropped.reduce((s, d) => s + d.chars, 0) };
  return new Set(kept.map((k) => k.ns));
}
