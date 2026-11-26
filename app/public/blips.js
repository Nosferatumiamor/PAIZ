// Bips de dialogue façon jeux rétro (Punch-Out!!…) : chaque lettre qui s'affiche fait un petit son doux, à une hauteur qui varie.
// Chaque caractère a sa voix : plus ou moins aiguë, plus ou moins chantante (Léa vive et variée, HAL grave et monocorde…).
// Synthétisés en direct (Web Audio), aucun fichier son. Coupé par défaut ; réglages gardés dans ce navigateur.
const KEY = 'paiz.blips';
// f : hauteur de base (Hz) · jit : variété d'une lettre à l'autre · swing : irrégularité du débit · step : écart entre deux lettres (s)
const PRESETS = {
  lea: { f: 620, jit: 0.34, swing: 0.35, step: 0.034 },
  leo: { f: 390, jit: 0.24, swing: 0.3, step: 0.036 },
  assistant: { f: 480, jit: 0.14, swing: 0.15, step: 0.034 },
  concis: { f: 480, jit: 0.12, swing: 0.1, step: 0.03 },
  hal: { f: 250, jit: 0.015, swing: 0, step: 0.04 },
};
export const VOICES = {
  auto: { label: 'Voix d’origine du caractère' },
  grave: { label: 'Grave', f: 300, jit: 0.22, swing: 0.25, step: 0.036 },
  moyenne: { label: 'Moyenne', f: 470, jit: 0.22, swing: 0.25, step: 0.034 },
  aigue: { label: 'Aiguë', f: 640, jit: 0.28, swing: 0.3, step: 0.033 },
  enfant: { label: 'Enfant', f: 820, jit: 0.34, swing: 0.35, step: 0.03 },
  robot: { label: 'Robot (monocorde)', f: 260, jit: 0.01, swing: 0, step: 0.04 },
};

export function blipSettings() { const d = { on: false, voice: 'auto', vol: 0.6, byPersona: {} }; try { return { ...d, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return d; } }
export function setBlipSettings(o) { try { localStorage.setItem(KEY, JSON.stringify({ ...blipSettings(), ...o })); } catch { /* stockage indisponible */ } }

let ctx = null; let out = null; let next = 0; let n = 0; let pw = null;
// onde « pulse » à 25 % passée dans un filtre passe-bas : le grain 8 bits, sans le côté qui picote
function pulse() {
  if (pw) return pw; const N = 24; const re = new Float32Array(N); const im = new Float32Array(N); const d = 0.25;
  for (let k = 1; k < N; k++) { const a = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * d); re[k] = a * Math.cos(k * Math.PI * d); im[k] = a * Math.sin(k * Math.PI * d); }
  pw = ctx.createPeriodicWave(re, im); return pw;
}
// Voix d'un caractère : celle que l'utilisateur lui a choisie, sinon sa voix d'origine (indicative : tout est modifiable).
export const voiceKeyFor = (personaId) => { const k = blipSettings().byPersona?.[personaId]; return k && VOICES[k]?.f ? k : 'auto'; };
export function setVoiceFor(personaId, key) { const by = { ...(blipSettings().byPersona || {}) }; if (key && VOICES[key]?.f) by[personaId] = key; else delete by[personaId]; setBlipSettings({ byPersona: by }); }
function voiceOf(personaId) {
  const k = voiceKeyFor(personaId);
  return k === 'auto' ? (PRESETS[personaId] || PRESETS.assistant) : VOICES[k];
}
// Coupe tout de suite : file vidée et sons déjà programmés arrêtés (muet, ou arrêt du message).
const live = new Set();
export function stopBlips() {
  queue = ''; if (qTimer) { clearTimeout(qTimer); qTimer = null; }
  for (const o of live) { try { o.stop(); } catch { /* déjà arrêté */ } }
  live.clear(); if (ctx) next = ctx.currentTime;
}

/** Joue les bips d'un morceau de texte qui vient d'arriver. personaId : caractère actif (sa voix, si « selon le caractère »). */
// Le texte est mis en file puis « dit » à son rythme, même s'il arrive d'un coup (réponse livrée en gros morceaux, ou plus vite qu'on ne parle).
let queue = ''; let qTimer = null; let qPersona = null;
export function blip(text, personaId, force = false) {
  const st = blipSettings();
  if (!text || (!force && !st.on)) { if (!st.on) stopBlips(); return; }
  const vol = Math.max(0, Math.min(1, Number(st.vol ?? 0.6)));
  if (vol <= 0.001) return;
  try {
    if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); out = ctx.createBiquadFilter(); out.type = 'lowpass'; out.frequency.value = 2600; out.Q.value = 0.3; out.connect(ctx.destination); }
    if (ctx.state === 'suspended') ctx.resume();
  } catch { return; }
  queue = (queue + String(text)).slice(-700); qPersona = personaId; // au plus ~700 lettres en attente : on ne parle pas pendant une minute après la fin
  if (!qTimer) pump();
}
function pump() {
  qTimer = null; if (!queue || !ctx) return;
  // contexte audio encore en pause (le webview le démarre ainsi) : son horloge est figée, rien ne serait entendu avant sa reprise
  if (ctx.state !== 'running') { ctx.resume().catch(() => {}); qTimer = setTimeout(pump, 120); return; }
  const vol = Math.max(0, Math.min(1, Number(blipSettings().vol ?? 0.6)));
  const v = voiceOf(qPersona); const now = ctx.currentTime; const peak = 0.11 * vol * vol + 0.004;
  if (next < now) next = now;
  const chars = Array.from(queue); let i = 0;
  for (; i < chars.length; i++) {
    const ch = chars[i];
    if (next - now > 2.5) break; // 2,5 s d'avance : les sons programmés se jouent même si la page est occupée à afficher le texte (la lecture ne dépend plus du thread de la page)
    if (/[.!?…]/.test(ch)) { next += 0.16; continue; }
    if (/[,;:]/.test(ch)) { next += 0.08; continue; }
    if (/\s/.test(ch)) { next += 0.03; continue; }
    if (!/[\p{L}\p{N}]/u.test(ch)) continue;
    n++;
    const code = ch.toLowerCase().codePointAt(0);
    const r1 = (((code * 37) + n * 5) % 11) / 10 - 0.5; // hauteur : propre à la lettre, un peu changeante
    const r2 = (((code * 53) + n * 17) % 13) / 12;      // rythme
    next += v.step * (1 - v.swing / 2 + v.swing * r2);
    if (n % 2) continue; // une lettre sur deux : un débit de parole, pas une mitraillette
    const f = v.f * (1 + v.jit * r1); const len = 0.075;
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.setPeriodicWave(pulse()); o.frequency.setValueAtTime(f, next);
    g.gain.setValueAtTime(0.0001, next); g.gain.exponentialRampToValueAtTime(peak, next + 0.01);
    g.gain.setValueAtTime(peak, next + len * 0.55); g.gain.exponentialRampToValueAtTime(0.0001, next + len);
    o.connect(g).connect(out); o.start(next); o.stop(next + len + 0.01); live.add(o); o.onended = () => live.delete(o);
  }
  queue = chars.slice(i).join('');
  if (queue) qTimer = setTimeout(pump, 250);
}
