// Ménage › Détails (nouvelle interface) : au lieu de six longues sections empilées, un menu en haut et UNE section à la fois.
// Les sections elles-mêmes restent celles de l'écran d'origine (care.js) : seul leur affichage change.
const SECT = [
  ['📊', 'Modèles utilisés', 'Lesquels servent, lesquels dorment', /Suivi des modèles/i],
  ['🩺', 'Santé des disques', 'Un disque fatigue-t-il ?', /Santé des disques/i],
  ['🚽', 'Caches des applis', 'Place prise par Hugging Face, PyTorch…', /Chasse d'eau|caches/i],
  ['🧹', 'Restes oubliés', 'Téléchargements interrompus, vieux dossiers', /Restes/i],
  ['🛑', 'Moteurs égarés', 'Programmes oubliés qui prennent de la mémoire', /Moteurs égarés/i],
  ['💾', 'Sauvegarde', 'Copier tes dossiers de modèles ailleurs', /Sauvegarde/i],
];
const KEY = 'paiz.v2.details';
let cur = 0; try { cur = Math.min(SECT.length - 1, Math.max(0, Number(localStorage.getItem(KEY)) || 0)); } catch { /* stockage indisponible */ }

function show(i) {
  cur = i; try { localStorage.setItem(KEY, String(i)); } catch { /* stockage indisponible */ }
  const body = document.getElementById('care-body'); if (body) body.dataset.show = String(i + 1);
  document.querySelectorAll('#v2-det-nav [data-sec]').forEach((b) => b.classList.toggle('on', Number(b.dataset.sec) === i));
  document.getElementById('view-care')?.scrollTo?.(0, 0);
}
function mount() {
  const view = document.getElementById('view-care'); const body = document.getElementById('care-body');
  if (!view || !body || document.getElementById('v2-det-nav')) return;
  const nav = document.createElement('div'); nav.id = 'v2-det-nav'; nav.className = 'v2-det-nav';
  nav.innerHTML = SECT.map(([ic, t, s], i) => `<button data-sec="${i}"><span class="v2-det-ic">${ic}</span><span><b>${t}</b><small>${s}</small></span></button>`).join('');
  view.insertBefore(nav, body);
  nav.addEventListener('click', (e) => { const b = e.target.closest('[data-sec]'); if (b) show(Number(b.dataset.sec)); });
  show(cur);
}
/** Ouvre la section dont le titre correspond (utilisé par les tuiles de la Vue d'ensemble). */
window.paizV2Details = (rx) => { mount(); const i = SECT.findIndex((x) => String(x[3]) === String(rx) || x[3].test(String(rx?.source || rx))); show(i >= 0 ? i : 0); };
mount();
