// OpenCode (cette version) décrit ses outils « Code Mode » (MCP, navigateur du bureau, gestion d'OpenCode…) dans une section « # Code Mode » du
// message système : ~11 000 caractères (≈ 3 000 jetons) relus à CHAQUE premier message, même quand l'outil `execute` qui permet de les
// appeler a été retiré par le filtre d'outils. On ne garde que les espaces de noms voulus (les serveurs MCP activés dans PAIZ) ; sans
// aucun, la section entière et l'outil `execute` disparaissent. Déterministe : le début du prompt reste stable entre deux messages.
const HEAD = '# Code Mode\n';

// Renvoie { saved, kept } ; modifie j (message système et liste d'outils). `keep` = Set des espaces de noms à garder.
export function trimCodeMode(j, keep = new Set()) {
  const msgs = Array.isArray(j?.messages) ? j.messages : [];
  const sys = msgs.find((m) => (m.role === 'system' || m.role === 'developer') && typeof m.content === 'string' && m.content.includes(HEAD));
  if (!sys) return { saved: 0, kept: [] };
  const text = sys.content;
  const i = text.indexOf(HEAD);
  const rest = text.slice(i);
  const nx = /\n# (?!#)/.exec(rest.slice(1)); // prochain titre de niveau 1 : fin de la section
  const end = nx ? 1 + nx.index : rest.length;
  const section = rest.slice(0, end);
  const after = rest.slice(end);
  const parts = section.split(/\n(?=- [\w-]+ \(\d+ tools?)/);
  const head = parts[0];
  const blocks = parts.slice(1);
  const nsOf = (b) => /^- ([\w-]+) \(/.exec(b)?.[1];
  const kept = blocks.filter((b) => keep.has(nsOf(b)));
  let out;
  if (!kept.length) {
    out = text.slice(0, i).replace(/\s+$/, '') + (after ? `\n${after.replace(/^\n+/, '')}` : '');
    if (Array.isArray(j.tools)) j.tools = j.tools.filter((t) => (t.function?.name || t.name) !== 'execute');
    if (j.tool_choice && typeof j.tool_choice === 'object' && j.tool_choice.function?.name === 'execute') delete j.tool_choice;
  } else out = text.slice(0, i) + [head, ...kept].join('\n') + after;
  const saved = text.length - out.length;
  sys.content = out;
  return { saved, kept: kept.map(nsOf) };
}

/** Blocs du catalogue Code Mode : { espace de noms: texte du bloc } (vide si le prompt n'en a pas). */
export function codeModeBlocks(j) {
  const sys = (Array.isArray(j?.messages) ? j.messages : []).find((m) => (m.role === 'system' || m.role === 'developer') && typeof m.content === 'string' && m.content.includes(HEAD));
  if (!sys) return {};
  const rest = sys.content.slice(sys.content.indexOf(HEAD));
  const nx = /\n# (?!#)/.exec(rest.slice(1));
  const section = rest.slice(0, nx ? 1 + nx.index : rest.length);
  const out = {};
  for (const b of section.split(/\n(?=- [\w-]+ \(\d+ tools?)/).slice(1)) { const ns = /^- ([\w-]+) \(/.exec(b)?.[1]; if (ns) out[ns] = b; }
  return out;
}
