// Onglet « Découvrir » : parcourir Hugging Face (GGUF) et télécharger vers l'écurie à modèles, le projet actif ou un dossier au choix, avec contrôle de place et SHA-256.
import { famBadge } from '/fam.js';
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bytes = (n) => { if (n == null) return '—'; const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0; let x = Number(n); while (x >= 1024 && i < 4) { x /= 1024; i++; } return `${x.toFixed(x >= 10 || i === 0 ? 0 : 1)} ${u[i]}`; };
const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' k' : String(n));
async function call(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status}`);
  return d;
}
function say(msg, kind = '') {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg;
  $('#toasts')?.appendChild(el); setTimeout(() => el.remove(), 6000);
}

// MoE d'après le nom (même règle que src/moe.js) : « A3B », « MoE », Mixtral, gpt-oss, Qwen3-Next, GLM-4.5…
const MOE_RE = /(^|[-_ .])A\d+(\.\d+)?B([-_ .]|$)|\bMoE\b|mixtral|\d+x\d+B|gpt-oss|qwen3-next|qwen3-coder-next|glm-4\.5|glm-4\.6|deepseek-?v[23]|deepseek-r1|olmoe|granite.*moe|lfm2-8b-a1b|ernie.*a\d+b|kimi-k2|minimax-m|llama-?4|dbrx|jamba|phi-3\.5-moe|hunyuan-a/i;
const st = { q: '', sort: 'downloads', gguf: true, items: null, loading: false, timer: null, dlg: null, chips: new Set(), f: { dl: 0, likes: 0, maxGb: 0 } };
const CHIPS = ['uncensored', 'abliterated', 'coder', 'MoE', 'vision', 'qwen', 'gemma', 'llama', 'mistral', 'deepseek', 'glm', 'kimi', 'minimax', 'gpt-oss', 'phi', 'nemotron', 'granite'];

const badge = famBadge;

function shell() {
  const body = $('#hub-body'); if (!body || body.dataset.ready) return;
  body.dataset.ready = '1';
  body.innerHTML = `
    <div class="panel"><div class="panel-head"><h2>🔭 Découvrir des modèles (Hugging Face)</h2>
      <p class="muted">Recherche et tri par popularité. Rien n'est téléchargé sans ton clic ; chaque fichier est vérifié (taille + SHA-256 publié) et la place du disque est contrôlée avant. Seuls tes mots de recherche sont envoyés à Hugging Face.</p></div>
      <div class="toolbar"><input id="hub-q" class="input grow" placeholder="Rechercher : qwen coder, gemma, uncensored…">
        <select id="hub-sort" class="input"><option value="downloads">Plus téléchargés</option><option value="likes">Plus aimés</option><option value="trending">Tendance</option><option value="recent">Récents</option></select>
        <label class="check"><input type="checkbox" id="hub-gguf" checked> GGUF seulement</label><button class="btn primary" id="hub-go">Chercher</button></div>
      <div class="hub-cats"><span class="muted small hub-cats-l">Catégories</span><div class="hub-cats-grid" style="--cols:${Math.ceil(CHIPS.length / 2)}">${CHIPS.map((c) => `<button class="btn ghost" data-chip="${c}" aria-pressed="false" title="Clique pour ajouter ce mot au filtre, reclique pour le retirer (les mots se cumulent)">${c}</button>`).join('')}</div></div>
      <div class="toolbar hub-filters" style="margin-top:10px"><span class="muted small">Filtrer :</span>
        <label class="muted small">Téléchargements <select id="hf-dl" class="input"><option value="0">tous</option><option value="1000">≥ 1 k</option><option value="10000">≥ 10 k</option><option value="100000">≥ 100 k</option><option value="1000000">≥ 1 M</option></select></label>
        <label class="muted small">Likes <select id="hf-likes" class="input"><option value="0">tous</option><option value="10">≥ 10</option><option value="100">≥ 100</option><option value="1000">≥ 1 k</option></select></label>
        <label class="muted small" title="Garde les dépôts qui ont au moins une quantification de cette taille ou moins">Une version ≤ <select id="hf-gb" class="input"><option value="0">peu importe</option><option value="8">8 Go</option><option value="12">12 Go (VRAM)</option><option value="16">16 Go</option><option value="24">24 Go</option><option value="32">32 Go (RAM)</option><option value="64">64 Go</option></select></label>
        <button class="btn ghost small" id="hf-reset">Réinitialiser</button><span class="muted small" id="hf-count"></span></div></div>
    <div id="hub-results"></div><div id="hub-jobs"></div>`;
  const go = () => { st.q = [$('#hub-q').value.trim(), ...st.chips].filter(Boolean).join(' '); st.sort = $('#hub-sort').value; st.gguf = $('#hub-gguf').checked; search(); };
  $('#hub-go').onclick = go;
  $('#hub-q').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  $('#hub-sort').onchange = go; $('#hub-gguf').onchange = go;
  // les mots-clés se cumulent (Hugging Face les cherche tous ensemble) ; recliquer un mot allumé l'éteint
  body.querySelectorAll('[data-chip]').forEach((b) => { b.onclick = () => {
    const c = b.dataset.chip; if (st.chips.has(c)) st.chips.delete(c); else st.chips.add(c);
    const on = st.chips.has(c); b.classList.toggle('primary', on); b.classList.toggle('ghost', !on); b.setAttribute('aria-pressed', String(on));
    go();
  }; });
  const fl = () => { st.f.dl = Number($('#hf-dl').value); st.f.likes = Number($('#hf-likes').value); st.f.maxGb = Number($('#hf-gb').value); applyFilters(); };
  ['#hf-dl', '#hf-likes', '#hf-gb'].forEach((id) => { $(id).onchange = fl; });
  $('#hf-reset').onclick = () => {
    st.chips.clear(); body.querySelectorAll('[data-chip]').forEach((b) => { b.classList.remove('primary'); b.classList.add('ghost'); b.setAttribute('aria-pressed', 'false'); });
    $('#hub-q').value = ''; $('#hf-dl').value = '0'; $('#hf-likes').value = '0'; $('#hf-gb').value = '0'; st.f = { dl: 0, likes: 0, maxGb: 0 }; go();
  };
}

async function search() {
  st.loading = true; paintResults();
  try { st.items = (await call(`/api/hub/search?q=${encodeURIComponent(st.q)}&sort=${st.sort}&gguf=${st.gguf ? 1 : 0}&limit=60`)).items; } catch (e) { st.items = []; say(e.message, 'error'); }
  st.loading = false; paintResults();
}

function paintResults() {
  const box = $('#hub-results'); if (!box) return;
  if (st.loading) { box.innerHTML = '<div class="panel"><p class="muted">Recherche…</p></div>'; return; }
  if (!st.items) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="panel"><table class="table hub-table"><thead><tr><th></th><th>Modèle</th><th>Téléchargements</th><th>Likes</th><th title="Poids des fichiers GGUF du dépôt : de la plus légère à la plus lourde quantification">Taille</th><th>Étiquettes</th><th>Dépôt</th><th></th></tr></thead><tbody>
    ${st.items.map((m, i) => `<tr data-row="${i}"><td>${badge(m.id)}</td><td><b>${esc(m.id)}</b>${m.gated ? ' <span class="badge soft">accès restreint</span>' : ''}${MOE_RE.test(m.id) ? ' <span class="badge ok" title="Modèle à experts (MoE), d’après son nom : PAIZ peut le streamer et le faire tourner avec bien moins de mémoire">MoE</span>' : ''}</td><td>${compact(m.downloads)}</td><td>${compact(m.likes)}</td><td class="hub-size" data-sz="${i}"><span class="muted small">…</span></td><td class="muted small hub-tags">${esc(m.tags.join(' · '))}</td>
      <td><a class="btn ghost small" href="https://huggingface.co/${esc(m.id)}" target="_blank" rel="noopener" title="Ouvrir la page du modèle sur Hugging Face">↗ Hugging Face</a></td>
      <td style="text-align:right"><button class="btn primary small" data-dl="${i}" ${m.gated ? 'disabled title="Accès restreint : compte Hugging Face requis"' : ''}>⬇ Télécharger</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">Aucun résultat.</td></tr>'}</tbody></table></div>`;
  fillSizes(box); applyFilters();
  box.querySelectorAll('[data-dl]').forEach((b) => { b.onclick = () => openDialog(st.items[Number(b.dataset.dl)].id); });
}

// filtres cumulés : cachent les lignes sans refaire la recherche. La taille arrive après coup : une ligne dont la taille n'est pas encore connue reste visible.
function applyFilters() {
  const box = $('#hub-results'); if (!box || !st.items) return;
  const { dl, likes, maxGb } = st.f; let shown = 0;
  box.querySelectorAll('[data-row]').forEach((tr) => {
    const m = st.items[Number(tr.dataset.row)];
    const sizeKnown = m.size && m.size.n;
    const ok = m.downloads >= dl && m.likes >= likes && (!maxGb || !m.size || (sizeKnown && m.size.min <= maxGb * 1e9));
    tr.hidden = !ok; if (ok) shown++;
  });
  const c = $('#hf-count'); if (c) c.textContent = st.items.length ? `${shown} / ${st.items.length} affichés` : '';
}

// tailles chargées après coup (une requête par dépôt, 5 à la fois, mises en cache côté serveur)
const gb = (b) => (b >= 1e11 ? Math.round(b / 1e9) : (b / 1e9).toFixed(b >= 1e10 ? 0 : 1)).toString().replace('.', ',');
async function fillSizes(box) {
  const items = st.items; const cells = [...box.querySelectorAll('[data-sz]')]; let next = 0;
  const worker = async () => {
    while (next < cells.length) {
      const td = cells[next++]; const m = items[Number(td.dataset.sz)]; if (!m || st.items !== items) return;
      try {
        const r = m.size || (m.size = await call(`/api/hub/size?id=${encodeURIComponent(m.id)}`));
        td.innerHTML = !r.n ? '<span class="muted small">—</span>' : r.min === r.max ? `<b>${gb(r.max)}</b> Go` : `<b>${gb(r.min)}</b>–<b>${gb(r.max)}</b> Go`;
        td.title = r.n ? `${r.n} fichier(s) GGUF : de ${gb(r.min)} à ${gb(r.max)} Go selon la quantification` : 'Aucun fichier GGUF';
      } catch { td.innerHTML = '<span class="muted small">?</span>'; }
      if (st.items === items) applyFilters();
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
}

// ---- fenêtre de téléchargement : fichier (quantification) + destination
const activeDir = () => { try { return window.paizActiveDir || localStorage.getItem('paiz.workdir') || ''; } catch { return ''; } };
function closeDialog() { st.dlg = null; $('#modal-root').innerHTML = ''; }
async function openDialog(id) {
  const proj = activeDir();
  st.dlg = { id, files: null, err: null, file: 0, kind: 'root', root: '', projDir: proj, other: '', folder: id.split('/')[1] || '', roots: [] };
  paintDialog();
  try {
    const [f, r] = await Promise.all([call(`/api/hub/files?id=${encodeURIComponent(id)}`), call('/api/roots')]);
    if (!st.dlg || st.dlg.id !== id) return;
    st.dlg.files = f.files; st.dlg.machine = f.machine; st.dlg.moe = f.moe; st.dlg.arch = f.arch; st.dlg.roots = (r.roots || r).filter((x) => x.enabled !== 0);
    st.dlg.root = st.dlg.roots[0] ? String(st.dlg.roots[0].id) : '';
    if (!st.dlg.roots.length) st.dlg.kind = proj ? 'project' : 'other';
  } catch (e) { if (st.dlg) st.dlg.err = e.message; }
  paintDialog();
}
function destInfo(d) { // destination choisie et place libre connue (seule l'écurie la connaît ; le serveur contrôle les autres)
  if (d.kind === 'root') { const r = d.roots.find((x) => String(x.id) === d.root); return { free: r?.free ?? null, ok: !!r }; }
  if (d.kind === 'project') return { free: null, ok: !!d.projDir };
  return { free: null, ok: !!d.other.trim() };
}
function paintDialog() {
  const d = st.dlg; const root = $('#modal-root'); if (!d || !root) return;
  const dest = destInfo(d);
  let files = '<p class="muted">Lecture des fichiers…</p>';
  if (d.err) files = `<p style="color:var(--danger)">${esc(d.err)}</p>`;
  else if (d.files) files = d.files.length ? `<div class="hub-files">${d.files.map((f, i) => {
    const need = f.size + Math.max(256 * 1048576, f.size * 0.01);
    const fits = dest.free == null ? null : dest.free >= need;
    return `<label class="hub-file ${d.file === i ? 'on' : ''}"><input type="radio" name="hub-file" value="${i}" ${d.file === i ? 'checked' : ''}>
      <span class="grow">${esc(f.name)}${f.parts.length > 1 ? ` <span class="badge soft">${f.parts.length} parties</span>` : ''}</span><span class="badge soft">${esc(f.quant || '—')}</span><b>${bytes(f.size)}</b>
      <span class="small">${fits == null ? '' : fits ? '<span style="color:var(--accent)">✔ place</span>' : '<span style="color:var(--danger)">✖ place</span>'}</span>${f.fit ? `<span class="badge fit-${f.fit.tier}" title="${esc(f.fit.detail)}">${esc(f.fit.label)}</span>` : ''}</label>`;
  }).join('')}</div>` : '<p class="muted">Aucun fichier GGUF dans ce dépôt.</p>';
  const cur = d.files?.[d.file];
  const fitsNow = cur && dest.free != null ? dest.free >= cur.size + Math.max(256 * 1048576, cur.size * 0.01) : true;
  root.innerHTML = `<div class="modal-backdrop" id="hub-bd"><div class="modal">
    <div class="modal-head"><h3>${badge(d.id)} ${esc(d.id)}</h3><button class="modal-close" id="hub-x" title="Fermer">×</button></div>
    <div class="modal-body">
      <h4 class="hub-h">Fichier à télécharger</h4>${d.machine ? `<p class="muted small" style="margin:0 0 6px">Ta machine : ${d.machine.vramBytes ? bytes(d.machine.vramBytes) + ' de VRAM' : 'pas de carte NVIDIA'} · ${bytes(d.machine.ramBytes)} de RAM. ${d.moe ? 'Modèle MoE : WeightStream streame les experts depuis le SSD.' : d.arch ? 'Modèle dense (pas de streaming d’experts).' : ''} <i>Estimation — survole l'étiquette pour le détail.</i></p>` : ''}${files}
      <h4 class="hub-h">Où l'enregistrer ?</h4>
      <div class="hub-dest">
        <label class="hub-opt ${d.kind === 'root' ? 'on' : ''}"><input type="radio" name="hub-kind" value="root" ${d.kind === 'root' ? 'checked' : ''} ${d.roots.length ? '' : 'disabled'}> 🐴 <b>Écurie à modèles</b>
          <select id="hub-root" class="input" ${d.kind === 'root' ? '' : 'disabled'}>${d.roots.map((r) => `<option value="${r.id}" ${String(r.id) === d.root ? 'selected' : ''}>${esc(r.name)} — ${r.free != null ? bytes(r.free) + ' libres' : esc(r.path)}</option>`).join('')}</select></label>
        <label class="hub-opt ${d.kind === 'project' ? 'on' : ''}"><input type="radio" name="hub-kind" value="project" ${d.kind === 'project' ? 'checked' : ''} ${d.projDir ? '' : 'disabled'}> 📁 <b>Projet actif</b>
          <span class="muted small grow">${d.projDir ? esc(d.projDir) : "aucun projet ouvert dans l'onglet Travail"}</span></label>
        <label class="hub-opt ${d.kind === 'other' ? 'on' : ''}"><input type="radio" name="hub-kind" value="other" ${d.kind === 'other' ? 'checked' : ''}> 📂 <b>Ailleurs</b>
          <input id="hub-other" class="input grow" placeholder="Dossier de destination" value="${esc(d.other)}" ${d.kind === 'other' ? '' : 'disabled'}><button class="btn small" id="hub-browse" ${d.kind === 'other' ? '' : 'disabled'}>Parcourir…</button></label>
      </div>
      <label class="muted small" style="display:block;margin-top:10px">Sous-dossier <input id="hub-folder" class="input" value="${esc(d.folder)}" style="max-width:320px"> <span class="muted">(créé dans la destination)</span></label>
      ${fitsNow ? '' : `<p style="color:var(--danger)" class="small">Pas assez de place : ${bytes(dest.free)} libres seulement. Choisis un fichier plus léger ou une autre destination.</p>`}
    </div>
    <div class="modal-foot"><button class="btn" id="hub-cancel">Annuler</button><button class="btn primary" id="hub-ok" ${cur && dest.ok && fitsNow ? '' : 'disabled'}>Télécharger</button></div></div></div>`;
  $('#hub-x').onclick = closeDialog; $('#hub-cancel').onclick = closeDialog;
  $('#hub-bd').onmousedown = (e) => { if (e.target.id === 'hub-bd') closeDialog(); };
  root.querySelectorAll('[name="hub-file"]').forEach((r) => { r.onchange = () => { d.file = Number(r.value); paintDialog(); }; });
  root.querySelectorAll('[name="hub-kind"]').forEach((r) => { r.onchange = () => { d.kind = r.value; paintDialog(); }; });
  $('#hub-root').onchange = (e) => { d.root = e.target.value; paintDialog(); };
  $('#hub-other').oninput = (e) => { d.other = e.target.value; $('#hub-ok').disabled = !cur || !d.other.trim(); };
  $('#hub-folder').oninput = (e) => { d.folder = e.target.value; };
  $('#hub-browse').onclick = async () => { try { const r = await call('/api/pick-folder', 'POST', { start: d.other }); if (r.path) { d.other = r.path; paintDialog(); } } catch (e) { say(e.message, 'error'); } };
  $('#hub-ok').onclick = async () => {
    const f = d.files[d.file];
    const body = { id: d.id, files: f.parts, folder: d.folder.trim() };
    if (d.kind === 'root') body.toRoot = Number(d.root); else body.toDir = d.kind === 'project' ? d.projDir : d.other.trim();
    try { await call('/api/hub/download', 'POST', body); say('Téléchargement lancé.'); closeDialog(); watchJobs(); } catch (e) { say(e.message, 'error'); }
  };
}

async function watchJobs() {
  clearTimeout(st.timer);
  let jobs = [];
  try { const d = await call('/api/jobs'); jobs = (d.jobs || d).filter((j) => j.type === 'download').slice(0, 5); } catch { /* ignore */ }
  const box = $('#hub-jobs');
  if (box) box.innerHTML = jobs.length ? `<div class="panel"><div class="panel-head"><h2>Téléchargements</h2></div>${jobs.map((j) => {
    const p = j.progress || {}; const pct = p.totalBytes ? Math.round(100 * p.bytes / p.totalBytes) : 0;
    return `<div style="margin:6px 0"><div class="small">${esc(j.label)} — <b>${j.status === 'running' ? (p.phase === 'verify' ? 'vérification SHA-256' : 'téléchargement') + ' ' + pct + ' %' : esc(j.status)}</b> ${j.status === 'running' ? `(${bytes(p.bytes)} / ${bytes(p.totalBytes)})` : ''}</div>
      ${j.status === 'running' ? `<div class="bar" style="width:100%;height:5px;background:rgba(94,234,212,.15);border-radius:3px"><i style="display:block;width:${pct}%;height:100%;background:var(--accent);border-radius:3px"></i></div>` : ''}
      ${j.error ? `<div style="color:var(--danger)" class="small">${esc(j.error)}</div>` : ''}</div>`;
  }).join('')}</div>` : '';
  if (jobs.some((j) => j.status === 'running')) st.timer = setTimeout(watchJobs, 1500);
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (t && t.dataset.view === 'hub') { setTimeout(() => { shell(); if (!st.items) search(); watchJobs(); }, 0); }
  else if (t) clearTimeout(st.timer);
});
