// Groupes de modèles : « Ranger » tout un groupe en stock d'un coup, « Rappeler » tout d'un coup (chacun à son adresse exacte d'origine).
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bytes = (n) => { if (n == null) return '—'; const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0; let x = Number(n); while (x >= 1024 && i < 4) { x /= 1024; i++; } return `${x.toFixed(x >= 10 || i === 0 ? 0 : 1)} ${u[i]}`; };
async function call(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status}`);
  return d;
}
function say(msg, kind = '') { const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg; $('#toasts')?.appendChild(el); setTimeout(() => el.remove(), 8000); }
const close = () => { $('#modal-root').innerHTML = ''; };
const open = (html) => { const root = $('#modal-root'); root.innerHTML = `<div class="modal-backdrop" id="gp-bd"><div class="modal wide">${html}</div></div>`; $('#gp-bd').onmousedown = (e) => { if (e.target.id === 'gp-bd') close(); }; return root; };

const st = { groups: [], roots: [], onDone: null, newSel: new Set(), models: [] };
const fetchAll = async () => {
  const [g, r] = await Promise.all([call('/api/engine/groups'), call('/api/roots')]);
  st.groups = g.groups; st.roots = r.roots.filter((x) => x.exists && x.enabled !== 0);
};
export async function groupsDialog(onDone) { st.onDone = onDone; try { await fetchAll(); } catch (e) { say(e.message, 'error'); return; } paintList(); }

const badge = (g) => {
  const parked = g.state.filter((s) => s.state === 'parked').length; const miss = g.state.filter((s) => s.state === 'missing').length;
  return `${parked ? `<span class="badge cf-warn">📦 ${parked}/${g.items.length} rangé${parked > 1 ? 's' : ''}</span>` : '<span class="badge cf-ok">🟢 en place</span>'}${miss ? ` <span class="badge cf-bad">🔴 ${miss} introuvable${miss > 1 ? 's' : ''}</span>` : ''}`;
};
function paintList() {
  const el = open(`<div class="modal-head"><h3>📦 Groupes de modèles</h3><button class="modal-close" id="gp-x" title="Fermer">×</button></div>
    <div class="modal-body"><p class="muted small">Un groupe = les modèles d'un projet (ex. un jeu, un personnage). Ranger les met tous en stock d'un coup ; rappeler les remet tous là où chacun était, même s'ils venaient de repos différents.</p>
    ${st.groups.length ? `<div class="cf-list">${st.groups.map((g) => `<div class="cf-row cf-click" data-id="${esc(g.id)}"><span class="grow"><b>${esc(g.name)}</b><div class="muted small">${g.items.length} <span>${g.items.length > 1 ? 'fichiers' : 'fichier'}</span> · ${bytes(g.items.reduce((n, i) => n + (i.size_bytes || 0), 0))}</div></span>${badge(g)}<button class="modal-close" data-del="${esc(g.id)}" title="Supprimer ce groupe (les modèles ne sont pas touchés)">✕</button></div>`).join('')}</div>` : '<p class="muted">Aucun groupe pour l\'instant.</p>'}</div>
    <div class="modal-foot"><button class="btn" id="gp-new">＋ Nouveau groupe</button><button class="btn primary" id="gp-done">Fermer</button></div>`);
  $('#gp-x').onclick = $('#gp-done').onclick = close; $('#gp-new').onclick = paintNew;
  el.querySelectorAll('[data-id]').forEach((r) => { r.onclick = () => paintDetail(r.dataset.id); });
  el.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async (e) => {
    e.stopPropagation(); const g = st.groups.find((x) => x.id === b.dataset.del);
    if (!confirm(`Supprimer le groupe « ${g?.name} » ?\n\nÊtes-vous sûr ? (Les modèles ne sont pas touchés, seule la liste est effacée.)`)) return;
    try { await call('/api/engine/groups', 'POST', { action: 'delete', id: b.dataset.del }); await fetchAll(); paintList(); } catch (err) { say(err.message, 'error'); } }; });
}

async function paintNew() {
  try { st.models = (await call('/api/assets?q=.gguf&limit=2000')).items.filter((a) => /\.gguf$/i.test(a.file_name) && !/mmproj/i.test(a.file_name) && a.root_id != null && a.state !== 'missing'); } catch (e) { say(e.message, 'error'); return; }
  st.newSel = new Set(); paintNewBody('');
}
function paintNewBody(filter) {
  const f = filter.toLowerCase(); const rows = st.models.filter((a) => !f || `${a.title} ${a.file_name}`.toLowerCase().includes(f));
  const el = open(`<div class="modal-head"><button class="btn ghost small" id="gp-back">← Liste</button><h3>Nouveau groupe</h3><button class="modal-close" id="gp-x">×</button></div>
    <div class="modal-body"><input id="gp-name" class="input" style="max-width:none;width:100%" placeholder="Nom du groupe : Jeu, Code, Dialogue…" value="${esc($('#gp-name')?.value || '')}">
      <input id="gp-filter" class="input" style="max-width:none;width:100%;margin-top:6px" placeholder="Filtrer les modèles…" value="${esc(filter)}">
      <p class="muted small">Coche les modèles du projet. Leurs fichiers associés (mmproj, VAE…) sont ajoutés tout seuls.</p>
      <div class="cf-list" style="max-height:340px;overflow:auto">${rows.map((a) => `<label class="cf-row"><input type="checkbox" data-a="${a.id}" ${st.newSel.has(a.id) ? 'checked' : ''}><span class="grow"><b>${esc(a.title || a.file_name)}</b> <span class="muted small">${esc(a.file_name)}</span></span><span class="badge soft">${esc(a.root_name || '?')}</span><b class="small">${bytes(a.size_bytes)}</b></label>`).join('')}</div></div>
    <div class="modal-foot"><span class="muted small grow">${st.newSel.size} modèle(s) coché(s)</span><button class="btn primary" id="gp-create" ${st.newSel.size ? '' : 'disabled'}>Créer le groupe</button></div>`);
  $('#gp-x').onclick = close; $('#gp-back').onclick = paintList;
  $('#gp-filter').oninput = (e) => { const v = e.target.value; const nm = $('#gp-name').value; paintNewBody(v); $('#gp-name').value = nm; const i = $('#gp-filter'); i.focus(); i.setSelectionRange(v.length, v.length); };
  el.querySelectorAll('[data-a]').forEach((b) => { b.onchange = () => { const id = Number(b.dataset.a); if (b.checked) st.newSel.add(id); else st.newSel.delete(id); const nm = $('#gp-name').value; paintNewBody($('#gp-filter').value); $('#gp-name').value = nm; }; });
  $('#gp-create').onclick = async () => {
    try { const r = await call('/api/engine/groups', 'POST', { action: 'create', name: $('#gp-name').value, assetIds: [...st.newSel] }); st.groups = r.groups; say(`Groupe « ${r.group.name} » créé (${r.group.items.length} fichiers).`); paintDetail(r.group.id); } catch (e) { say(e.message, 'error'); }
  };
}

function paintDetail(id) {
  const g = st.groups.find((x) => x.id === id); if (!g) { paintList(); return; }
  const parked = g.state.filter((s) => s.state === 'parked'); const home = g.state.filter((s) => s.state === 'home');
  const stores = st.roots.filter((r) => r.role === 'store');
  const stat = (s) => (s.state === 'parked' ? `<span class="badge cf-warn">📦 rangé · ${esc(s.where?.root)}</span>` : s.state === 'missing' ? '<span class="badge cf-bad">🔴 introuvable</span>' : `<span class="badge cf-ok">🟢 ${esc(s.where?.root)}</span>`);
  const el = open(`<div class="modal-head"><button class="btn ghost small" id="gp-back">← Liste</button><h3>${esc(g.name)}</h3><button class="modal-close" id="gp-x">×</button></div>
    <div class="modal-body"><div class="cf-list">${g.state.map((s) => `<div class="cf-row ${s.state === 'missing' ? 'cf-gone' : ''}"><span class="grow"><b>${esc(s.title || s.file_name)}</b> <span class="muted small">${bytes(s.size_bytes)}</span><div class="muted small">${esc(s.file_name)}${s.home ? ` · adresse d'origine : ${esc(s.home.path)}${s.home.rootExists ? '' : ' ⚠ repo disparu'}` : ''}</div>${s.shared.length && s.state === 'home' ? `<div class="small" style="color:var(--warn,#f59e0b)">⚠ peut être partagé : ${esc(s.shared.join(' ; '))}</div>` : ''}</span>${stat(s)}</div>`).join('')}</div>
      ${home.length ? `<div class="toolbar" style="margin-top:10px"><label class="muted small">Ranger dans <select id="gp-dest" class="input">${stores.length ? stores.map((r) => `<option value="${r.id}">${esc(r.name)}${r.free != null ? ` · ${bytes(r.free)} libres` : ''}</option>`).join('') : '<option value="">— aucun repo de stockage —</option>'}</select></label>
        <label class="muted small" title="Un lien symbolique reste à l'ancien emplacement : les autres programmes retrouvent le fichier (ralenti si le stock est un disque lent)"><input type="checkbox" id="gp-links"> laisser un lien à l'ancien emplacement</label></div>` : ''}</div>
    <div class="modal-foot"><span class="muted small grow"></span>
      ${parked.length ? `<button class="btn primary" id="gp-recall">↩ Rappeler tout <b>(${parked.length})</b></button>` : ''}
      ${home.length ? `<button class="btn ${parked.length ? '' : 'primary'}" id="gp-park" ${stores.length ? '' : 'disabled'}>📦 Ranger tout <b>(${home.length})</b></button>` : ''}</div>`);
  $('#gp-x').onclick = close; $('#gp-back').onclick = paintList;
  if ($('#gp-park')) $('#gp-park').onclick = async () => {
    const shared = home.filter((s) => s.shared.length); const allow = [];
    for (const s of shared) if (confirm(`« ${s.title || s.file_name} » peut être partagé :\n${s.shared.join('\n')}\n\nLe ranger quand même ?`)) allow.push(s.key);
    const todo = home.filter((s) => !s.shared.length || allow.includes(s.key));
    if (!todo.length) { say('Rien à ranger.', 'error'); return; }
    if (!confirm(`Ranger ${todo.length} fichier(s) (${bytes(todo.reduce((n, s) => n + (s.size_bytes || 0), 0))}) dans « ${st.roots.find((r) => r.id === Number($('#gp-dest').value))?.name} » ?\nTu pourras tout rappeler d'un coup, chacun à sa place.`)) return;
    try {
      const r = await call('/api/engine/groups', 'POST', { action: 'park', id: g.id, toRoot: Number($('#gp-dest').value), allowShared: allow, leaveLinks: $('#gp-links').checked });
      st.groups = r.groups; say(`Rangement lancé : ${r.moving} fichier(s)${r.skipped?.length ? `, ${r.skipped.length} laissé(s) en place` : ''}.`); close(); st.onDone?.();
    } catch (e) { say(e.message, 'error'); }
  };
  if ($('#gp-recall')) $('#gp-recall').onclick = async () => {
    if (!confirm(`Rappeler ${parked.length} fichier(s) à leur adresse d'origine ?`)) return;
    try {
      const r = await call('/api/engine/groups', 'POST', { action: 'recall', id: g.id });
      st.groups = r.groups; say(`Rappel lancé : ${r.models} fichier(s).`); if (r.problems?.length) say(r.problems.map((p) => `${p.title} : ${p.reason}`).join(' | '), 'error'); if (r.conflicts?.length) say(`Une autre chose occupe déjà : ${r.conflicts.join(', ')} (le fichier sera renommé).`, 'error'); close(); st.onDone?.();
    } catch (e) { say(e.message, 'error'); }
  };
}
