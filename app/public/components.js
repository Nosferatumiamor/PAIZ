// Sous-onglet « Composants » : encodeurs de texte, VAE, CLIP vision partagés entre les programmes IA, sans re-téléchargement ni doublon.
// PAIZ repère tout seul les dossiers de modèles des programmes (clip, vae, text_encoders…) et te les propose ; rien ne se fait sans ton accord.
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bytes = (n) => { if (n == null) return '—'; const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0; let x = Number(n); while (x >= 1024 && i < 4) { x /= 1024; i++; } return `${x.toFixed(i > 1 ? 1 : 0)} ${u[i]}`; };
async function call(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status}`);
  return d;
}
function say(msg, kind = '') { const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg; $('#toasts')?.appendChild(el); setTimeout(() => el.remove(), 6000); }
const KIND = { 'text-encoder': 'encodeur de texte', vae: 'VAE', 'clip-vision': 'CLIP vision' };
const S = { rep: null, busy: false };

async function load() { try { S.rep = await call('/api/components'); } catch (e) { say(e.message, 'error'); } paint(); }

function cell(c, p) {
  if (p.state === 'missing') return `<button class="btn small" data-link="${esc(c.key)}" data-target="${esc(p.target)}" title="Rend le fichier visible ici (lien) : le programme ne le re-téléchargera pas">＋ Lier</button>`;
  if (p.state === 'real') return '<span class="badge ok" title="Vrai fichier à cet endroit">✔ fichier</span>';
  return `<span class="badge soft">${p.state === 'hardlink' ? 'lien dur' : 'lien symbolique'}</span> <button class="btn ghost small" data-restore="${esc(p.target)}" title="Remplace le lien par une vraie copie (si ce programme ne supporte pas les liens)">↩ Vraie copie</button>`;
}

function paint() {
  const el = $('#components-body'); if (!el) return; const R = S.rep;
  if (!R) { el.innerHTML = '<p class="muted">Chargement…</p>'; return; }
  const cand = R.candidates.map((c) => `<div class="dt-need"><b>${esc(c.name)}</b> <code>${esc(c.dir)}</code> <span class="muted small">sous-dossiers : ${esc(c.subs.join(', '))} · ${c.files} fichiers</span>
    <button class="btn small primary" data-prog="accepted" data-dir="${esc(c.dir)}" data-name="${esc(c.name)}">Utiliser comme emplacement</button> <button class="btn ghost small" data-prog="ignored" data-dir="${esc(c.dir)}" data-name="${esc(c.name)}">Ignorer</button></div>`).join('');
  const progs = R.programs.map((p) => `<span class="badge soft">${esc(p.name)} · <code>${esc(p.dir)}</code> <a href="#" data-prog="remove" data-dir="${esc(p.dir)}" title="Ne plus considérer ce dossier">×</a></span>`).join(' ');
  const cols = R.programs;
  const rows = R.components.map((c) => `<tr><td><b>${esc(c.file_name)}</b><div class="muted small">${KIND[c.kind]} · ${bytes(c.size)}${c.copies > 1 ? ` · ${c.copies} copies au catalogue` : ''}</div></td>
    <td>${c.places.map((p) => `<div style="margin:2px 0"><span class="muted small">${esc(p.program)} / ${esc(p.sub)}</span> ${cell(c, p)}</div>`).join('')}</td></tr>`).join('');
  el.innerHTML = `<div class="panel"><div class="panel-head"><h3>Composants partagés</h3>
    <p class="muted small">Encodeurs de texte, VAE, CLIP vision : un seul exemplaire sur le disque, rendu visible dans le dossier de chaque programme (lien dur sur le même disque, lien symbolique entre disques) pour qu’ils ne soient pas re-téléchargés avec chaque modèle maître. <b>Rien ne se fait sans ton clic</b>, et chaque lien se défait en « Vraie copie ».</p></div>
    ${R.candidates.length ? `<h4>Dossiers de programmes détectés</h4><p class="muted small">PAIZ a vu des dossiers qui ressemblent à la racine de modèles d’un programme IA (plusieurs sous-dossiers clip, vae, text_encoders…).</p>${cand}` : ''}
    <h4 style="margin-top:12px">Emplacements utilisés</h4><div>${progs || '<span class="muted small">Aucun pour l’instant : accepte un dossier détecté ci-dessus.</span>'}</div>
    ${cols.length ? `<div class="toolbar" style="margin:12px 0 6px"><button class="btn primary" id="comp-all" ${R.missing ? '' : 'disabled'}>＋ Tout rendre disponible partout (${R.missing})</button><span class="muted small">${R.components.length} composant(s) · ${R.links} lien(s) créé(s) par PAIZ</span></div>
    <div class="table-scroll" style="max-height:520px"><table class="assets-table"><thead><tr><th>Composant</th><th>Présence dans chaque programme</th></tr></thead><tbody>${rows || '<tr><td colspan="2" class="muted">Aucun encodeur / VAE / CLIP vision trouvé dans le catalogue.</td></tr>'}</tbody></table></div>` : ''}
  </div>`;
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('#tabs .tab[data-view="components"]')) { load(); return; }
  const body = e.target.closest('#components-body'); if (!body || S.busy) return;
  const pr = e.target.closest('[data-prog]');
  if (pr) { e.preventDefault(); try { S.rep = await call('/api/components/program', 'POST', { dir: pr.dataset.dir, name: pr.dataset.name, status: pr.dataset.prog }); } catch (er) { say(er.message, 'error'); } paint(); return; }
  const lk = e.target.closest('[data-link]');
  if (lk) { S.busy = true; try { const r = await call('/api/components/provision', 'POST', { confirm: true, items: [{ key: lk.dataset.link, target: lk.dataset.target }] }); const x = r.results[0]; say(x.error || `Lien créé (${x.method === 'hardlink' ? 'lien dur' : 'lien symbolique'}).`, x.error ? 'error' : ''); } catch (er) { say(er.message, 'error'); } S.busy = false; load(); return; }
  if (e.target.closest('#comp-all')) {
    const items = S.rep.components.flatMap((c) => c.places.filter((p) => p.state === 'missing').map((p) => ({ key: c.key, target: p.target })));
    if (!confirm(`Créer ${items.length} lien(s) vers les exemplaires existants ?\n\nAucun fichier n’est copié ni supprimé ; chaque lien peut être remplacé par une vraie copie ensuite.`)) return;
    S.busy = true; try { const r = await call('/api/components/provision', 'POST', { confirm: true, items }); const bad = r.results.filter((x) => x.error); say(`${r.results.length - bad.length} lien(s) créé(s).${bad.length ? ` ${bad.length} échec(s) : ${bad[0].error}` : ''}`, bad.length ? 'error' : ''); } catch (er) { say(er.message, 'error'); } S.busy = false; load(); return;
  }
  const rs = e.target.closest('[data-restore]');
  if (rs) { if (!confirm('Remplacer ce lien par une vraie copie du fichier ?\n(prend de la place disque ; l’exemplaire d’origine n’est pas touché)')) return; S.busy = true; try { await call('/api/components/restore', 'POST', { confirm: true, target: rs.dataset.restore }); say('Vraie copie restaurée.'); } catch (er) { say(er.message, 'error'); } S.busy = false; load(); }
});
