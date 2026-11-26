// PAIZ — UI (vanilla JS, aucun build).
import { famBadge } from '/fam.js';
import { moveFlow } from '/moveflow.js';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const CAT_FOLDER = {
  checkpoint: 'checkpoints', lora: 'loras', controlnet: 'controlnet', vae: 'vae',
  embedding: 'embeddings', upscaler: 'upscalers', clip: 'clip', ipadapter: 'ipadapters',
  faceid: 'faceid', motion: 'motion', llm: 'llm', onnx: 'onnx', other: 'autres',
};

const state = {
  sel: new Set(), dupSel: new Set(), dupItems: [],
  data: null,
  view: 'catalogue',
  assets: { items: [], total: 0, offset: 0 },
  groupBy: null,
  filters: { q: '', category: 'all', base: 'all', rootId: 'all', role: 'all', unmanaged: false, state: 'present', sort: 'size', dir: 'desc' },
  suggestion: null,
  trackedJob: null,
  resumeJob: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function humanBytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits).replace('.', ',')} ${units[i]}`;
}

function humanDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('fr-FR', { year: '2-digit', month: '2-digit', day: '2-digit' });
}

function humanDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

function toast(message, kind = 'ok', duration = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : ''}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 300); }, duration);
}

function catInfo(id) {
  return state.data?.categories?.find((c) => c.id === id) || { id, short: id, label: id };
}

function baseInfo(id) {
  return state.data?.bases?.find((b) => b.id === id) || null;
}

function catBadge(id) {
  return `<span class="badge cat-${esc(id)}">${esc(catInfo(id).short)}</span>`;
}

function baseBadge(id, family) {
  if (!id) return '<span class="muted small">—</span>';
  const label = baseInfo(id)?.label || id;
  return `<span class="badge soft" title="${family ? `famille ${esc(family)}` : ''}">${esc(label)}</span>`;
}

function rootName(id) {
  return state.data?.roots?.find((r) => r.id === id)?.name || '—';
}

function categoryOptions(selected) {
  return ['<option value="">— non classé —</option>']
    .concat(state.data.categories.map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.label)}</option>`))
    .join('');
}

function baseOptions(selected) {
  return ['<option value="">— inconnue —</option>']
    .concat(state.data.bases.map((b) => `<option value="${esc(b.id)}" ${b.id === selected ? 'selected' : ''}>${esc(b.label)}</option>`))
    .join('');
}

// ---------------------------------------------------------------------------
// Global state / navigation
// ---------------------------------------------------------------------------

async function loadState() {
  state.data = await api('/api/state');
  renderHeader();
  renderStats();
  renderFilterOptions();
  renderVolumes();
  renderFreePanel();
  renderRoots();
  renderEvents();
  renderDataInfo();
  updateDupBadge();
}

function renderHeader() {
  const s = state.data.stats;
  $('#header-stats').innerHTML = `
    <div class="hs"><b>${s.totals.count}</b><span>modèles</span></div>
    <div class="hs"><b>${humanBytes(s.totals.bytes)}</b><span>catalogue</span></div>
    <div class="hs"><b>${state.data.roots.length}</b><span>racines</span></div>
  `;
}

// Deuxième garde-fou avant tout effacement définitif (sans corbeille).
function confirmErase() {
  return confirm('Êtes-vous sûr ?\n\nCet effacement est DÉFINITIF : le fichier ne passe pas par la corbeille et ne pourra pas être récupéré.');
}

function renderStats() {
  const s = state.data.stats;
  const top = s.byCategory[0];
  const cards = [
    { label: 'Modèles indexés', value: s.totals.count, cls: 'accent' },
    { label: 'Poids total', value: humanBytes(s.totals.bytes) },
    { label: 'Catégorie principale', value: top ? `${catInfo(top.category).short} · ${humanBytes(top.bytes)}` : '—' },
    // les trois compteurs d'alerte n'apparaissent que s'ils ne sont pas à zéro ; le survol explique ce qu'ils comptent
    ...(s.unmanaged ? [{ label: 'Non gérés', value: s.unmanaged, cls: 'warn', go: 'unmanaged', tip: 'Modèles trouvés par le scanner hors de tes racines (dossiers déclarés dans Réglages). PAIZ ne les range pas tant que tu ne les adoptes pas. Clic : ne montrer que ceux-là.' }] : []),
    { label: 'Doublons', value: s.duplicateGroups, cls: s.duplicateGroups ? 'warn' : '', go: 'duplicates', tip: 'Groupes de fichiers identiques présents à plusieurs endroits. Clic : ouvrir l’onglet Doublons.' },
    ...(s.missing ? [{ label: 'Fichiers absents', value: s.missing, cls: 'warn', go: 'missing', tip: 'Modèles encore dans le catalogue mais dont le fichier a disparu du disque (supprimé ou déplacé hors de PAIZ, disque débranché). Clic : n’afficher que ceux-là, pour les retirer de l’index.' }] : []),
  ];
  $('#stats-row').innerHTML = cards.map((c) => `
    <${c.go ? 'button' : 'div'} class="stat ${c.cls || ''} ${c.go ? 'clickable' : ''}" ${c.go ? `data-go="${c.go}"` : ''} title="${esc(c.tip || '')}">
      <b>${esc(c.value)}</b>
      <span>${esc(c.label)}</span>
    </${c.go ? 'button' : 'div'}>
  `).join('');
  $('#stats-row').querySelectorAll('[data-go]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.go === 'duplicates') switchView('duplicates');
      else if (b.dataset.go === 'missing') { state.filters.state = 'missing'; const sel = $('#filter-state'); if (sel) sel.value = 'missing'; loadAssets(); }
      else { const cb = $('#filter-unmanaged'); if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); } }
    };
  });
}

function renderFilterOptions() {
  const d = state.data;
  const catSel = $('#filter-category');
  const catCounts = new Map(d.stats.byCategory.map((c) => [c.category, c.count]));
  catSel.innerHTML = `<option value="all">Toutes catégories</option>` + d.categories.map((c) => {
    const n = catCounts.get(c.id);
    return `<option value="${esc(c.id)}">${esc(c.short)}${n ? ` (${n})` : ''}</option>`;
  }).join('');
  catSel.value = state.filters.category;

  const baseSel = $('#filter-base');
  const baseCounts = new Map();
  for (const row of d.stats.byBase) {
    baseCounts.set(`b:${row.base_model}`, (baseCounts.get(`b:${row.base_model}`) || 0) + row.count);
    baseCounts.set(`f:${row.base_family || row.base_model}`, (baseCounts.get(`f:${row.base_family || row.base_model}`) || 0) + row.count);
  }
  const groups = [
    ['sd15', 'SD 1.5'], ['sd2', 'SD 2.x'], ['sdxl', 'SDXL & dérivés (Pony, Illustrious…)'],
    ['sd3', 'SD 3.x'], ['flux', 'FLUX'], ['llm', 'LLM'], ['other', 'Autres'],
  ];
  const byFamily = new Map();
  for (const b of d.bases) {
    if (!byFamily.has(b.family)) byFamily.set(b.family, []);
    byFamily.get(b.family).push(b);
  }
  let html = `<option value="all">Toutes les bases</option>`;
  for (const [family, label] of groups) {
    const members = byFamily.get(family) || [];
    if (!members.length) continue;
    html += `<optgroup label="${esc(label)}">`;
    if (members.length > 1) {
      const n = baseCounts.get(`f:${family}`);
      html += `<option value="group:${esc(family)}">Toute la famille — ${esc(label)}${n ? ` (${n})` : ''}</option>`;
    }
    for (const b of members) {
      const n = baseCounts.get(`b:${b.id}`);
      html += `<option value="${esc(b.id)}">${esc(b.label)}${n ? ` (${n})` : ''}</option>`;
    }
    html += '</optgroup>';
  }
  baseSel.innerHTML = html;
  baseSel.value = state.filters.base;

  const rootSel = $('#filter-root');
  rootSel.innerHTML = `<option value="all">Tous les emplacements</option>`
    + d.roots.map((r) => `<option value="${r.id}">${esc(r.name)}${r.exists ? '' : ' (hors ligne)'}</option>`).join('');
  rootSel.value = state.filters.rootId;
}

function updateDupBadge() {
  const badge = $('#dup-badge');
  const n = state.data.stats.duplicateGroups;
  badge.textContent = n;
  badge.classList.toggle('hidden', !n);
}

function switchView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'catalogue') loadAssets();
  if (view === 'duplicates') loadDuplicates();
  if (view === 'scan') loadUnmanaged();
  if (view === 'disks') { renderVolumes(); renderFreePanel(); }
}

async function refreshAll() {
  try {
    await loadState();
    if (state.view === 'catalogue') await loadAssets();
    if (state.view === 'duplicates') await loadDuplicates();
    if (state.view === 'scan') await loadUnmanaged();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

async function loadAssets({ append = false } = {}) {
  const f = state.filters;
  syncSortHeaders();
  const params = new URLSearchParams({
    q: f.q, category: f.category, base: f.base, rootId: f.rootId, role: f.role,
    unmanaged: f.unmanaged ? '1' : '0',
    state: f.state,
    sort: f.sort, dir: f.dir,
    limit: '200',
    offset: append ? String(state.assets.items.length) : '0',
  });
  try {
    const res = await api(`/api/assets?${params}`);
    state.assets.items = append ? [...state.assets.items, ...res.items] : res.items;
    state.assets.total = res.total;
    renderAssets();
  } catch (err) {
    toast(err.message, 'error');
  }
}

const GROUP_LABELS = { category: 'Type', base: 'Base', location: 'Emplacement' };

function groupInfo(a, mode) {
  if (mode === 'category') {
    const id = a.category || null;
    const info = id ? catInfo(id) : null;
    return { key: id ? `cat:${id}` : 'cat:none', label: info?.short || info?.label || 'Non classé', volume: '' };
  }
  if (mode === 'base') {
    const id = a.base_model || null;
    const info = id ? baseInfo(id) : null;
    return { key: id ? `base:${id}` : 'base:none', label: info?.label || id || 'Non classé', volume: '' };
  }
  if (a.root_id == null) {
    return { key: 'root:none', label: a.managed ? 'Sans emplacement' : 'Hors racine', volume: '' };
  }
  return { key: `root:${a.root_id}`, label: a.root_name || `Racine #${a.root_id}`, volume: a.volume || '' };
}

function groupAssets(items, mode) {
  const groups = new Map();
  for (const a of items) {
    const info = groupInfo(a, mode);
    let group = groups.get(info.key);
    if (!group) {
      group = { ...info, items: [], bytes: 0 };
      groups.set(info.key, group);
    }
    group.items.push(a);
    group.bytes += a.size_bytes || 0;
  }
  return [...groups.values()].sort((a, b) =>
    a.label.localeCompare(b.label, 'fr', { numeric: true, sensitivity: 'base' }));
}

function renderGroupRow(group) {
  const n = group.items.length;
  return `
    <tr class="group-row">
      <td colspan="10">
        <div class="group-row-inner">
          <div class="group-title">
            <span class="group-label">${esc(group.label)}</span>
            ${group.volume ? `<span class="badge soft">${esc(group.volume)}</span>` : ''}
          </div>
          <div class="group-meta">${n} modèle${n > 1 ? 's' : ''} · ${humanBytes(group.bytes)}</div>
        </div>
      </td>
    </tr>
  `;
}

function renderAssetRow(a) {
  const name = a.title || a.file_name;
  const sub = a.abs_path;
  const loc = a.root_name || (a.managed ? '—' : 'hors racine');
  const vol = a.volume || '';
  const dir = a.abs_path.slice(0, Math.max(0, a.abs_path.length - a.file_name.length)).replace(/\\$/, '');
  const status = a.state === 'missing'
    ? '<span class="badge danger">absent</span>'
    : !a.managed ? '<span class="badge warn">non géré</span>' : '';
  return `
    <tr data-id="${a.id}" class="${state.sel.has(a.id) ? 'selected' : ''} ${state.quant.fresh.has(a.id) ? 'row-fresh' : ''}">
      <td class="cell-sel"><input type="checkbox" class="row-sel" data-id="${a.id}" ${state.sel.has(a.id) ? 'checked' : ''} title="Sélectionner (Maj+clic : toute une plage)"></td>
      <td class="cell-name">
        <div class="name-main" title="Ouvrir la fiche du modèle">${famBadge(name)} ${esc(name)}</div>
        ${/\.gguf$/i.test(a.file_name) && /(?:^|[-_.])I?Q[23](?:_[A-Z0-9]+)*\.gguf$/i.test(a.file_name) ? '<span class="badge xl" title="Version allégée avec perte : utilisée par le mode extra-light">⚠ EXTRA-LIGHT</span>' : ''}<div class="name-sub" title="${esc(sub)}">${esc(sub)}</div>
      </td>
      <td>${catBadge(a.category)}</td>
      <td>${baseBadge(a.base_model, a.base_family)}${a.version ? `<div class="muted small">${esc(a.version)}</div>` : ''}</td>
      <td>
        <div class="loc-main">${esc(loc)} ${vol ? `<span class="badge soft">${esc(vol)}</span>` : ''}</div>
        <div class="loc-sub" title="${esc(dir)}">${esc(dir)}</div>
      </td>
      <td class="num">${humanBytes(a.size_bytes)}</td>
      <td>${humanDate(a.mtime)}</td>
      <td class="actions">
        ${status}
        ${a.state === 'missing' ? `<button class="btn ghost small" data-action="forget" data-id="${a.id}" title="Le fichier n’existe plus : le retirer de l’index">Oublier</button>` : `<div class="mv-stack">
          <button class="btn small" data-action="mv-store" data-id="${a.id}" data-size="${a.size_bytes}" data-name="${esc(name)}" ${a.root_role === 'active' ? '' : 'disabled'} title="${a.root_role === 'active' ? 'Envoie le modèle dans un repo de stockage (déplacement vérifié)' : 'Déjà rangé, ou hors de tes repos'}">Ranger</button>
          <button class="btn small" data-action="mv-active" data-id="${a.id}" data-size="${a.size_bytes}" data-name="${esc(name)}" ${a.root_role === 'store' ? '' : 'disabled'} title="${a.root_role === 'store' ? 'Rapatrie le modèle dans un repo actif, à sa place d’origine' : 'Déjà dans un repo actif, ou hors de tes repos'}">Invoquer</button></div>`}
      </td>
      <td class="cell-q">${/\.gguf$/i.test(a.file_name) && !/mmproj/i.test(a.file_name) && a.state !== 'missing' ? `<button class="btn small" data-action="quant" data-id="${a.id}" title="Fabriquer une version plus légère de ce modèle (avec perte)">⚗ Quantifier</button>` : '<span class="muted">—</span>'}</td>
      <td class="cell-del"><button class="btn danger small" data-action="row-trash" data-id="${a.id}" title="Mettre à la corbeille (Maj + clic : effacer définitivement, sans corbeille)">🗑 Supprimer</button></td>
    </tr>
  `;
}

// Tri par clic sur « Taille » / « Date » : un premier clic trie du plus grand / récent au plus petit / ancien, un second inverse.
function syncSortHeaders() {
  $$('#assets-table thead th.th-sort').forEach((th) => {
    const on = state.filters.sort === th.dataset.sort;
    th.classList.toggle('sorted', on);
    th.dataset.dir = on ? state.filters.dir : '';
    th.setAttribute('aria-sort', on ? (state.filters.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });
  const sel = $('#sort');
  if (sel) sel.value = `${state.filters.sort}:${state.filters.dir}`;
}
function toggleSort(key) {
  const same = state.filters.sort === key;
  state.filters.sort = key;
  state.filters.dir = same && state.filters.dir === 'desc' ? 'asc' : 'desc';
  syncSortHeaders();
  loadAssets();
}

function syncGroupHeaders() {
  $$('#assets-table thead th.th-group').forEach((th) => {
    const active = state.groupBy === th.dataset.group;
    th.setAttribute('aria-pressed', active ? 'true' : 'false');
    th.classList.toggle('active', active);
  });
  const chip = $('#clear-group');
  if (!chip) return;
  if (state.groupBy) {
    chip.innerHTML = `Regroupé par <b>${esc(GROUP_LABELS[state.groupBy])}</b><span class="x" aria-hidden="true">✕</span>`;
    chip.title = `Vue regroupée par ${GROUP_LABELS[state.groupBy]} — cliquer pour revenir à la vue plate`;
    chip.classList.remove('hidden');
  } else {
    chip.classList.add('hidden');
  }
}

function toggleGroup(mode) {
  state.groupBy = state.groupBy === mode ? null : mode;
  renderAssets();
}

// ---- sélection multiple (cases à cocher devant les noms) : Corbeille / Effacer / Déplacer en une fois
function pruneSelection() {
  const ids = new Set(state.assets.items.map((a) => a.id));
  for (const id of [...state.sel]) if (!ids.has(id)) state.sel.delete(id);
}
function renderSelBar() {
  const bar = $('#sel-bar'); if (!bar) return;
  const items = state.assets.items;
  const chosen = items.filter((a) => state.sel.has(a.id));
  const all = $('#sel-all');
  if (all) { all.checked = items.length > 0 && chosen.length === items.length; all.indeterminate = chosen.length > 0 && chosen.length < items.length; }
  $$('#assets-body tr[data-id]').forEach((tr) => { const on = state.sel.has(Number(tr.dataset.id)); tr.classList.toggle('selected', on); const c = tr.querySelector('.row-sel'); if (c) c.checked = on; });
  if (!items.length) { bar.classList.add('hidden'); return; }
  const bytes = chosen.reduce((s, a) => s + a.size_bytes, 0);
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <span class="sel-count">${chosen.length ? `<b>${chosen.length}</b> sélectionné(s) · ${humanBytes(bytes)}` : 'Aucune sélection'}</span>
    <button class="btn ghost small" data-action="sel-all">Tout sélectionner</button>
    <button class="btn ghost small" data-action="sel-none" ${chosen.length ? '' : 'disabled'}>Tout désélectionner</button>
    <button class="btn ghost small" data-action="sel-invert">Inverser</button>
    <span class="grow"></span>
    <button class="btn small" data-action="bulk-move" ${chosen.length ? '' : 'disabled'}>Déplacer…</button>
    <button class="btn danger small" data-action="bulk-trash" ${chosen.length ? '' : 'disabled'}>Corbeille</button>
    <button class="btn danger small" data-action="bulk-erase" ${chosen.length ? '' : 'disabled'} title="Efface pour de bon, sans corbeille (comme Maj+Suppr)">Effacer</button>`;
}
const selectedAssets = () => state.assets.items.filter((a) => state.sel.has(a.id));

// Lance la corbeille / l'effacement et retire AUSSITÔT les lignes de la liste (sans attendre la fin du travail) ;
// à la fin, la liste est relue : un fichier qui n'a pas pu partir réapparaît.
function dropFromLists(ids) {
  const gone = new Set(ids);
  state.assets.items = state.assets.items.filter((a) => !gone.has(a.id));
  state.assets.total = Math.max(0, (state.assets.total || 0) - ids.length);
  for (const id of gone) { state.sel.delete(id); state.dupSel.delete(id); }
  state.dupItems = state.dupItems.filter((i) => !gone.has(i.id));
  if (state.dupGroups) state.dupGroups = state.dupGroups.map((g) => g.filter((id) => !gone.has(id))).filter((g) => g.length > 1);
  renderAssets();
  $$('#duplicates-list .dup-item').forEach((el) => { if (gone.has(Number(el.querySelector('.dup-sel')?.dataset.id))) el.remove(); });
  $$('#duplicates-list .dup-group').forEach((g) => { if (g.querySelectorAll('.dup-item').length < 2) g.remove(); });
  renderDupBar();
}
async function startTrash(ids, permanent) {
  const keepLast = !!$('#view-duplicates')?.classList.contains('active'); // écran Doublons : jamais la dernière copie
  const job = await api('/api/jobs/trash', { method: 'POST', body: JSON.stringify({ assetIds: ids, permanent: !!permanent, keepLast }) });
  dropFromLists(ids);
  trackJob(job);
}
async function bulkTrash(erase, list = selectedAssets()) {
  if (!list.length) return;
  const sum = humanBytes(list.reduce((s, a) => s + (a.size_bytes || 0), 0));
  const names = list.slice(0, 6).map((a) => `• ${a.title || a.file_name}`).join('\n') + (list.length > 6 ? `\n… et ${list.length - 6} autre(s)` : '');
  if (!confirm(erase ? `Effacer DÉFINITIVEMENT ${list.length} fichier(s) (${sum}) ?\nSans corbeille, irréversible.\n\n${names}` : `Mettre ${list.length} fichier(s) (${sum}) dans la corbeille Windows de leur disque ?\n\n${names}`)) return;
  if (erase && !confirmErase()) return;
  state.sel.clear(); state.dupSel.clear(); await startTrash(list.map((a) => a.id), erase);
}
function openBulkMove(list = selectedAssets()) {
  if (!list.length) return;
  const dests = state.data.roots.filter((r) => r.exists);
  if (!dests.length) { toast('Aucune racine de destination en ligne. Ajoute un disque dans Réglages.', 'warn'); return; }
  openModal(`Déplacer ${list.length} fichier(s)`, `
    <p class="muted small" style="margin-bottom:12px">${list.length} fichier(s) · ${humanBytes(list.reduce((s, a) => s + (a.size_bytes || 0), 0))}</p>
    <div class="form-grid">
      <label>Destination</label>
      <select id="bmv-dest" class="input">${dests.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.path)}</option>`).join('')}</select>
      <label>Action</label>
      <div><label class="check"><input type="radio" name="bmv-mode" value="move" checked> déplacer (libère la source)</label>
      <label class="check"><input type="radio" name="bmv-mode" value="copy"> copier (garde l'original)</label></div>
    </div>`, {
    footerHtml: '<button class="btn primary" id="bmv-go">Lancer le transfert</button><button class="btn ghost" data-close="1">Annuler</button>',
    onMount: (root) => {
      root.querySelector('#bmv-go').addEventListener('click', async () => {
        const toRootId = Number(root.querySelector('#bmv-dest').value);
        const mode = root.querySelector('input[name="bmv-mode"]:checked').value;
        closeModal(); state.sel.clear(); state.dupSel.clear(); await startBulkMove(list.map((a) => a.id), toRootId, mode);
      });
    },
  });
}
let lastSelId = null;
function onSelChange(e) {
  const c = e.target.closest('.row-sel');
  if (!c) return;
  const id = Number(c.dataset.id);
  if (e.shiftKey && lastSelId != null) { // plage depuis la dernière case cochée, dans l'ordre affiché
    const ids = $$('#assets-body tr[data-id]').map((tr) => Number(tr.dataset.id));
    const a = ids.indexOf(lastSelId); const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) for (const k of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) c.checked ? state.sel.add(k) : state.sel.delete(k);
  } else c.checked ? state.sel.add(id) : state.sel.delete(id);
  lastSelId = id; renderSelBar();
}

// ---------------------------------------------------------------------------
// Quantification : niveaux proposés, ligne de progression, nouveau modèle surligné en orange jusqu'au premier clic
// ---------------------------------------------------------------------------
state.quant = { running: false, fresh: new Set(), last: null };
let quantTimer = null;
function quantRowHtml() {
  const q = state.quant.last; if (!q || !q.running) return '';
  return `<tr class="row-quant"><td></td><td colspan="9"><div class="name-main">⚗ ${esc(q.name)} → <b>${esc(q.target)}</b> <span class="muted small">en fabrication · ${esc(q.step || '')} · ≈ ${humanBytes(q.estimateBytes || 0)}</span></div>
    <div class="q-bar"><i style="width:${Number(q.pct) || 0}%"></i></div><div class="muted small">${Number(q.pct) || 0} % — la ligne devient le nouveau modèle à la fin.</div></td></tr>`;
}
async function pollQuant(first = false) {
  clearTimeout(quantTimer);
  let q; try { q = await api('/api/quantize/status'); } catch { return; }
  const was = state.quant.running;
  state.quant.running = !!q.running; state.quant.last = q; state.quant.fresh = new Set(q.fresh || []);
  if (q.running) { renderAssets(); quantTimer = setTimeout(pollQuant, 1500); return; }
  if (was) {
    if (q.error) toast(q.error, 'error'); else toast(`Version ${q.target} prête : elle apparaît en orange dans la liste.`);
    await loadAssets();
  } else if (first && state.data?.roots) renderAssets(); // au démarrage, le catalogue n’est peut-être pas encore chargé
}
async function openQuantDialog(id) {
  const a = state.assets.items.find((x) => x.id === id); if (!a) return;
  let o; try { o = await api(`/api/quantize/options?assetId=${id}`); } catch (e) { toast(e.message, 'error'); return; }
  const name = a.title || a.file_name;
  if (!o.ok) { openModal(`Quantifier : ${name}`, `<p>${esc(o.reason)}</p>`, { footerHtml: '<button class="btn" data-close="1">Fermer</button>' }); return; }
  const rows = o.levels.map((l, i) => `<label class="q-lvl r${l.risk}"><input type="radio" name="q-pick" value="${esc(l.q)}" ${l.risk === 1 && !o.levels.some((x, j) => j < i && x.risk === 1) ? 'checked' : ''}>
    <div><b>${esc(l.label)}</b> <span class="muted small">≈ ${humanBytes(l.estimateBytes)}</span><div class="muted small">${esc(l.note)}</div>${l.warn ? `<div class="q-warn">⚠ ${esc(l.warn)}</div>` : ''}</div></label>`).join('');
  openModal(`Quantifier : ${name}`, `<p class="muted small">Niveau actuel : <b>${esc(o.source)}</b> (${humanBytes(a.size_bytes)}). Un nouveau fichier est créé à côté de l’original, qui n’est pas touché. <b>Plus on quantifie, plus le modèle perd en qualité</b> : choisis un niveau suggéré, pas le plus bas.</p>${rows}`,
    { footerHtml: '<button class="btn" data-close="1">Annuler</button> <button class="btn primary" id="q-go">⚗ Fabriquer</button>',
      onMount: (root) => { root.querySelector('#q-go').onclick = async () => {
        const t = root.querySelector('input[name=q-pick]:checked')?.value; if (!t) return;
        try { await api('/api/quantize/start', { method: 'POST', body: JSON.stringify({ assetId: id, target: t, confirm: true }) }); closeModal(); pollQuant(); } catch (e) { toast(e.message, 'error'); }
      }; } });
}
document.addEventListener('click', (e) => {
  const qb = e.target.closest('[data-action="quant"]'); if (qb) { openQuantDialog(Number(qb.dataset.id)); return; }
  const fr = e.target.closest('tr.row-fresh');
  if (fr) { const id = Number(fr.dataset.id); state.quant.fresh.delete(id); fr.classList.remove('row-fresh'); api('/api/quantize/seen', { method: 'POST', body: JSON.stringify({ id }) }).catch(() => {}); }
});
pollQuant(true);

function renderAssets() {
  const body = $('#assets-body');
  const items = state.assets.items;
  pruneSelection();
  syncGroupHeaders();
  $('#table-count').textContent = `${state.assets.total} résultat(s)`;
  const shownBytes = items.reduce((s, a) => s + a.size_bytes, 0);
  $('#table-total-bytes').textContent = items.length
    ? `${items.length} affiché(s) · ${humanBytes(shownBytes)}`
    : '';

  if (!items.length) {
    body.innerHTML = '';
    let hint;
    if (state.filters.state === 'trashed') hint = 'La corbeille est vide.';
    else if (state.filters.state === 'missing') hint = 'Aucun fichier absent : tout est là.';
    else if (state.filters.q || state.filters.category !== 'all' || state.filters.base !== 'all' || state.filters.rootId !== 'all' || state.filters.unmanaged) {
      hint = 'Aucun modèle ne correspond à ces filtres.';
    } else if (!state.data.roots.length) {
      hint = 'Aucune racine configurée. Va dans Réglages pour ajouter un dossier, ou Scanner un disque.';
    } else {
      hint = 'Aucun modèle indexé pour l\'instant. Lance un scan depuis l\'onglet Scanner.';
    }
    $('#empty-hint').textContent = hint;
    $('#load-more').classList.add('hidden');
    renderSelBar();
    return;
  }
  $('#empty-hint').textContent = '';

  const qrow = quantRowHtml();
  if (state.groupBy) {
    body.innerHTML = qrow + groupAssets(items, state.groupBy)
      .map((group) => renderGroupRow(group) + group.items.map(renderAssetRow).join(''))
      .join('');
  } else {
    body.innerHTML = qrow + items.map(renderAssetRow).join('');
  }

  $('#load-more').classList.toggle('hidden', items.length >= state.assets.total);
  renderSelBar();
}

// ---------------------------------------------------------------------------
// Disques
// ---------------------------------------------------------------------------

function renderVolumes() {
  const grid = $('#volumes-grid');
  const volumes = state.data.volumes;
  if (!volumes.length) {
    grid.innerHTML = `<div class="panel"><div class="empty"><b>Aucun disque enregistré</b>Ajoute une racine dans Réglages pour commencer.</div></div>`;
    return;
  }
  grid.innerHTML = volumes.map((v) => {
    const used = v.total && v.free != null ? v.total - v.free : null;
    const pct = v.total && v.free != null ? Math.min(100, Math.round((used / v.total) * 100)) : 0;
    const hot = v.free != null && v.total ? v.free / v.total < 0.12 : false;
    return `
      <div class="volume-card">
        <div class="vol-head">
          <span class="vol-name">${esc(v.volume)}</span>
          <span class="vol-free">${v.exists && v.free != null ? `<b>${humanBytes(v.free)}</b> libres / ${humanBytes(v.total)}` : '<span class="badge danger">hors ligne</span>'}</span>
        </div>
        <div class="bar ${hot ? 'hot' : ''}"><i style="width:${pct}%"></i></div>
        <div class="row-between small muted">
          <span>${v.assetCount} modèle(s) · ${humanBytes(v.assetBytes)}</span>
          <span>${v.exists ? `${pct}% utilisé` : 'disque absent'}</span>
        </div>
        <div class="vol-roots">
          ${v.roots.map((r) => `
            <div class="vol-root">
              <div style="min-width:0">
                <b>${esc(r.name)}</b>
                <span class="badge soft">${esc(r.role)}</span>
                <div class="path" title="${esc(r.path)}">${esc(r.path)}</div>
              </div>
              <button class="btn ghost small" data-action="root-scan" data-path="${esc(r.path)}" data-root-id="${r.id}">Scanner</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function renderFreePanel() {
  const sel = $('#free-volume');
  const volumes = state.data.volumes.filter((v) => v.exists);
  sel.innerHTML = volumes.map((v) => `<option value="${esc(v.volume)}">${esc(v.volume)} — ${humanBytes(v.free)} libres</option>`).join('');
  $('#suggest-result').innerHTML = '';
  state.suggestion = null;
  if (!volumes.length) {
    $('#suggest-result').innerHTML = '<div class="warn-box mt12">Aucun volume en ligne.</div>';
  }
}

async function suggestPlan() {
  const volume = $('#free-volume').value;
  const needGo = Number($('#free-need').value || 0);
  if (!volume) return;
  try {
    const res = await api(`/api/suggest?volume=${encodeURIComponent(volume)}&need=${Math.round(needGo * 1024 ** 3)}&sort=size`);
    state.suggestion = res;
    const destRoots = state.data.roots.filter((r) => r.exists
      && String(r.volume || '').toUpperCase() !== String(volume).toUpperCase());
    renderSuggestion(res, destRoots);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderSuggestion(res, destRoots) {
  if (!res.items.length) {
    $('#suggest-result').innerHTML = '<div class="empty"><b>Rien à déplacer</b>Aucun modèle indexé sur ce volume.</div>';
    return;
  }
  if (!destRoots.length) {
    $('#suggest-result').innerHTML = '<div class="warn-box mt12">Ajoute d\'abord une racine d\'archive sur un autre disque (Réglages).</div>';
    return;
  }
  const html = `
    <div class="suggest-list">
      ${res.items.map((a, i) => `
        <label class="suggest-row">
          <input type="checkbox" class="sg-check" value="${a.id}" ${res.need > 0 && i < res.count ? 'checked' : ''} data-size="${a.size_bytes}">
          <div style="min-width:0">
            <div>${famBadge(a.title || a.file_name)} ${esc(a.title || a.file_name)} <span class="badge cat-${esc(a.category)}">${esc(catInfo(a.category).short)}</span></div>
            <div class="sub" title="${esc(a.abs_path)}">${esc(a.abs_path)}</div>
          </div>
          <div>${humanBytes(a.size_bytes)}</div>
        </label>
      `).join('')}
    </div>
    <div class="suggest-summary">
      <span>Sélection : <b id="sg-selected-bytes">0 o</b> / ${res.items.length} candidat(s)</span>
      <select id="sg-dest" class="input">
        ${destRoots.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.path)}</option>`).join('')}
      </select>
      <label class="check"><input type="checkbox" id="sg-copy"> copier au lieu de déplacer</label>
      <button class="btn primary" id="sg-go">Déplacer la sélection</button>
    </div>
  `;
  $('#suggest-result').innerHTML = html;
  updateSuggestBytes();
  $$('#suggest-result .sg-check').forEach((cb) => cb.addEventListener('change', updateSuggestBytes));
  $('#sg-go').addEventListener('click', () => {
    const ids = $$('#suggest-result .sg-check').filter((cb) => cb.checked).map((cb) => Number(cb.value));
    if (!ids.length) { toast('Sélectionne au moins un modèle.', 'warn'); return; }
    const toRootId = Number($('#sg-dest').value);
    const copy = $('#sg-copy').checked;
    startBulkMove(ids, toRootId, copy ? 'copy' : 'move');
  });
}

function updateSuggestBytes() {
  const total = $$('#suggest-result .sg-check').filter((cb) => cb.checked).reduce((s, cb) => s + Number(cb.dataset.size || 0), 0);
  const el = $('#sg-selected-bytes');
  if (el) el.textContent = humanBytes(total);
}

async function startBulkMove(assetIds, toRootId, mode) {
  try {
    const job = await api('/api/jobs/bulk-transfer', {
      method: 'POST',
      body: JSON.stringify({ assetIds, toRootId, mode }),
    });
    trackJob(job);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Doublons
// ---------------------------------------------------------------------------

// Plan proposé par PAIZ pour chaque groupe (copie gardée + sort de chaque autre copie), calculé par le serveur (dedupe.js).
const DUP_ACT = {
  link: ['🔗', 'lien dur', 'ok'],
  trash: ['🗑', 'corbeille', 'warn'],
  keep: ['🛡', 'gardée', 'soft'],
  done: ['✔', 'déjà fusionnée', 'ok'],
};
async function loadDuplicates() {
  const container = $('#duplicates-list');
  if (!container.children.length) container.innerHTML = '<div class="empty">Analyse…</div>';
  $('#view-duplicates').classList.toggle('dup-manual', !!state.dupManual);
  try {
    state.dupKeep ||= {};
    const { groups } = await api(`/api/duplicates?keep=${encodeURIComponent(JSON.stringify(state.dupKeep))}`);
    state.dupPlan = groups;
    state.dupItems = groups.flatMap((g) => g.items.map((i) => ({ ...i, size_bytes: i.size_bytes || g.size })));
    state.dupGroups = groups.map((g) => g.items.map((i) => i.id));
    const live = new Set(state.dupItems.map((i) => i.id)); for (const id of [...state.dupSel]) if (!live.has(id)) state.dupSel.delete(id);
    if (!groups.length) {
      renderDupBar();
      container.innerHTML = '<div class="empty"><b>Aucun doublon</b>Ton catalogue est propre de ce côté.</div>';
      return;
    }
    const todo = groups.filter((g) => (g.actions || []).some((a) => a.action === 'link' || a.action === 'trash'));
    const linkB = groups.reduce((n, g) => n + (g.saves || 0), 0); const trashB = groups.reduce((n, g) => n + (g.trashSaves || 0), 0);
    const summary = `<div class="dup-smart">
      <div class="grow"><b>${todo.length ? `${humanBytes(linkB)} à récupérer sans rien casser` : 'Rien à fusionner'}</b>
        <div class="muted small">${groups.length} fichier(s) en plusieurs copies. PAIZ garde la copie du dossier le plus utile (prêts à lancer, le plus actif) et transforme les autres copies du même disque en <b>liens durs</b> : chaque chemin continue de marcher, le fichier n'est stocké qu'une fois.</div>
        ${trashB ? `<label class="check small"><input type="checkbox" id="dup-trash-extra" ${state.dupTrash ? 'checked' : ''}> mettre aussi à la corbeille les copies en trop sur un autre disque (${humanBytes(trashB)}, récupérables)</label>` : ''}
        <div class="dup-guards">Garde-fous : contenu comparé octet par octet avant tout · jamais la copie chargée dans le moteur · jamais la dernière copie · rien d'effacé, au pire la corbeille Windows · les copies qu'un programme attend (ComfyUI, SwarmUI…) ou qui servent de sauvegarde sur un autre disque sont gardées.</div></div>
      <div class="dup-smart-a"><button class="btn primary" data-action="dup-smart-all" ${todo.length ? '' : 'disabled'}>✨ Tout fusionner (${todo.length})</button>
        <label class="check small"><input type="checkbox" id="dup-manual" ${state.dupManual ? 'checked' : ''}> mode manuel</label></div></div>`;
    container.innerHTML = summary + groups.map((g) => {
      const act = new Map((g.actions || []).map((a) => [a.id, a]));
      const can = (g.actions || []).some((a) => a.action === 'link' || (a.action === 'trash' && state.dupTrash));
      return `
      <div class="dup-group">
        <div class="dup-head">
          <div class="grow">
            ${famBadge(g.items[0].file_name)} <b>${esc(g.items[0].file_name)}</b>
            <div class="muted small">${g.count} copies · ${humanBytes(g.size)} chacune · ${g.merged ? '<span class="badge ok">✔ déjà fusionnées : rien de gaspillé</span>' : g.saves ? `${humanBytes(g.saves)} récupérables` : 'copies sur des disques différents'}</div>
          </div>
          ${can ? `<button class="btn small" data-action="dup-smart" data-hash="${esc(g.hash)}">✨ Fusionner</button>` : ''}
        </div>
        ${g.items.map((item, idx) => { const a = act.get(item.id); const k = idx === 0 ? ['⭐', 'gardée', 'ok'] : DUP_ACT[a?.action] || ['', '', 'soft'];
          return `
          <div class="dup-item ${idx === 0 ? 'keeper' : ''} ${state.dupSel.has(item.id) ? 'selected' : ''}">
            <input type="checkbox" class="dup-sel dup-manual-only" data-id="${item.id}" ${state.dupSel.has(item.id) ? 'checked' : ''} title="Sélectionner cette copie (Maj+clic : plage)">
            <span class="badge ${k[2]} dup-act">${k[0]} ${k[1]}</span>
            <div class="grow dup-where"><span class="path" title="${esc(item.abs_path)}">${esc(item.abs_path)}</span>
              <span class="muted small">${idx === 0 ? esc((g.keepWhy || []).join(' · ')) : esc(a?.why || '')}</span></div>
            <span class="badge soft">${esc(item.rootName || item.root_name || 'hors dossier PAIZ')}</span>
            ${idx === 0 ? '' : `<button class="btn ghost small" data-action="dup-prefer" data-hash="${esc(g.hash)}" data-id="${item.id}" title="Garder plutôt cette copie : le plan est recalculé, rien n'est encore fait">Garder plutôt celle-ci</button>`}
            <button class="btn danger small dup-manual-only" data-action="trash-one" data-id="${item.id}" title="Mettre cette copie à la corbeille">Corbeille</button>
          </div>`; }).join('')}
        ${state.dupKeep[g.hash] ? `<div class="small"><button class="btn ghost small" data-action="dup-auto" data-hash="${esc(g.hash)}">↺ Laisser PAIZ choisir</button></div>` : ''}
      </div>`; }).join('');
    renderDupBar();
  } catch (err) {
    container.innerHTML = `<div class="err-box">${esc(err.message)}</div>`;
  }
}
async function runSmartMerge(hashes) {
  const plans = (state.dupPlan || []).filter((g) => hashes.includes(g.hash));
  const acts = plans.flatMap((g) => g.actions || []);
  const links = acts.filter((a) => a.action === 'link'); const trash = state.dupTrash ? acts.filter((a) => a.action === 'trash') : [];
  const kept = acts.filter((a) => a.action === 'keep' || (a.action === 'trash' && !state.dupTrash));
  if (!links.length && !trash.length) { toast('Rien à fusionner ici.'); return; }
  const bytes = [...links, ...trash].reduce((n, a) => n + (a.saves || 0), 0);
  const lines = [`${links.length} copie(s) deviendront des liens durs (leurs chemins continuent de marcher)`];
  if (trash.length) lines.push(`${trash.length} copie(s) en trop sur un autre disque iront à la corbeille Windows`);
  if (kept.length) lines.push(`${kept.length} copie(s) gardées telles quelles`);
  if (!confirm(`Fusionner ${plans.length} doublon(s) ? ${humanBytes(bytes)} récupérés.\n\n• ${lines.join('\n• ')}\n\nChaque copie est d'abord comparée octet par octet à celle qu'on garde (peut prendre quelques minutes sur de gros fichiers). Au moindre écart, rien n'est touché.`)) return;
  try {
    const job = await api('/api/duplicates/smart', { method: 'POST', body: JSON.stringify({ hashes, keep: state.dupKeep || {}, trash: !!state.dupTrash, confirm: true }) });
    trackJob(job, { onDone: (j) => {
      const r = j.result || {}; const bad = (r.skipped || []).filter((x) => /échec|différent|disparu|impossible/.test(x.why));
      toast(`${humanBytes(r.saved || 0)} récupérés · ${(r.done || []).length} copie(s) fusionnée(s).${bad.length ? ' Non touchées : ' + bad.map((x) => x.why).join(' ; ') : ''}`, bad.length ? 'error' : undefined);
    } });
  } catch (err) { toast(err.message, 'error'); }
}

const dupChosen = () => state.dupItems.filter((i) => state.dupSel.has(i.id));
function renderDupBar() {
  const bar = $('#dup-bar'); if (!bar) return;
  if (!state.dupItems.length || !state.dupManual) { bar.classList.add('hidden'); return; }
  const chosen = dupChosen(); const bytes = chosen.reduce((s, a) => s + (a.size_bytes || 0), 0);
  $$('#duplicates-list .dup-item').forEach((el) => { const c = el.querySelector('.dup-sel'); if (!c) return; const on = state.dupSel.has(Number(c.dataset.id)); c.checked = on; el.classList.toggle('selected', on); });
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <span class="sel-count">${chosen.length ? `<b>${chosen.length}</b> sélectionnée(s) · ${humanBytes(bytes)}` : 'Aucune sélection'}</span>
    <button class="btn ghost small" data-action="dsel-extra" title="Coche, dans chaque groupe, toutes les copies sauf celle que PAIZ garde (⭐)">Copies en trop (garder ⭐)</button>
    <button class="btn ghost small" data-action="dsel-all">Tout sélectionner</button>
    <button class="btn ghost small" data-action="dsel-none" ${chosen.length ? '' : 'disabled'}>Tout désélectionner</button>
    <button class="btn ghost small" data-action="dsel-invert">Inverser</button>
    <span class="grow"></span>
    <button class="btn small" data-action="dbulk-move" ${chosen.length ? '' : 'disabled'}>Déplacer…</button>
    <button class="btn danger small" data-action="dbulk-trash" ${chosen.length ? '' : 'disabled'}>Corbeille</button>
    <button class="btn danger small" data-action="dbulk-erase" ${chosen.length ? '' : 'disabled'} title="Efface pour de bon, sans corbeille">Effacer</button>`;
}
let lastDupId = null;
function onDupSelClick(e) {
  const c = e.target.closest('.dup-sel'); if (!c) return;
  const id = Number(c.dataset.id);
  if (e.shiftKey && lastDupId != null) {
    const ids = $$('#duplicates-list .dup-sel').map((x) => Number(x.dataset.id));
    const a = ids.indexOf(lastDupId); const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) for (const k of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) c.checked ? state.dupSel.add(k) : state.dupSel.delete(k);
  } else c.checked ? state.dupSel.add(id) : state.dupSel.delete(id);
  lastDupId = id; renderDupBar();
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

async function runScan() {
  const p = $('#scan-path').value.trim();
  if (!p) { toast('Indique un dossier à scanner.', 'warn'); return; }
  const payload = { path: p };
  if ($('#scan-register').checked) {
    payload.register = {
      name: $('#scan-root-name').value.trim() || p.split(/[\\/]/).filter(Boolean).pop() || 'racine',
      role: $('#scan-root-role').value,
    };
  }
  $('#scan-progress').innerHTML = '';
  try {
    const job = await api('/api/scan', { method: 'POST', body: JSON.stringify(payload) });
    trackJob(job, { onDone: (j) => renderScanResult(j) });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function runScanAll() {
  const btn = $('#btn-scan-all');
  btn.disabled = true;
  $('#scan-all-progress').innerHTML = '<div class="progress-card"><div class="row"><b>Recherche des disques…</b></div><div class="muted small">Énumération des volumes locaux. Le scan va démarrer en mode doux.</div></div>';
  try {
    const job = await api('/api/scan/disks', { method: 'POST', body: JSON.stringify({}) });
    await trackJob(job, { onDone: (j) => renderScanResult(j, '#scan-all-progress') });
  } catch (err) {
    $('#scan-all-progress').innerHTML = `<div class="err-box">${esc(err.message)}</div>`;
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function renderScanResult(job, selector = '#scan-progress') {
  const container = $(selector);
  const r = job.result;
  if (!r) {
    container.innerHTML = `<div class="err-box">${esc(job.error || 'Scan sans résultat')}</div>`;
    return;
  }
  const allDisks = job.type === 'scan-all';
  const volumes = allDisks && Array.isArray(r.volumes) ? r.volumes : [];
  const seconds = Number.isFinite(Number(r.durationMs)) ? (Number(r.durationMs) / 1000).toFixed(1) : '—';
  const volumeRows = volumes.map((v) => `
    <div class="scan-volume-row" title="${esc(v.path)}">
      <span class="sv-path">${esc(v.path)}</span>
      <span class="sv-meta">${v.total} modèle(s) · +${v.added} · ${humanBytes(v.bytes)}${v.errors ? ` · ${v.errors} err.` : ''}</span>
    </div>
  `).join('');
  container.innerHTML = `
    <div class="progress-card">
      <div class="row"><b>${allDisks ? 'Recherche terminée' : 'Scan terminé'}</b><span class="muted">${seconds} s</span></div>
      <div>${allDisks ? `${volumes.length} cible(s) · ` : ''}${r.total} modèle(s) · ${r.added} ajouté(s) · ${r.updated} mis à jour · ${humanBytes(r.bytes)}</div>
      <div class="muted small">${r.found} candidat(s) repéré(s) · ${r.dirs} dossier(s) visité(s) · ${r.skipped} fichier(s) ignoré(s)</div>
      ${volumeRows ? `<div class="scan-volume-list">${volumeRows}</div>` : ''}
      ${r.errors?.length ? `<div class="warn-box mt8">${r.errors.length} erreur(s) d'accès (dossier protégé ?).</div>` : ''}
      ${r.rootName
        ? `<div class="muted small mt8">Rattaché à la racine « ${esc(r.rootName)} ».</div>`
        : allDisks
          ? `<div class="muted small mt8">Les fichiers dans une racine existante restent rattachés ; les autres sont « non gérés » et apparaissent ci-dessous.</div>`
          : `<div class="muted small mt8">Fichiers ajoutés comme « non gérés » : tu peux les adopter ci-dessous.</div>`}
    </div>
  `;
  loadUnmanaged();
}

async function loadUnmanaged() {
  const container = $('#unmanaged-list');
  try {
    const res = await api('/api/assets?unmanaged=1&state=present&sort=size&dir=desc&limit=100');
    if (!res.items.length) {
      container.innerHTML = '<div class="empty"><b>Rien en attente</b>Tous les modèles trouvés sont rattachés à une racine (ou tu n\'as pas encore scanné).</div>';
      return;
    }
    const storeRoots = state.data.roots.filter((r) => r.exists);
    container.innerHTML = `
      <div class="toolbar" style="margin-bottom:10px">
        <span class="muted">${res.items.length} fichier(s) · ${humanBytes(res.items.reduce((s, a) => s + a.size_bytes, 0))}</span>
        <span style="margin-left:auto" class="muted small">Adopter vers :</span>
        <select id="adopt-dest" class="input">
          ${storeRoots.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.path)}</option>`).join('')}
        </select>
        <label class="check"><input type="checkbox" id="adopt-copy"> copier</label>
        <button class="btn primary" id="btn-adopt-all" ${storeRoots.length ? '' : 'disabled'}>Adopter la sélection</button>
      </div>
      ${storeRoots.length ? '' : '<div class="warn-box" style="margin-bottom:10px">Aucune racine en ligne : ajoute ou rebranche un disque de destination.</div>'}
      <div class="suggest-list">
        ${res.items.map((a) => `
          <label class="suggest-row">
            <input type="checkbox" class="adopt-check" value="${a.id}" data-size="${a.size_bytes}">
            <div style="min-width:0">
              <div>${famBadge(a.title || a.file_name)} ${esc(a.title || a.file_name)} <span class="badge cat-${esc(a.category)}">${esc(catInfo(a.category).short)}</span></div>
              <div class="sub" title="${esc(a.abs_path)}">${esc(a.abs_path)}</div>
            </div>
            <div>${humanBytes(a.size_bytes)}</div>
          </label>
        `).join('')}
      </div>
    `;
    $('#btn-adopt-all').addEventListener('click', async () => {
      const ids = $$('.adopt-check').filter((cb) => cb.checked).map((cb) => Number(cb.value));
      if (!ids.length) { toast('Sélectionne au moins un fichier.', 'warn'); return; }
      const rootId = Number($('#adopt-dest').value);
      const copy = $('#adopt-copy').checked;
      await startBulkMove(ids, rootId, copy ? 'copy' : 'move');
    });
  } catch (err) {
    container.innerHTML = `<div class="err-box">${esc(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

function renderRoots() {
  const container = $('#roots-list');
  if (!state.data.roots.length) {
    container.innerHTML = '<div class="empty"><b>Aucune racine</b>Ajoute un dossier ci-dessous — il peut être sur n\'importe quel disque.</div>';
    return;
  }
  container.innerHTML = state.data.roots.map((r) => `
    <div class="root-row">
      <div class="root-info">
        <div class="root-name">${esc(r.name)} <span class="badge soft">${esc(r.role)}</span>
          ${r.exists ? '' : '<span class="badge danger">hors ligne</span>'}
          ${r.volume ? `<span class="badge soft">${esc(r.volume)}</span>` : ''}
        </div>
        <div class="root-path">${esc(r.path)}</div>
      </div>
      <span class="muted small">${r.exists && r.free != null ? `${humanBytes(r.free)} libres` : ''}</span>
      <button class="btn ghost small" data-action="root-scan" data-path="${esc(r.path)}" data-root-id="${r.id}">Scanner</button>
      <button class="btn ghost small" data-action="root-rescan" data-path="${esc(r.path)}" data-root-id="${r.id}" title="Relit les métadonnées de tous les fichiers">Réanalyser</button>
      <button class="btn ghost small" data-action="root-delete" data-id="${r.id}" data-name="${esc(r.name)}">Retirer</button>
    </div>
  `).join('');
}

async function addRoot() {
  const name = $('#root-name').value.trim();
  const path = $('#root-path').value.trim();
  if (!name || !path) { toast('Nom et chemin requis.', 'warn'); return; }
  try {
    await api('/api/roots', { method: 'POST', body: JSON.stringify({ name, path, role: $('#root-role').value }) });
    $('#root-name').value = '';
    $('#root-path').value = '';
    toast(`Racine « ${name} » ajoutée.`);
    await refreshAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderEvents() {
  const events = state.data.events || [];
  const container = $('#events-list');
  if (!events.length) { container.innerHTML = '<div class="empty">Aucun événement pour le moment.</div>'; return; }
  container.innerHTML = events.map((e) => {
    let detail = '';
    if (e.detail) {
      const d = e.detail;
      if (typeof d === 'object') {
        detail = d.from && d.to ? `${d.from} → ${d.to}` : (d.path || d.name || JSON.stringify(d));
      } else detail = String(d);
    }
    return `
      <div class="event-row">
        <span class="when">${humanDateTime(e.at)}</span>
        <span class="type">${esc(e.type)}</span>
        <span>${esc(e.file_name || (e.asset_id ? `#${e.asset_id}` : ''))}</span>
        <span class="detail" title="${esc(detail)}">${esc(detail.length > 130 ? `${detail.slice(0, 130)}…` : detail)}</span>
      </div>
    `;
  }).join('');
}

function renderDataInfo() {
  const app = state.data.app;
  $('#data-info').innerHTML = `
    <div class="kv"><b>Version</b>${esc(app.name)} v${esc(app.version)}</div>
    <div class="kv"><b>Dossier de données</b><code>${esc(app.dataDir)}</code></div>
    <div class="kv"><b>Base SQLite</b><code>${esc(app.dbPath)}</code></div>
    <div class="kv"><b>API locale</b><code>/api/state</code> · <code>/api/assets</code> · <code>/api/jobs/*</code></div>
  `;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function closeModal() {
  $('#modal-root').innerHTML = '';
}

function openModal(title, bodyHtml, { footerHtml = '', wide = false, onMount = null } = {}) {
  $('#modal-root').innerHTML = `
    <div class="modal-backdrop">
      <div class="modal ${wide ? 'wide' : ''}">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="modal-close" data-close="1" title="Fermer">×</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        ${footerHtml ? `<div class="modal-foot">${footerHtml}</div>` : ''}
      </div>
    </div>
  `;
  const backdrop = $('.modal-backdrop');
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.matches('[data-close]')) closeModal();
  });
  if (onMount) onMount($('#modal-root'));
}

async function openDetails(id) {
  try {
    const a = await api(`/api/assets/${id}`);
    const li = state.assets.items.find((x) => x.id === a.id);
    const role = li?.root_role || a.root_role;
    const name = a.title || a.file_name;
    const meta = a.meta ? JSON.stringify(a.meta, null, 2) : '';
    const tags = (a.tags || []).map((t) => `<span class="pill">${esc(t)}</span>`).join('');
    const links = (a.links || []).map((l) => `<div class="dup-item"><span class="badge soft">${esc(l.kind)}</span><span class="path">${esc(l.path)}</span></div>`).join('');
    const stateBadge = a.state === 'missing' ? '<span class="badge danger">absent du disque</span>' : a.state === 'trashed' ? '<span class="badge warn">corbeille</span>' : '<span class="badge ok">présent</span>';
    const body = `
      <div class="dt-head">${famBadge(name)}<div class="grow"><div class="dt-title">${esc(name)}</div><div class="muted small dt-file">${esc(a.file_name)}</div></div>
        <div class="dt-badges">${catBadge(a.category)} ${stateBadge} ${a.managed ? '' : '<span class="badge warn">non géré</span>'} <b>${humanBytes(a.size_bytes)}</b></div></div>
      <div class="dt-cols">
        <section class="dt-sec"><h4>Identité <span class="muted small">(modifiable)</span></h4>
          <label class="dt-f">Titre<input id="d-title" class="input" value="${esc(a.title || '')}"></label>
          <label class="dt-f">Catégorie<select id="d-category" class="input">${categoryOptions(a.category)}</select></label>
          <label class="dt-f">Base / famille<select id="d-base" class="input">${baseOptions(a.base_model)}</select></label>
          <label class="dt-f">Version<input id="d-version" class="input" value="${esc(a.version || '')}"></label>
          <label class="dt-f">Notes<textarea id="d-notes" class="input" rows="3">${esc(a.notes || '')}</textarea></label></section>
        <section class="dt-sec"><h4>Fichier</h4>
          <div class="dt-kv"><span>Repo</span><b>${esc(a.root_name || (a.managed ? '—' : 'hors repo'))}${role ? ` <span class="badge soft">${role === 'active' ? '🔥 actif' : '❄ stock'}</span>` : ''}</b>
            <span>Chemin</span><code class="dt-path">${esc(a.abs_path)}</code>
            <span>Taille</span><b>${humanBytes(a.size_bytes)}</b>
            <span>Modifié le</span><b>${humanDateTime(a.mtime)}</b>
            <span>Indexé le</span><b>${humanDateTime(a.first_seen_at)}</b>
            <span>Empreinte rapide</span><code>${esc(a.quick_hash || '—')}</code>
            <span>SHA-256</span><code class="dt-path">${esc(a.sha256 || 'non calculé (bouton Empreinte)')}</code></div></section>
      </div>
      <section class="dt-sec" id="dt-links"></section>
      <section class="dt-sec" id="dt-rel"></section>
      ${tags ? `<section class="dt-sec"><h4>Étiquettes</h4><div class="pill-group">${tags}</div></section>` : ''}
      ${links ? `<section class="dt-sec"><h4>Liens créés</h4>${links}</section>` : ''}
      <details class="dt-sec"><summary>Métadonnées techniques</summary>${meta ? `<pre class="meta-json">${esc(meta)}</pre>` : '<p class="muted small">Aucune métadonnée lue.</p>'}</details>
    `;
    const mv = a.state === 'present' ? `${role === 'active' ? `<button class="btn" data-action="mv-store" data-id="${a.id}" data-size="${a.size_bytes}" data-name="${esc(name)}">Ranger</button>` : ''}${role === 'store' ? `<button class="btn primary" data-action="mv-active" data-id="${a.id}" data-size="${a.size_bytes}" data-name="${esc(name)}">Invoquer</button>` : ''}` : '';
    const footer = `
      <button class="btn primary" id="d-save">Enregistrer</button>
      ${mv}
      <button class="btn" data-action="link" data-id="${a.id}" title="Crée un lien vers ce fichier à un autre endroit, sans le copier">Créer un lien</button>
      <button class="btn" data-action="hash" data-id="${a.id}" title="Calcule le SHA-256 complet (lent)">Empreinte</button>
      <span class="grow"></span>
      ${a.state === 'trashed'
        ? `<button class="btn" data-action="restore" data-id="${a.id}">Restaurer</button>`
        : `<button class="btn danger" data-action="trash" data-id="${a.id}">Corbeille</button><button class="btn danger" data-action="erase" data-id="${a.id}" title="Efface le fichier pour de bon, sans corbeille (comme Maj+Suppr)">Effacer</button>`}
      <button class="btn ghost" data-action="forget" data-id="${a.id}" title="Retirer de l'index sans toucher au fichier">Oublier</button>
    `;
    openModal(name, body, {
      footerHtml: footer,
      wide: true,
      onMount: (root) => {
        // modèles liés : ce qu'il utilise, ce qui l'utilise, mêmes fichiers ailleurs (suggestions d'après les noms)
        api(`/api/assets/${a.id}/related`).then((r) => {
          const el = root.querySelector('#dt-rel'); if (!el) return;
          if (!r.uses.length && !r.usedBy.length && !r.same.length) { el.remove(); return; }
          const li = (x) => `<div class="dt-need"><a href="#" data-rel="${x.id}">${esc(x.name)}</a> <span class="muted small">${esc(x.file)} · ${humanBytes(x.size)}${x.root ? ' · ' + esc(x.root) : ''}</span>${x.why ? ` <span class="badge soft">${esc(x.why)}</span>` : ''}</div>`;
          el.innerHTML = `<h4>Modèles liés <span class="muted small">(suggestions d’après les noms de fichiers)</span></h4>`
            + (r.usedBy.length ? `<div class="muted small" style="margin-top:6px">Utilisé par ${r.usedBy.length} modèle(s) :</div>${r.usedBy.slice(0, 15).map(li).join('')}${r.usedBy.length > 15 ? `<div class="muted small">… et ${r.usedBy.length - 15} autre(s)</div>` : ''}` : '')
            + (r.uses.length ? `<div class="muted small" style="margin-top:6px">Utilise :</div>${r.uses.map(li).join('')}` : '')
            + (r.same.length ? `<div class="muted small" style="margin-top:6px">Même fichier ailleurs :</div>${r.same.map((x) => `<div class="dt-need"><code>${esc(x.path)}</code> ${x.linked ? '<span class="badge ok">lien dur : une seule copie sur le disque</span>' : '<span class="badge warn">copie séparée</span> <span class="muted small">(onglet Doublons pour fusionner)</span>'}</div>`).join('')}` : '');
          el.querySelectorAll('[data-rel]').forEach((l) => { l.onclick = (e) => { e.preventDefault(); openDetails(Number(l.dataset.rel)); }; });
        }).catch(() => {});
        // fichiers dont ce modèle a besoin (mmproj, VAE…) et d'où il vient s'il est rangé
        api(`/api/engine/move-info?assetId=${a.id}`).then((info) => {
          const el = root.querySelector('#dt-links'); if (!el) return;
          const needs = info.needs || []; const o = info.origin || { state: 'none' };
          if (!needs.length && o.state === 'none') { el.remove(); return; }
          const nb = (n) => n.where === 'missing' ? '<span class="badge danger">introuvable</span>' : n.where === 'apart' ? `<span class="badge warn">rangé ailleurs · ${esc(n.location?.root || '')}</span>` : '<span class="badge ok">avec lui</span>';
          el.innerHTML = `<h4>Liens</h4>${needs.map((n) => `<div class="dt-need"><span class="badge soft">${esc(n.role)}</span> <code>${esc(n.file_name)}</code> ${nb(n)}</div>`).join('')}${o.state !== 'none' ? `<div class="dt-need muted small">↩ Rangé depuis <b>${esc(o.rootName)}</b> : ${esc(o.path)}${o.state === 'gone' ? ' <span class="badge danger">ce repo n’existe plus</span>' : o.state === 'not-active' ? ' <span class="badge warn">n’est plus un repo actif</span>' : ''}</div>` : ''}`;
        }).catch(() => {});
        root.querySelector('#d-save').addEventListener('click', async () => {
          try {
            await api(`/api/assets/${a.id}`, {
              method: 'PATCH',
              body: JSON.stringify({
                title: root.querySelector('#d-title').value.trim(),
                category: root.querySelector('#d-category').value,
                base_model: root.querySelector('#d-base').value,
                version: root.querySelector('#d-version').value.trim(),
                notes: root.querySelector('#d-notes').value.trim(),
              }),
            });
            toast('Modèle mis à jour.');
            closeModal();
            await refreshAll();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      },
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openMove(id) {
  const asset = state.assets.items.find((a) => a.id === id) || await api(`/api/assets/${id}`);
  if (!state.data.roots.length) { toast('Aucune racine de destination. Ajoute-en une dans Réglages.', 'warn'); return; }
  const destinations = state.data.roots.filter((r) => r.id !== asset.root_id && r.exists);
  if (!destinations.length) { toast('Aucune autre racine en ligne disponible. Ajoute un disque de destination.', 'warn'); return; }
  const body = `
    <p class="muted small" style="margin-bottom:12px">
      <b>${esc(asset.file_name)}</b> · ${humanBytes(asset.size_bytes)}<br>
      <code>${esc(asset.abs_path)}</code>
    </p>
    <div class="form-grid">
      <label>Destination</label>
      <select id="mv-dest" class="input">
        ${destinations.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.path)}</option>`).join('')}
      </select>
      <label>Action</label>
      <div>
        <label class="check"><input type="radio" name="mv-mode" value="move" checked> déplacer (libère la source)</label>
        <label class="check"><input type="radio" name="mv-mode" value="copy"> copier (garde l'original)</label>
      </div>
      <label>Rangement</label>
      <div>
        <label class="check"><input type="checkbox" id="mv-organize"> ranger dans un sous-dossier de catégorie (loras/, checkpoints/…)</label>
      </div>
    </div>
    <div class="warn-box mt12">Le transfert est vérifié par empreinte avant toute suppression de la source. Les disques lents sont acceptés : ce n'est pas un outil de travail, c'est l'écurie.</div>
  `;
  openModal('Déplacer un modèle', body, {
    footerHtml: '<button class="btn primary" id="mv-go">Lancer le transfert</button><button class="btn ghost" data-close="1">Annuler</button>',
    onMount: (root) => {
      root.querySelector('#mv-go').addEventListener('click', async () => {
        const toRootId = Number(root.querySelector('#mv-dest').value);
        const mode = root.querySelector('input[name="mv-mode"]:checked').value;
        const organize = root.querySelector('#mv-organize').checked;
        closeModal();
        try {
          const job = await api('/api/jobs/transfer', { method: 'POST', body: JSON.stringify({ assetId: id, toRootId, mode, organize }) });
          trackJob(job);
        } catch (err) { toast(err.message, 'error'); }
      });
    },
  });
}

function openLink(id) {
  const asset = state.assets.items.find((a) => a.id === id);
  if (!asset) return;
  const dir = asset.abs_path.slice(0, Math.max(0, asset.abs_path.lastIndexOf('\\')));
  const guess = `${dir}\\links\\${asset.file_name}`;
  const body = `
    <p class="muted small" style="margin-bottom:12px">
      Crée un lien vers <b>${esc(asset.file_name)}</b> à l'endroit où une autre application l'attend.
      Le fichier reste dans le dispenser, rien n'est dupliqué.
    </p>
    <div class="form-grid">
      <label>Chemin du lien</label>
      <input id="lk-path" class="input" value="${esc(guess)}" style="max-width:none;width:100%">
      <label>Type</label>
      <div>
        <label class="check"><input type="radio" name="lk-kind" value="symlink" checked> lien symbolique</label>
        <label class="check"><input type="radio" name="lk-kind" value="hardlink"> lien physique (même disque uniquement, zéro octet)</label>
      </div>
    </div>
    <div class="warn-box mt12">Sous Windows, les liens symboliques exigent le « Mode développeur » ou un terminal administrateur. Le lien physique, lui, ne coûte aucun espace supplémentaire mais reste sur le même volume.</div>
  `;
  openModal(`Lien vers ${asset.file_name}`, body, {
    footerHtml: '<button class="btn primary" id="lk-go">Créer le lien</button><button class="btn ghost" data-close="1">Annuler</button>',
    onMount: (root) => {
      root.querySelector('#lk-go').addEventListener('click', async () => {
        const linkPath = root.querySelector('#lk-path').value.trim();
        const kind = root.querySelector('input[name="lk-kind"]:checked').value;
        closeModal();
        try {
          const job = await api('/api/jobs/link', { method: 'POST', body: JSON.stringify({ assetId: id, linkPath, kind }) });
          trackJob(job);
        } catch (err) { toast(err.message, 'error'); }
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

function showJobDock(job) {
  const dock = $('#job-dock');
  dock.classList.remove('hidden');
  const p = job.progress || {};
  const pct = p.totalBytes > 0 ? Math.min(100, Math.round((p.bytes / p.totalBytes) * 100))
    : (p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 5);
  const indeterminate = p.phase === 'discover' && !p.total;
  dock.innerHTML = `
    <div class="row">
      <div class="label">${esc(job.label)}</div>
      <div class="pct">${p.totalBytes > 0 ? `${humanBytes(p.bytes)} / ${humanBytes(p.totalBytes)}` : `${pct}%`}</div>
    </div>
    <div class="progress-bar${indeterminate ? ' indeterminate' : ''}"><i style="width:${pct}%"></i></div>
    <div class="row small muted" style="margin-top:6px;margin-bottom:0">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.phase || '')} ${p.volume ? esc(`[${p.volumeIndex || 1}/${p.volumeCount || 1}] ${p.volume}`) : ''} ${esc(p.current || '')}</span>
      <button class="btn ghost small" data-action="job-cancel" data-id="${job.id}">Annuler</button>
    </div>
  `;
}

function hideJobDock() { $('#job-dock').classList.add('hidden'); }

async function trackJob(job, { onDone = null } = {}) {
  state.trackedJob = job.id;
  showJobDock(job);
  try {
    for (;;) {
      await sleep(650);
      const current = await api(`/api/jobs/${job.id}`);
      if (state.trackedJob !== job.id) return;
      showJobDock(current);
      if (current.status !== 'running') {
        hideJobDock();
        state.trackedJob = null;
        if (current.status === 'error') toast(current.error || 'Opération échouée', 'error');
        else if (current.status === 'cancelled') toast('Opération annulée.', 'warn');
        else toast(`✔ ${current.label}`);
        if (onDone) onDone(current);
        await loadState();
        if (state.view === 'catalogue') await loadAssets();
        if (state.view === 'duplicates') await loadDuplicates();
        if (state.view === 'scan') await loadUnmanaged();
        return;
      }
    }
  } catch (err) {
    hideJobDock();
    state.trackedJob = null;
    toast(err.message, 'error');
  }
}

async function cancelTracked() {
  if (!state.trackedJob) return;
  try { await api(`/api/jobs/${state.trackedJob}/cancel`, { method: 'POST' }); } catch (err) { toast(err.message, 'error'); }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bindEvents() {
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchView(tab.dataset.view);
  });
  $('#btn-refresh').addEventListener('click', refreshAll);
  $('#load-more').addEventListener('click', () => loadAssets({ append: true }));

  $('#assets-table').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-group]');
    if (th) toggleGroup(th.dataset.group);
    const ts = e.target.closest('th[data-sort]');
    if (ts) toggleSort(ts.dataset.sort);
  });
  $('#assets-table').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const ts = e.target.closest('th[data-sort]');
    if (ts) { e.preventDefault(); toggleSort(ts.dataset.sort); return; }
    const th = e.target.closest('th[data-group]');
    if (!th) return;
    e.preventDefault();
    toggleGroup(th.dataset.group);
  });
  $('#clear-group').addEventListener('click', () => {
    state.groupBy = null;
    renderAssets();
  });

  let searchTimer = null;
  $('#search').addEventListener('input', (e) => {
    state.filters.q = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadAssets(), 280);
  });
  $('#filter-category').addEventListener('change', (e) => { state.filters.category = e.target.value; loadAssets(); });
  $('#filter-base').addEventListener('change', (e) => { state.filters.base = e.target.value; loadAssets(); });
  $('#role-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.role-tab'); if (!b) return;
    state.filters.role = b.dataset.role;
    document.querySelectorAll('#role-tabs .role-tab').forEach((t) => t.classList.toggle('on', t === b));
    loadAssets();
  });
  $('#filter-root').addEventListener('change', (e) => { state.filters.rootId = e.target.value; loadAssets(); });
  $('#filter-unmanaged').addEventListener('change', (e) => { state.filters.unmanaged = e.target.checked; loadAssets(); });
  $('#filter-state').addEventListener('change', (e) => { state.filters.state = e.target.value; loadAssets(); });
  $('#sort').addEventListener('change', (e) => {
    const [sort, dir] = e.target.value.split(':');
    state.filters.sort = sort;
    state.filters.dir = dir;
    syncSortHeaders();
    loadAssets();
  });

  $('#btn-suggest').addEventListener('click', suggestPlan);
  $('#btn-scan-all').addEventListener('click', runScanAll);
  $('#btn-scan').addEventListener('click', runScan);
  $('#scan-register').addEventListener('change', (e) => {
    $('#scan-register-fields').classList.toggle('hidden', !e.target.checked);
  });
  $('#btn-add-root').addEventListener('click', addRoot);
  document.addEventListener('click', (e) => { if (e.target.matches?.('.row-sel')) onSelChange(e); else if (e.target.matches?.('.dup-sel')) onDupSelClick(e); });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'dup-manual') { state.dupManual = e.target.checked; loadDuplicates(); }
    else if (e.target.id === 'dup-trash-extra') { state.dupTrash = e.target.checked; loadDuplicates(); }
  });
  $('#sel-all')?.addEventListener('change', (e) => { for (const a of state.assets.items) e.target.checked ? state.sel.add(a.id) : state.sel.delete(a.id); renderSelBar(); });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) {
      const row = e.target.closest('tr[data-id]');
      if (row && e.target.closest('.name-main') && state.view === 'catalogue') openDetails(Number(row.dataset.id));
      return;
    }
    const action = btn.dataset.action;
    const id = Number(btn.dataset.id);
    try {
      if (action === 'details') await openDetails(id);
      else if (action === 'move') await openMove(id);
      else if (action === 'link') openLink(id);
      else if (action === 'hash') {
        const job = await api('/api/jobs/hash', { method: 'POST', body: JSON.stringify({ assetId: id, full: true }) });
        trackJob(job);
      } else if (action === 'mv-store' || action === 'mv-active') {
        closeModal();
        await moveFlow({ id, name: btn.dataset.name, size: Number(btn.dataset.size), role: action === 'mv-active' ? 'active' : 'store', onDone: (r) => trackJob(r, { onDone: refreshAll }) });
      } else if (action === 'row-trash') {
        const a = state.assets.items.find((x) => x.id === id); if (!a) return;
        const name = a.title || a.file_name; const size = humanBytes(a.size_bytes);
        if (a.state === 'missing') { if (!confirm(`« ${name} » n’existe plus sur le disque.\nLe retirer de l’index ?`)) return; await api(`/api/assets/${id}`, { method: 'DELETE' }); toast('Retiré de l’index.'); await refreshAll(); return; }
        const erase = e.shiftKey;
        const note = a.managed ? '' : '\n(Ce fichier est « non géré » : il est hors de tes dossiers déclarés.)';
        if (!confirm(erase ? `Effacer « ${name} » (${size}) DÉFINITIVEMENT ?\n${a.abs_path}${note}\n\nIl ne passe pas par la corbeille : impossible de le récupérer.` : `Mettre « ${name} » (${size}) à la corbeille ?\n${a.abs_path}${note}\n\nLa place ne sera libérée qu’en vidant la corbeille Windows de ce disque.\n(Maj + clic sur le bouton : effacement définitif, sans corbeille.)`)) return;
        if (erase && !confirmErase()) return;
        await startTrash([id], erase);
      } else if (action === 'trash' || action === 'trash-one' || action === 'erase') {
        const erase = action === 'erase' || (action === 'trash-one' && $('#dup-erase')?.checked);
        if (!confirm(erase ? 'Effacer ce fichier DÉFINITIVEMENT ?\nIl ne passe pas par la corbeille : impossible de le récupérer.' : 'Mettre ce fichier dans la corbeille Windows de son disque ?\nPour libérer la place, il faudra vider la corbeille Windows.')) return;
        if (erase && !confirmErase()) return;
        closeModal();
        await startTrash([id], erase);
      } else if (action === 'restore') {
        closeModal();
        const job = await api('/api/jobs/restore', { method: 'POST', body: JSON.stringify({ assetIds: [id] }) });
        trackJob(job);
      } else if (action === 'forget') {
        if (!confirm('Retirer ce modèle de l\'index ?\nLe fichier reste sur le disque.')) return;
        closeModal();
        await api(`/api/assets/${id}`, { method: 'DELETE' });
        toast('Retiré de l\'index.');
        await refreshAll();
      } else if (action === 'root-delete') {
        if (!confirm(`Retirer la racine « ${btn.dataset.name} » ?\nLes fichiers restent sur le disque, ils deviennent simplement « non gérés ».`)) return;
        await api(`/api/roots/${id}`, { method: 'DELETE' });
        toast('Racine retirée.');
        await refreshAll();
      } else if (action === 'root-scan' || action === 'root-rescan') {
        const job = await api('/api/scan', { method: 'POST', body: JSON.stringify({ path: btn.dataset.path, rootId: Number(btn.dataset.rootId), force: action === 'root-rescan' }) });
        trackJob(job);
      } else if (action === 'dup-keep') {
        const ids = btn.dataset.dids.split(',').map(Number).filter(Boolean);
        const erase = !!$('#dup-erase')?.checked;
        if (!confirm(erase ? `Garder cette copie et EFFACER DÉFINITIVEMENT ${ids.length} autre(s) copie(s) ? (sans corbeille, irréversible)` : `Garder cette copie et mettre ${ids.length} autre(s) copie(s) à la corbeille ?`)) return;
        if (erase && !confirmErase()) return;
        await startTrash(ids, erase);
      } else if (action === 'dup-smart-all') { await runSmartMerge((state.dupPlan || []).map((g) => g.hash));
      } else if (action === 'dup-smart') { await runSmartMerge([btn.dataset.hash]);
      } else if (action === 'dup-prefer') { state.dupKeep[btn.dataset.hash] = Number(btn.dataset.id); await loadDuplicates();
      } else if (action === 'dup-auto') { delete state.dupKeep[btn.dataset.hash]; await loadDuplicates();
      } else if (action === 'dup-merge') {
        const ids = btn.dataset.dids.split(',').map(Number).filter(Boolean);
        if (!confirm(`Fusionner ${ids.length} copies par lien dur ?\n\nLe fichier n'est stocké qu'une fois, tous les chemins restent valides. Le contenu est comparé octet par octet avant (peut prendre un moment sur un gros fichier). Rien n'est supprimé si les copies diffèrent ou sont sur des disques différents.`)) return;
        btn.disabled = true; btn.textContent = '⏳ Vérification et fusion…';
        try {
          const r = await api('/api/duplicates/merge', { method: 'POST', body: JSON.stringify({ ids, confirm: true }) });
          const bad = r.report.filter((x) => !/^(fusionnée|déjà fusionnée)$/.test(x.status));
          toast(`${humanBytes(r.saved)} récupérés.${bad.length ? ' Non fusionnées : ' + bad.map((x) => x.status).join(' ; ') : ''}`, bad.length ? 'error' : undefined);
        } catch (err) { toast(err.message, 'error'); }
        await loadDuplicates();
      } else if (action === 'dup-clean') {
        const ids = btn.dataset.dids.split(',').map(Number).filter(Boolean);
        const erase = !!$('#dup-erase')?.checked;
        if (!confirm(erase ? `EFFACER DÉFINITIVEMENT ${ids.length} copie(s) ? (sans corbeille, irréversible)\nLa première copie est conservée.` : `Mettre ${ids.length} copie(s) à la corbeille ?\nLa première copie est conservée.`)) return;
        if (erase && !confirmErase()) return;
        await startTrash(ids, erase);
      } else if (action === 'dsel-all') { for (const i of state.dupItems) state.dupSel.add(i.id); renderDupBar();
      } else if (action === 'dsel-none') { state.dupSel.clear(); renderDupBar();
      } else if (action === 'dsel-invert') { for (const i of state.dupItems) state.dupSel.has(i.id) ? state.dupSel.delete(i.id) : state.dupSel.add(i.id); renderDupBar();
      } else if (action === 'dsel-extra') { state.dupSel.clear(); for (const g of state.dupGroups) for (const id of g.slice(1)) state.dupSel.add(id); renderDupBar();
      } else if (action === 'dbulk-trash') await bulkTrash(false, dupChosen());
      else if (action === 'dbulk-erase') await bulkTrash(true, dupChosen());
      else if (action === 'dbulk-move') openBulkMove(dupChosen());
      else if (action === 'sel-all') { for (const a of state.assets.items) state.sel.add(a.id); renderSelBar();
      } else if (action === 'sel-none') { state.sel.clear(); renderSelBar();
      } else if (action === 'sel-invert') { for (const a of state.assets.items) state.sel.has(a.id) ? state.sel.delete(a.id) : state.sel.add(a.id); renderSelBar();
      } else if (action === 'bulk-trash') await bulkTrash(false);
      else if (action === 'bulk-erase') await bulkTrash(true);
      else if (action === 'bulk-move') openBulkMove();
      else if (action === 'job-cancel') {
        await cancelTracked();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  bindEvents();
  try {
    await loadState();
    await loadAssets();
    // Reprend le suivi d'une tâche déjà lancée (rechargement de page).
    const running = state.data.jobs?.[0];
    if (running) trackJob(running);
  } catch (err) {
    document.body.insertAdjacentHTML('afterbegin', `<div class="err-box" style="margin:20px">Connexion au dispenser impossible : ${esc(err.message)}</div>`);
  }
}

document.addEventListener('paiz:refresh', () => { refreshAll(); });
boot();

// Largeurs de colonnes du catalogue : valeurs par défaut serrées, ajustables à la main (mémorisées). « Modèle » prend le reste.
(function initColumnResize() {
  const table = document.getElementById('assets-table'); if (!table) return;
  const cols = {}; table.querySelectorAll('col').forEach((c) => { cols[c.dataset.c] = c; });
  const DEF = { sel: 40, type: 84, base: 96, loc: 190, size: 92, date: 84, mv: 112, del: 132 };
  let saved = {}; try { saved = JSON.parse(localStorage.getItem('paiz.colw') || '{}'); } catch { /* ignoré */ }
  const W = { ...DEF, ...saved };
  const apply = () => { for (const k of Object.keys(DEF)) cols[k].style.width = `${W[k]}px`; };
  apply();
  const ths = table.querySelectorAll('thead th');
  const map = [null, 'name', 'type', 'base', 'loc'];
  ths.forEach((th, i) => {
    const key = map[i]; if (!key) return;
    const g = document.createElement('span'); g.className = 'col-grip'; g.title = 'Glisser pour ajuster la largeur (double-clic : par défaut)';
    g.addEventListener('click', (e) => e.stopPropagation());
    g.addEventListener('dblclick', (e) => { e.stopPropagation(); for (const k of ['type', 'base', 'loc']) W[k] = DEF[k]; apply(); try { localStorage.removeItem('paiz.colw'); } catch { /* ignoré */ } });
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); g.setPointerCapture(e.pointerId); g.classList.add('drag');
      const x0 = e.clientX; const w0 = { ...W };
      // « Modèle » est la colonne souple : tirer son bord ajuste la colonne Type (le reste ne bouge pas)
      const target = key === 'name' ? 'type' : key; const sign = key === 'name' ? -1 : 1;
      const move = (ev) => { W[target] = Math.max(48, Math.min(700, w0[target] + sign * (ev.clientX - x0))); apply(); };
      const up = () => { g.classList.remove('drag'); g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); try { localStorage.setItem('paiz.colw', JSON.stringify(W)); } catch { /* ignoré */ } };
      g.addEventListener('pointermove', move); g.addEventListener('pointerup', up);
    });
    th.appendChild(g);
  });
})();
