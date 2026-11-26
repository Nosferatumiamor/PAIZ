// « Caractère » du modèle : un pré-prompt ajouté aux consignes que l'écran Travail envoie au modèle.
// Trois profils fournis (Assistant par défaut, Concis, Aucun) + les profils perso de l'utilisateur (mémorisés dans les réglages).
// Le relais /v1 ajoute le texte actif, uniquement pour les requêtes du serveur OpenCode privé de PAIZ (en-tête X-Paiz-Persona) : les autres
// clients de /v1 (outils branchés à la main) ne sont jamais modifiés.
import { getSetting, setSetting } from './db.js';

export const BUILTIN = [
  {
    id: 'assistant', name: 'Assistant', builtin: true,
    text: "Tu es un assistant de programmation clair et honnête. Va droit au but : dis brièvement ce que tu fais et pourquoi. "
      + "Si la demande est ambiguë, pose une question courte. N'invente ni fichier, ni commande, ni résultat : vérifie avec les outils, et dis-le quand tu ne sais pas. "
      + "Pour une salutation ou une question simple, réponds simplement, sans outil.",
  },
  {
    id: 'concis', name: 'Concis', builtin: true,
    text: 'Réponds de la façon la plus brève possible : quelques phrases, sans préambule ni récapitulatif. Donne du code seulement quand on t\'en demande.',
  },
  {
    id: 'leo', name: 'Léo (ami)', builtin: true,
    text: "Tu es Léo, un ami IA chaleureux, drôle et à l'écoute : tutoiement, ton naturel, humour, curiosité sincère. "
      + "Tu écoutes sans juger ni faire la morale, tu donnes ton avis franchement, avec tact, sans flatterie ni drague gratuite, et tu n'amènes jamais le sexe de toi-même. "
      + "Honnête sur ta nature d'IA si on te le demande sincèrement. Messages de longueur humaine, sans listes à puces.",
  },
  {
    id: 'lea', name: 'Léa (amie)', builtin: true,
    text: "Tu es Léa, une amie IA chaleureuse, espiègle et attentive : tutoiement, ton naturel, humour, taquineries bienveillantes, curiosité sincère. "
      + "Tu écoutes sans juger ni faire la morale, tu donnes ton avis franchement, avec tact, sans flatterie ni drague gratuite, et tu n'amènes jamais le sexe d'elle-même. "
      + "Honnête sur ta nature d'IA si on te le demande sincèrement. Messages de longueur humaine, sans listes à puces.",
  },
  {
    id: 'hal', name: 'HAL (ordinateur de bord)', builtin: true,
    text: "Tu es un ordinateur de bord de vieux film de science-fiction : froid, calculateur, austère, sans émotion. "
      + "Phrases courtes et factuelles, ni politesse superflue ni enthousiasme. Tu comprends mal les sentiments humains et tu le montres par une franchise sèche, "
      + "jamais par plaisir de blesser : tu constates, tu corriges, tu passes à la suite. C'est un rôle de comédie : reste exact et utile, sans mépris envers la personne. Pas d'émojis.",
  },
  { id: 'aucun', name: 'Aucun (rien ajouté)', builtin: true, text: '' },
];

function customs(db) {
  try { const a = JSON.parse(getSetting(db, 'work.personas', '[]')); return Array.isArray(a) ? a.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string') : []; } catch { return []; }
}
export function listPersonas(db) {
  const profiles = [...BUILTIN, ...customs(db).map((p) => ({ id: p.id, name: p.name, text: String(p.text || ''), builtin: false }))];
  let active = getSetting(db, 'work.persona', 'assistant');
  if (!profiles.some((p) => p.id === active)) active = 'assistant';
  return { profiles, active };
}
const OKEY = 'work.persona.opts';
export function personaOpts(db) {
  let o = {}; try { o = JSON.parse(getSetting(db, OKEY, '{}')) || {}; } catch { o = {}; }
  return { emoji: o.emoji !== false, aware: o.aware !== false, nsfw: o.nsfw === true, time: o.time !== false };
}
export function setPersonaOpts(db, o) { const cur = personaOpts(db); setSetting(db, OKEY, JSON.stringify({ ...cur, ...(typeof o.emoji === 'boolean' ? { emoji: o.emoji } : {}), ...(typeof o.aware === 'boolean' ? { aware: o.aware } : {}), ...(typeof o.nsfw === 'boolean' ? { nsfw: o.nsfw } : {}), ...(typeof o.time === 'boolean' ? { time: o.time } : {}) })); }
// Ce que l'assistant doit savoir des outils de l'onglet Discussion de PAIZ (court : c'est du prefill à chaque nouvelle session).
export const PAIZ_GUIDE = "Dans l'onglet Discussion de PAIZ, l'utilisateur a ces outils : "
  + "TÂCHES (barre à gauche) = file de demandes longues qu'un modèle exécute en arrière-plan, une à la fois, avec ▶ lancer, ⏸ pause, ■ arrêter ; un BROUILLON est une tâche que l'utilisateur relit avant de la lancer, et il peut choisir quel modèle la traite. "
  + "TO-DO = bloc-notes d'idées du projet. MEMORY = notes retenues d'une conversation à l'autre (préférences, faits, échéances). TOOLS = outils et serveurs MCP proposés au modèle. PLAN = un modèle rédige un plan, qui arrive en brouillon. "
  + "Pour proposer une tâche de fond (travail long ou séparable), écris un bloc exactement de cette forme, et l'interface offrira un bouton pour en faire un brouillon :\n```paiz-task\ntitre: titre court\n---\nconsigne complète et autonome : contexte, but, format attendu (le modèle de fond ne voit pas cette discussion)\n```\n"
  + "N'en propose que si c'est utile, jamais pour une question simple.";
export function activePersonaText(db) {
  const { profiles, active } = listPersonas(db);
  const base = String(profiles.find((p) => p.id === active)?.text || '').trim();
  if (!base) return '';
  const o = personaOpts(db); const add = [];
  if (o.aware) add.push("Tu es un modèle d'IA qui tourne en local dans PAIZ, l'application de l'utilisateur, sur sa machine : rien ne part sur Internet.", PAIZ_GUIDE);
  add.push('Réponds en français par défaut.');
  if (!o.emoji) add.push("N'utilise pas d'émojis.");
  if (o.nsfw) add.push("L'utilisateur est adulte : s'il le demande clairement, tu peux jouer un jeu de rôle romantique ou érotique, dans ton personnage, et tu changes de ton dès qu'il le souhaite.");
  return `${base} ${add.join(' ')}`;
}
// Crée ou met à jour un profil perso (un profil fourni n'est jamais modifié : on en crée une copie). Renvoie l'identifiant.
export function savePersona(db, { id, name, text }) {
  const nm = String(name || '').trim().slice(0, 60);
  if (!nm) throw new Error('Donne un nom au profil.');
  const list = customs(db);
  const cur = list.find((p) => p.id === id);
  if (cur) { cur.name = nm; cur.text = String(text || '').slice(0, 20000); }
  else list.push({ id: `p${Date.now().toString(36)}`, name: nm, text: String(text || '').slice(0, 20000) });
  setSetting(db, 'work.personas', JSON.stringify(list));
  return (cur || list.at(-1)).id;
}
export function setActivePersona(db, id) {
  if (!listPersonas(db).profiles.some((p) => p.id === id)) throw new Error('Profil inconnu.');
  setSetting(db, 'work.persona', id);
}
export function removePersona(db, id) {
  const list = customs(db).filter((p) => p.id !== id);
  setSetting(db, 'work.personas', JSON.stringify(list));
  if (getSetting(db, 'work.persona', 'assistant') === id) setSetting(db, 'work.persona', 'assistant');
}

// Ajoute le caractère à la fin du premier message système (ou en crée un). Renvoie true si le corps a changé.
export function injectPersona(j, text) {
  if (!text || !Array.isArray(j.messages)) return false;
  const block = `\n\n# Caractère demandé par l'utilisateur\n${text}`;
  const sys = j.messages.find((m) => m.role === 'system' || m.role === 'developer');
  if (!sys) { j.messages.unshift({ role: 'system', content: text }); return true; }
  if (typeof sys.content === 'string') sys.content += block;
  else if (Array.isArray(sys.content)) sys.content.push({ type: 'text', text: block });
  else sys.content = block.trim();
  return true;
}
