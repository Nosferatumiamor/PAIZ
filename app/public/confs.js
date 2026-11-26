// Configurations de modèles : « Save conf » (photo des modèles actifs) et « Load conf » (liste, détail, rechargement, mise à jour).
// Charger = déplacer vers les repos actifs ceux qui sont encore en stock ; un modèle disparu peut être re-téléchargé ou retiré de la liste.
import { famBadge } from '/fam.js';
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bytes = (n) => { if (n == null) return '—'; const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0; let x = Number(n); while (x >= 1024 && i < 4) { x /= 1024; i++; } return `${x.toFixed(x >= 10 || i === 0 ? 0 : 1)} ${u[i]}`; };
async function call(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status}`);
  return d;
}
function say(msg, kind = '') {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg;
  $('#toasts')?.appendChild(el); setTimeout(() => el.remove(), 7000);
}
const when = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const close = () => { $('#modal-root').innerHTML = ''; };
const open = (html) => { const root = $('#modal-root'); root.innerHTML = `<div class="modal-backdrop" id="cf-bd"><div class="modal wide">${html}</div></div>`; $('#cf-bd').onmousedown = (e) => { if (e.target.id === 'cf-bd') close(); }; return root; };
const baseName = (p) => String(p || '').split(/[\\/]/).pop();

// ------------------------------------------------------------------ Save conf
export async function saveConfDialog(items, onDone) {
  if (!items.length) { say("Aucun modèle actif à sauvegarder.", 'error'); return; }
  const total = items.reduce((n, a) => n + (a.size_bytes || 0), 0);
  const el = open(`<div class="modal-head"><h3>💾 Sauvegarder la configuration</h3><button class="modal-close" id="cf-x" title="Fermer">×</button></div>
    <div class="modal-body"><p class="muted small">Photo des ${items.length} modèle(s) actifs (${bytes(total)}) avec le repo où chacun se trouve, à la date d'aujourd'hui. Rien n'est déplacé.</p>
      <input id="cf-name" class="input" style="max-width:none;width:100%" placeholder="Un petit nom (facultatif) : Jeu, Code, Mode dialogue…">
      <div class="cf-list" style="margin-top:10px">${items.map((a) => `<div class="cf-row"><span class="grow">${famBadge(a.title || a.file_name)} <b>${esc(a.title || a.file_name)}</b> <span class="muted small">${esc(a.file_name)}</span></span><span class="badge soft">🔥 ${esc(a.root_name || '?')}</span><b class="small">${bytes(a.size_bytes)}</b></div>`).join('')}</div></div>
    <div class="modal-foot"><button class="btn" id="cf-cancel">Annuler</button><button class="btn primary" id="cf-ok">Sauvegarder</button></div>`);
  $('#cf-x').onclick = $('#cf-cancel').onclick = close;
  $('#cf-name').focus();
  $('#cf-ok').onclick = async () => {
    try { const r = await call('/api/engine/confs', 'POST', { action: 'save', name: $('#cf-name').value }); say(`Configuration « ${r.conf.name} » sauvegardée.`); close(); onDone?.(); } catch (e) { say(e.message, 'error'); }
  };
  el.querySelector('#cf-name').onkeydown = (e) => { if (e.key === 'Enter') $('#cf-ok').click(); };
}

// ------------------------------------------------------------------ Load conf
const cf = { confs: [], roots: [], cur: null, sel: new Set(), targets: {}, removed: new Set(), name: '', onDone: null };
const fetchAll = async () => {
  const [c, r] = await Promise.all([call('/api/engine/confs'), call('/api/roots')]);
  cf.confs = c.confs; cf.roots = r.roots.filter((x) => x.role === 'active' && x.exists && x.enabled !== 0);
};
export async function loadConfDialog(onDone) {
  cf.onDone = onDone; cf.cur = null;
  try { await fetchAll(); } catch (e) { say(e.message, 'error'); return; }
  paintList();
}
const summary = (state) => {
  const avail = state.filter((s) => s.status === 'active' || s.status === 'stock').length;
  const gone = state.filter((s) => s.status === 'missing').length;
  const repos = state.filter((s) => s.repoState === 'gone' || s.repoState === 'not-active').length;
  return `<span class="badge cf-ok">🟢 ${avail} dispo</span>${gone ? ` <span class="badge cf-bad">🔴 ${gone} disparu${gone > 1 ? 's' : ''}</span>` : ''}${repos ? ` <span class="badge cf-warn">⚠ ${repos} repo${repos > 1 ? 's' : ''} à revoir</span>` : ''}`;
};
function paintList() {
  const el = open(`<div class="modal-head"><h3>📂 Charger une configuration</h3><button class="modal-close" id="cf-x" title="Fermer">×</button></div>
    <div class="modal-body">${cf.confs.length ? `<div class="cf-list">${cf.confs.map((c) => `<div class="cf-row cf-click" data-id="${esc(c.id)}"><span class="grow"><b>${esc(c.name)}</b><div class="muted small">${when(c.createdAt)} · ${c.items.length} modèle${c.items.length > 1 ? 's' : ''}${c.updatedAt !== c.createdAt ? ` · mise à jour ${when(c.updatedAt)}` : ''}</div></span>${summary(c.state)}<button class="modal-close" data-del="${esc(c.id)}" title="Supprimer cette configuration">✕</button></div>`).join('')}</div>`
      : '<p class="muted">Aucune configuration. Utilise « Save conf » pour en créer une avec tes modèles actifs.</p>'}</div>
    <div class="modal-foot"><button class="btn primary" id="cf-done">Fermer</button></div>`);
  $('#cf-x').onclick = $('#cf-done').onclick = close;
  el.querySelectorAll('[data-id]').forEach((r) => { r.onclick = () => openDetail(r.dataset.id); });
  el.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async (e) => {
    e.stopPropagation();
    const c = cf.confs.find((x) => x.id === b.dataset.del);
    if (!confirm(`Supprimer la configuration « ${c?.name} » ?\n\nÊtes-vous sûr ? (Les modèles ne sont pas touchés, seule la liste est effacée.)`)) return;
    try { await call('/api/engine/confs', 'POST', { action: 'delete', id: b.dataset.del }); await fetchAll(); paintList(); } catch (err) { say(err.message, 'error'); } }; });
}

function openDetail(id) {
  const c = cf.confs.find((x) => x.id === id); if (!c) return;
  cf.cur = id; cf.removed = new Set(); cf.targets = {}; cf.name = c.name;
  cf.sel = new Set(c.state.filter((s) => s.status === 'stock').map((s) => s.key));
  paintDetail();
}
const curConf = () => cf.confs.find((x) => x.id === cf.cur);
const targetOf = (s) => (cf.targets[s.key] !== undefined ? cf.targets[s.key] : s.targetRootId);
const isDirty = (c) => cf.removed.size > 0 || cf.name.trim() !== c.name || c.state.some((s) => !cf.removed.has(s.key) && cf.targets[s.key] !== undefined && cf.targets[s.key] !== s.targetRootId);
function paintDetail() {
  const c = curConf(); if (!c) { paintList(); return; }
  const rows = c.state.filter((s) => !cf.removed.has(s.key));
  const opt = (s) => `<select class="input cf-target" data-key="${esc(s.key)}"><option value="">— choisir un repo actif —</option>${cf.roots.map((r) => `<option value="${r.id}" ${targetOf(s) === r.id ? 'selected' : ''}>${esc(r.name)}${r.free != null ? ` · ${bytes(r.free)} libres` : ''}</option>`).join('')}</select>`;
  const stat = (s) => ({ active: '<span class="badge soft">déjà actif</span>', stock: `<span class="badge cf-ok">🟢 dispo${s.where?.root ? ` · ${esc(s.where.root)}` : ''}</span>`, missing: '<span class="badge cf-bad">🔴 disparu</span>', unmanaged: '<span class="badge cf-warn" title="Le fichier existe mais son dossier n\'est plus un repo">⚠ hors repo</span>' }[s.status]);
  const repoNote = (s) => (s.repoState === 'gone' ? `<div class="small" style="color:var(--danger)">repo d'origine « ${esc(s.repo?.name)} » disparu : en choisir un</div>` : s.repoState === 'not-active' ? `<div class="small" style="color:var(--warn,#f59e0b)">« ${esc(s.repo?.name)} » n'est plus un repo actif</div>` : '');
  const nSel = rows.filter((s) => cf.sel.has(s.key) && s.status === 'stock').length;
  const el = open(`<div class="modal-head"><button class="btn ghost small" id="cf-back">← Liste</button><h3><input id="cf-rename" class="input" value="${esc(cf.name)}" style="max-width:none;width:100%;font-weight:700"></h3><button class="modal-close" id="cf-x" title="Fermer">×</button></div>
    <div class="modal-body"><p class="muted small">Sauvegardée le ${when(c.createdAt)}${c.updatedAt !== c.createdAt ? ` · mise à jour le ${when(c.updatedAt)}` : ''}. Charger déplace les modèles « dispo » vers le repo actif choisi (jamais de copie).</p>
      <div class="toolbar" style="margin-bottom:8px"><button class="btn small" id="cf-all">Cocher tout ce qui est dispo</button><button class="btn small ghost" id="cf-none">Tout décocher</button><span class="grow"></span>
        <label class="muted small">Même repo pour tous <select id="cf-bulk" class="input"><option value="">—</option>${cf.roots.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></label></div>
      <div class="cf-list">${rows.map((s) => `<div class="cf-row ${s.status === 'missing' ? 'cf-gone' : ''}">
        <input type="checkbox" data-sel="${esc(s.key)}" ${s.status === 'stock' ? '' : 'disabled'} ${cf.sel.has(s.key) && s.status === 'stock' ? 'checked' : ''}>
        <span class="grow">${famBadge(s.title || s.file_name)} <b>${esc(s.title || s.file_name)}</b> <span class="muted small">${bytes(s.size_bytes)}</span><div class="muted small">${esc(s.file_name)}</div>${repoNote(s)}</span>
        ${stat(s)}<span class="cf-tcell">${opt(s)}</span>
        ${s.status === 'missing' ? (s.hfId ? `<button class="btn small" data-redl="${esc(s.key)}" title="Retélécharger depuis ${esc(s.hfId)}">⬇ Retélécharger</button>` : `<button class="btn small" data-search="${esc(s.key)}" title="Chercher ce fichier sur Hugging Face">🔍 Chercher</button>`) : ''}
        <button class="modal-close" data-rm="${esc(s.key)}" title="Retirer ce modèle de la configuration">✕</button></div>`).join('') || '<p class="muted">Plus aucun modèle : enregistre pour valider, ou reviens à la liste.</p>'}</div></div>
    <div class="modal-foot"><span class="muted small grow">${isDirty(c) ? '✎ modifications non enregistrées' : ''}</span>
      ${isDirty(c) ? '<button class="btn" id="cf-save">Enregistrer les modifications</button>' : ''}
      <button class="btn" id="cf-load-all">Charger tout ce qui est dispo</button><button class="btn primary" id="cf-load" ${nSel ? '' : 'disabled'}>Charger la sélection (${nSel})</button></div>`);
  $('#cf-x').onclick = close; $('#cf-back').onclick = () => paintList();
  $('#cf-rename').oninput = (e) => { cf.name = e.target.value; };
  $('#cf-rename').onchange = () => paintDetail();
  $('#cf-all').onclick = () => { for (const s of rows) if (s.status === 'stock') cf.sel.add(s.key); paintDetail(); };
  $('#cf-none').onclick = () => { cf.sel.clear(); paintDetail(); };
  $('#cf-bulk').onchange = (e) => { if (!e.target.value) return; for (const s of rows) cf.targets[s.key] = Number(e.target.value); paintDetail(); };
  el.querySelectorAll('[data-sel]').forEach((b) => { b.onchange = () => { if (b.checked) cf.sel.add(b.dataset.sel); else cf.sel.delete(b.dataset.sel); paintDetail(); }; });
  el.querySelectorAll('.cf-target').forEach((b) => { b.onchange = () => { cf.targets[b.dataset.key] = b.value ? Number(b.value) : null; paintDetail(); }; });
  el.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { cf.removed.add(b.dataset.rm); cf.sel.delete(b.dataset.rm); paintDetail(); }; });
  el.querySelectorAll('[data-redl]').forEach((b) => { b.onclick = () => redownload(rows.find((s) => s.key === b.dataset.redl)); });
  el.querySelectorAll('[data-search]').forEach((b) => { b.onclick = () => searchHub(rows.find((s) => s.key === b.dataset.search)); });
  if ($('#cf-save')) $('#cf-save').onclick = saveEdits;
  $('#cf-load').onclick = () => doLoad(rows.filter((s) => s.status === 'stock' && cf.sel.has(s.key)));
  $('#cf-load-all').onclick = () => doLoad(rows.filter((s) => s.status === 'stock'));
}

async function saveEdits() {
  const c = curConf(); const repos = {};
  for (const s of c.state) if (!cf.removed.has(s.key) && cf.targets[s.key] != null && cf.targets[s.key] !== s.targetRootId) repos[s.key] = cf.targets[s.key];
  try {
    await call('/api/engine/confs', 'POST', { action: 'update', id: c.id, patch: { name: cf.name, remove: [...cf.removed], repos } });
    await fetchAll(); cf.removed = new Set(); cf.targets = {}; say('Configuration mise à jour.'); openDetailKeep(c.id);
  } catch (e) { say(e.message, 'error'); }
}
function openDetailKeep(id) { const c = cf.confs.find((x) => x.id === id); if (!c) { paintList(); return; } cf.cur = id; cf.name = c.name; cf.sel = new Set(c.state.filter((s) => s.status === 'stock').map((s) => s.key)); paintDetail(); }

async function doLoad(list) {
  if (!list.length) { say('Rien à charger : aucun modèle « dispo » coché.', 'error'); return; }
  const lacking = list.filter((s) => !targetOf(s));
  if (lacking.length) { say(`Choisis un repo actif pour : ${lacking.map((s) => s.title || s.file_name).join(', ')}.`, 'error'); return; }
  const total = list.reduce((n, s) => n + (s.size_bytes || 0), 0);
  if (!confirm(`Déplacer ${list.length} modèle(s) (${bytes(total)}) vers leurs repos actifs ?`)) return;
  try {
    const r = await call('/api/engine/confs', 'POST', { action: 'load', id: cf.cur, picks: list.map((s) => ({ key: s.key, toRoot: targetOf(s) })) });
    say(`Déplacement lancé : ${r.models} modèle(s).`); close(); cf.onDone?.();
  } catch (e) { say(e.message, 'error'); }
}

async function redownload(s) {
  const to = targetOf(s) || cf.roots[0]?.id;
  if (!to) { say("Définis d'abord un repo actif.", 'error'); return; }
  try {
    const f = (await call(`/api/hub/files?id=${encodeURIComponent(s.hfId)}`)).files;
    const g = f.find((x) => x.parts.some((p) => baseName(p.path).toLowerCase() === s.file_name.toLowerCase()));
    if (!g) { say(`« ${s.file_name} » n'est plus dans ${s.hfId}.`, 'error'); return; }
    const root = cf.roots.find((r) => r.id === to);
    if (!confirm(`Télécharger ${s.file_name} (${bytes(g.size)}) depuis ${s.hfId} vers « ${root?.name} » ?`)) return;
    await call('/api/hub/download', 'POST', { id: s.hfId, files: g.parts, toRoot: to, folder: '' });
    say('Téléchargement lancé (suivi dans l\'onglet Découvrir).');
  } catch (e) { say(e.message, 'error'); }
}
function searchHub(s) {
  close();
  window.paizShowOnline?.();
  const q = s.file_name.replace(/\.gguf$/i, '').replace(/[-_.](Q\d.*|IQ\d.*|F16|BF16|F32|MXFP4.*)$/i, '');
  setTimeout(() => { const i = document.querySelector('#hub-q'); if (i) { i.value = q; document.querySelector('#hub-go')?.click(); } }, 500);
}
