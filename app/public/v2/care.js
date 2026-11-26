// Ménage › Vue d'ensemble (nouvelle interface) : un tableau de bord en tuiles. Chaque tuile donne son état en un chiffre
// et mène au bon endroit (Doublons, Accessoires, ou la bonne section de l'écran Détails). Rien ne se fait sans clic.
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const go = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} Go` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} Mo` : n > 0 ? '< 1 Mo' : '0');
const get = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const day = (t) => (t ? new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : '');

const D = {}; let painting = false;
const TILES = [
  { id: 'dups', label: 'Doublons', go: ['care', 'duplicates'],
    calc: () => { const g = (D.dups?.groups || []).filter((x) => !x.merged); const b = g.reduce((n, x) => n + Math.max(0, (x.physicalCopies || x.count) - 1) * (x.size || 0), 0);
      return { big: g.length ? go(b) : 'Aucun', sub: g.length ? `${g.length} fichier(s) en plusieurs copies · fusion sans rien casser` : 'Pas de fichier en double', level: g.length ? 'warn' : 'ok', bytes: b }; } },
  { id: 'caches', label: 'Caches des applis IA', go: ['care', 'care', /Chasse d'eau|caches/i],
    calc: () => { const c = (D.caches?.caches || []).filter((x) => x.kind === 'cache'); const b = c.reduce((n, x) => n + (x.size || 0), 0);
      return { big: go(b), sub: 'Hugging Face, PyTorch… : ce qui sert encore sera retéléchargé', level: b > 2 * 1024 ** 3 ? 'warn' : 'ok', bytes: b }; } },
  { id: 'left', label: 'Restes oubliés', go: ['care', 'care', /Restes/i],
    calc: () => { if (!D.left) return null; const l = (D.left.items || []).filter((x) => x.kind !== 'dupe'); const b = l.reduce((n, x) => n + (x.size || 0), 0); // les copies en double sont déjà dans « Doublons »
      return { big: l.length ? go(b) : 'Rien', sub: l.length ? `${l.length} élément(s) : fichiers temporaires, téléchargements interrompus, dossiers vides` : 'Aucun reste trouvé', level: b > 1024 ** 3 ? 'warn' : 'ok', bytes: b }; } },
  { id: 'unused', label: 'Modèles jamais utilisés', go: ['care', 'care', /Suivi des modèles/i],
    calc: () => { const s = D.usage?.summary; if (!s) return null;
      return { big: s.reclaimCount ? go(s.reclaimBytes) : 'Aucun', sub: s.reclaimCount ? `${s.reclaimCount} modèle(s) sur les disques rapides, sans usage récent` : 'Tous servent, ou le suivi est trop récent', level: s.reclaimCount ? 'info' : 'ok', bytes: s.reclaimBytes || 0 }; } },
  { id: 'health', label: 'Santé des disques', go: ['care', 'care', /Santé des disques/i],
    calc: () => { const d = D.health?.disks || []; if (!D.health) return null; const bad = d.filter((x) => x.level === 'bad'); const warn = d.filter((x) => x.level === 'warn');
      return { big: bad.length ? `${bad.length} en danger` : warn.length ? `${warn.length} à surveiller` : 'En forme', sub: `${d.length} disque(s) · ${[...bad, ...warn].map((x) => x.letters?.join(', ')).filter(Boolean).join(' · ') || 'aucun signe de fatigue'}`, level: bad.length ? 'bad' : warn.length ? 'warn' : 'ok' }; } },
  { id: 'strays', label: 'Moteurs égarés', go: ['care', 'care', /Moteurs égarés/i],
    calc: () => { const s = D.strays?.items || []; return { big: s.length ? `${s.length}` : 'Aucun', sub: s.length ? 'des moteurs tournent sans PAIZ et prennent de la mémoire' : 'Aucun programme oublié en marche', level: s.length ? 'warn' : 'ok' }; } },
  { id: 'backup', label: 'Sauvegarde', go: ['care', 'care', /Sauvegarde/i],
    calc: () => { const b = D.backup; if (!b) return null; return { big: b.running ? 'En cours' : b.endedAt ? day(b.endedAt) : 'Jamais', sub: b.running ? 'copie des dossiers de modèles…' : b.endedAt ? 'dernière copie des dossiers de modèles' : 'aucune copie des dossiers de modèles', level: b.running ? 'info' : b.endedAt ? 'ok' : 'info' }; } },
  { id: 'acc', label: 'Accessoires partagés', go: ['care', 'components'],
    calc: () => { const c = D.comps; if (!c) return null; const cand = c.candidates?.length || 0;
      return { big: c.programs?.length ? (c.missing ? `${c.missing} à lier` : 'À jour') : cand ? `${cand} appli(s)` : '—', sub: c.programs?.length ? 'encodeurs, VAE… visibles par chaque appli sans doublon' : cand ? 'dossiers d’applis IA détectés, à valider' : 'aucune appli IA détectée', level: c.missing || (!c.programs?.length && cand) ? 'info' : 'ok' }; } },
];
const LEVEL = { ok: '#6ee7a0', info: '#e8f2f3', warn: '#ffb547', bad: '#ff7b7b' };

function paint() {
  const el = $('#v2care-body'); if (!el) return;
  const cards = TILES.map((t) => ({ t, r: t.calc() }));
  const total = cards.reduce((n, c) => n + (c.r?.bytes && ['dups', 'caches', 'left', 'unused'].includes(c.t.id) ? c.r.bytes : 0), 0);
  const loading = cards.some((c) => !c.r);
  el.innerHTML = `<div class="v2-care">
    <div class="v2-care-hero"><div><div class="v2-care-k">Place récupérable</div><div class="v2-care-big">${go(total)}</div>
      <div class="v2-muted">doublons, caches, restes et modèles jamais utilisés${loading ? ' · calcul en cours…' : ''}</div></div>
      <div class="v2-care-note">Rien n’est supprimé sans ton clic. Clique une tuile pour voir le détail et choisir.</div></div>
    <div class="v2-care-grid">${cards.map(({ t, r }) => `<button class="v2-tile" data-tile="${t.id}">
      <span class="v2-tile-l">${esc(t.label)}</span>
      <span class="v2-tile-big" style="color:${r ? LEVEL[r.level] : '#6f858d'}">${r ? esc(r.big) : '…'}</span>
      <span class="v2-tile-s">${r ? esc(r.sub) : 'mesure en cours'}</span></button>`).join('')}</div></div>`;
  el.querySelectorAll('[data-tile]').forEach((b) => { b.onclick = () => open(TILES.find((t) => t.id === b.dataset.tile)); });
}
function open(t) {
  const [g, sub, rx] = t.go; window.paizV2?.setGroup(g, sub);
  if (!rx) return;
  if (window.paizV2Details) { window.paizV2Details(rx); return; } // Détails : une section à la fois
  let n = 0; const iv = setInterval(() => {
    const h = [...document.querySelectorAll('#care-body .panel h2')].find((x) => rx.test(x.textContent)); n++;
    if (h) { clearInterval(iv); h.closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); h.closest('.panel').classList.add('v2-flash'); setTimeout(() => h.closest('.panel')?.classList.remove('v2-flash'), 1600); }
    else if (n > 60) clearInterval(iv);
  }, 100);
}
async function load() {
  if (painting) return; painting = true; paint();
  const jobs = { dups: '/api/duplicates', comps: '/api/components', usage: '/api/usage/models', backup: '/api/maintenance/backup', strays: '/api/maintenance/strays', caches: '/api/maintenance/caches', health: '/api/maintenance/health', left: '/api/maintenance/leftovers' };
  await Promise.all(Object.entries(jobs).map(([k, u]) => get(u).then((d) => { D[k] = d || {}; paint(); })));
  painting = false;
}
document.addEventListener('click', (e) => { if (e.target.closest('#tabs .tab[data-view="v2care"]')) setTimeout(load, 0); });
if (document.querySelector('#view-v2care.active')) load();
