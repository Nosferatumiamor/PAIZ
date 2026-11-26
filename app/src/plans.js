// « Faire un plan » : après une discussion, un modèle (Gemma, Qwen…) rédige le plan d'une tâche. C'est une tâche de type « plan » en file ;
// à la fin, le plan devient un brouillon dans la barre des tâches (voir tasks.js). Ici : le message envoyé au modèle qui rédige.
import { addTask } from './tasks.js';

const MAX_DISCUSSION = 14_000; // caractères de discussion transmis (les plus récents)

export function buildPlanPrompt({ title = '', messages = [], ideas = [], notes = '' }) {
  const lines = [];
  lines.push('Tu rédiges le PLAN d’une tâche confiée ensuite à un assistant de programmation. À partir de la discussion et des idées ci-dessous, produis un plan clair, concret et directement exécutable, en français, en Markdown, avec ces rubriques :');
  lines.push('1. **Objectif** (2 ou 3 phrases) ; 2. **Choix retenus** (langage, bibliothèques, interface…) ; 3. **Étapes** numérotées, courtes, dans l’ordre ; 4. **Livrables** (fichiers à produire) ; 5. **Critères de réussite** ; 6. **Points à préciser** (seulement s’il en reste).');
  lines.push('N’écris pas le code, seulement le plan. Ne recopie pas la discussion. Si la discussion hésite entre plusieurs options, garde celle que l’utilisateur a retenue en dernier.');
  if (String(title).trim()) lines.push('\n## Sujet\n' + String(title).trim());
  let disc = (messages || []).filter((m) => m && String(m.text || '').trim()).map((m) => (m.role === 'user' ? '[Utilisateur] ' : '[Assistant] ') + String(m.text).trim());
  let text = disc.join('\n\n');
  if (text.length > MAX_DISCUSSION) text = '[…]\n' + text.slice(text.length - MAX_DISCUSSION);
  if (text) lines.push('\n## Discussion\n' + text);
  const idl = (ideas || []).filter((i) => i && i.title).map((i) => '- **' + i.title + '**' + (i.body ? ' : ' + String(i.body).trim().replace(/\n+/g, ' ') : ''));
  if (idl.length) lines.push('\n## Idées du projet à prendre en compte\n' + idl.join('\n'));
  if (String(notes).trim()) lines.push('\n## Notes de l’utilisateur\n' + String(notes).trim());
  return lines.join('\n');
}

// « To-do par la parole » : l'utilisateur dit ce qu'il veut noter (« résume nos idées », « note ça »…), un modèle produit les éléments.
export function buildNotesPrompt({ instruction = '', messages = [], existing = [] }) {
  const L = [];
  L.push('Tu tiens la To-do (bloc-notes d’idées) d’un projet, en français. Exécute la consigne de l’utilisateur à partir de la discussion et des notes déjà présentes.');
  L.push('Réponds UNIQUEMENT par un tableau JSON, sans texte autour : [{"title":"titre court","body":"fiche explicative en quelques phrases"}]. Un élément par idée ou décision distincte. Si la consigne demande un résumé, un cahier des charges ou une synthèse, produis un seul élément dont "body" est ce document, structuré (Markdown). N’invente rien qui ne soit dans la discussion ou la consigne ; ne recopie pas les notes déjà présentes.');
  L.push('\n## Consigne de l’utilisateur\n' + String(instruction).trim());
  let text = (messages || []).filter((m) => m && String(m.text || '').trim()).map((m) => (m.role === 'user' ? '[Utilisateur] ' : '[Assistant] ') + String(m.text).trim()).join('\n\n');
  if (text.length > MAX_DISCUSSION) text = '[…]\n' + text.slice(text.length - MAX_DISCUSSION);
  if (text) L.push('\n## Discussion\n' + text);
  const ex = (existing || []).filter((i) => i && i.title).map((i) => '- ' + i.title + (i.body ? ' : ' + String(i.body).replace(/\n+/g, ' ').slice(0, 160) : ''));
  if (ex.length) L.push('\n## Notes déjà présentes\n' + ex.join('\n'));
  return L.join('\n');
}
export function createNotes(db, b) {
  if (!String(b.instruction || '').trim()) throw new Error('Dis ce que tu veux noter.');
  const spec = buildNotesPrompt({ instruction: b.instruction, messages: b.messages, existing: b.existing });
  return addTask(db, { title: 'To-do : ' + String(b.instruction).trim().slice(0, 50), spec, maxTokens: 4000, source: 'notes', model: b.model || 'chat', kind: 'notes', planTitle: String(b.instruction).trim().slice(0, 60), project: b.project });
}
export function createPlan(db, b) {
  const spec = buildPlanPrompt({ title: b.title, messages: b.messages, ideas: b.ideas, notes: b.notes });
  const title = String(b.title || '').trim() || 'Plan';
  return addTask(db, { title: 'Plan : ' + title, spec, maxTokens: 6000, source: 'plan', model: b.model || 'chat', kind: 'plan', execModel: b.execModel || 'chat', planTitle: title });
}
