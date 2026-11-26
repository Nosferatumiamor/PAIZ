// Conscience du temps : le modèle sait l'heure, le jour, depuis quand on discute et s'il y a eu une absence.
// Une ligne courte collée à la FIN du dernier message de l'utilisateur (pas dans les consignes : le début du prompt ne change pas,
// le cache du moteur reste valable). Le suivi d'une conversation se fait par son premier message (aucun identifiant n'est transmis).
import crypto from 'node:crypto';

const GAP_MIN = 45 * 60 * 1000;          // absence qui vaut la peine d'être signalée
const SESSION_BREAK = 30 * 60 * 1000;    // au-delà, la « séance » repart de zéro
const LONG = 2 * 3600 * 1000;            // une séance longue : on peut évoquer une pause…
const NUDGE_EVERY = 2 * 3600 * 1000;     // … au plus une fois toutes les 2 h
const convs = new Map();                 // empreinte de la conversation -> { start, last, users, nudged }

const flat = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : '');
const part = (h) => (h < 5 ? 'en pleine nuit' : h < 12 ? 'le matin' : h < 14 ? 'à midi' : h < 18 ? "l'après-midi" : h < 22 ? 'le soir' : 'tard le soir');
const dur = (ms) => { const m = Math.round(ms / 60000); if (m < 60) return `${m} min`; const h = Math.floor(m / 60); const r = m % 60; return r ? `${h} h ${String(r).padStart(2, '0')}` : `${h} h`; };

/** La ligne de temps pour cette requête (et met à jour le suivi de la conversation). '' si rien à dire (pas de message utilisateur). */
export function timeNote(messages, now = Date.now()) {
  const users = (messages || []).filter((m) => m.role === 'user');
  if (!users.length) return '';
  const key = crypto.createHash('sha1').update(flat(users[0].content).slice(0, 2000)).digest('hex').slice(0, 16);
  let c = convs.get(key);
  const fresh = !c || users.length > c.users; // un nouveau message de l'utilisateur (pas une relance du même tour)
  if (!c) c = { start: now, last: now, users: 0, nudged: 0 };
  const gap = now - c.last;
  if (fresh) { if (gap > SESSION_BREAK) c.start = now; c.users = users.length; c.last = now; }
  if (convs.size > 500) convs.delete(convs.keys().next().value);
  convs.set(key, c);

  const d = new Date(now);
  const bits = [`Repère de temps : ${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${d.getHours()} h ${String(d.getMinutes()).padStart(2, '0')} (${part(d.getHours())}).`];
  if (fresh && users.length > 1 && gap >= GAP_MIN) bits.push(`Il revient après ${dur(gap)} sans écrire.`);
  const session = now - c.start;
  if (fresh && session >= LONG && now - c.nudged >= NUDGE_EVERY) {
    bits.push(`Vous échangez depuis ${dur(session)} : si ça tombe bien, tu peux demander une fois s'il veut continuer ou faire une pause, sans insister.`);
    c.nudged = now;
  }
  return `[${bits.join(' ')} Ne le répète pas, tiens-en compte seulement.]`;
}
