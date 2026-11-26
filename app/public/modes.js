// Choix du mode mémoire en deux temps : « Où » (GPU d'abord / RAM d'abord / adaptatif) puis « Combien » (de discret à rapide).
// La grille vient du moteur (engine.js : MODE_GRID) ; chaque case est un profil existant, les anciens noms restent valables.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const NL = String.fromCharCode(10);
export const infoText = (info, p, sep = NL) => [info?.[p]?.desc, info?.[p]?.conso].filter(Boolean).join(sep);

export function locate(grid, profile) {
  for (const w of grid || []) { const o = w.options.find((x) => x.profile === profile); if (o) return { where: w.id, option: o }; }
  return { where: grid?.[0]?.id, option: null };
}
const howOptions = (grid, whereId, info, cur, xlOff) => {
  const w = (grid || []).find((x) => x.id === whereId); if (!w) return '';
  return w.options.map((o) => `<option value="${esc(o.profile)}" title="${esc(xlOff && o.profile === 'extralight' ? 'Pas encore fabriqué pour ce modèle : à faire dans l’onglet WeightStream (mode extra-light, « Fabriquer »).' : infoText(info, o.profile))}" ${o.profile === cur ? 'selected' : ''} ${xlOff && o.profile === 'extralight' ? 'disabled' : ''}>${esc(o.label)}${xlOff && o.profile === 'extralight' ? ' — non fabriqué' : ''}</option>`).join('');
};
// extra-light grisé quand la version Q3 du modèle n'existe pas (sauf sur l'onglet WeightStream, où on peut la fabriquer : ids.allowBuild)
const gridOf = (eng) => (eng?.grid || []).filter((w) => (w.id === 'xl') === !!eng?.lossy); // modèle allégé (Q3/Q2) : extra-light seulement ; sinon pas d'extra-light
// HTML des deux listes ; ids = { where, how }
export function modeControlsHtml(eng, profile, ids) {
  const grid = gridOf(eng); const { where } = locate(grid, profile);
  return `<label class="w-sel" title="Où le modèle travaille : sur la carte graphique, sur la mémoire vive, ou en s’adaptant à la machine">Où <select id="${ids.where}">${grid.map((w) => `<option value="${esc(w.id)}" title="${esc(w.tip)}" ${w.id === where ? 'selected' : ''}>${esc(w.label)}</option>`).join('')}</select></label>`
    + `<label class="w-sel" title="Combien de mémoire il prend (le changer recharge le modèle)">Combien <select id="${ids.how}">${howOptions(grid, where, eng?.profileInfo, profile)}</select></label>`;
}
// Branche les deux listes : onPick(profil) est appelé à chaque choix ; le profil proposé en changeant d'« Où » garde le même niveau si possible.
export function wireModeControls(eng, profile, ids, onPick) {
  const grid = gridOf(eng); const selW = document.getElementById(ids.where); const selH = document.getElementById(ids.how); if (!selW || !selH) return;
  selH.onchange = () => onPick(selH.value);
  selW.onchange = () => {
    const w = grid.find((x) => x.id === selW.value); if (!w) return;
    const cur = locate(grid, profile).option; const same = cur && w.options.find((o) => o.level && o.level === cur.level);
    const pick = (same || w.options[Math.min(1, w.options.length - 1)]).profile;
    selH.innerHTML = howOptions(grid, w.id, eng?.profileInfo, pick); onPick(pick);
  };
}
