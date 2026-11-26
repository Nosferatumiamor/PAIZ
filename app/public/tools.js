// Onglet « Outils » : serveurs MCP (Blender, ComfyUI, Godot… : le modèle pilote d'autres logiciels). Un serveur MCP EXÉCUTE du code sur la machine :
// rien n'est actif tant que tu ne l'as pas activé, et chaque activation demande confirmation.
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

const st = { data: null, results: null, searching: false, probes: {}, cat: '', q: '', next: '', f: { install: true, nokey: false, local: false } };

function shell() {
  const body = $('#tools-body'); if (!body || body.dataset.ready) return;
  body.dataset.ready = '1';
  body.innerHTML = `
    <div class="panel muted small">⚖ Les outils que l’agent envoie au modèle (profils Discussion / Code / Recherche, allègement du prompt) se règlent dans l’écran <b>Travail</b>, bouton « ⚖ Outils ».</div>
    <div class="panel"><div class="panel-head"><h2>🧰 Outils (MCP)</h2>
      <p class="muted">Un « serveur MCP » permet au modèle de piloter un autre logiciel : Blender, ComfyUI, Godot… Chaque serveur est <b>désactivé</b> tant que tu ne l'actives pas, et <b>exécute du code sur ta machine</b> : n'active que ce que tu connais. L'activation relance OpenCode (un travail en cours est interrompu). Le modèle appelle ces outils en écrivant un petit programme : un modèle local s'en sort moins bien qu'avec les outils de base.</p>
      <div id="tools-req" class="muted small"></div></div>
    <div class="panel"><div class="panel-head"><h2>🎓 Skills</h2>
      <p class="muted">Un « skill » est un dossier de consignes (parfois avec des scripts) que le modèle ouvre quand la tâche s'y prête. Seuls le <b>nom et la description</b> des skills actifs sont ajoutés au prompt. Un skill peut contenir des scripts que le modèle lancera : n'installe que des sources que tu connais. Tout s'installe <b>désactivé</b>.</p>
      <div id="skills-req" class="muted small"></div></div>
      <div id="skills-curated"></div>
      <div class="toolbar" style="margin-top:10px"><input id="skills-url" class="input grow" placeholder="Adresse GitHub d'un skill ou d'un pack : https://github.com/proprietaire/depot"><button class="btn primary" id="skills-install">Installer</button></div>
      <div id="skills-mine" style="margin-top:10px"></div></div>
    <div class="panel"><div class="panel-head"><h3>Mes serveurs</h3></div><div id="tools-mine"></div></div>
    <div class="panel"><div class="panel-head"><h3>Catalogue</h3>
      <p class="muted small">Registre officiel MCP : outils vérifiés par PAIZ (✓) et recherche libre. N'importe qui y publie, regarde le dépôt avant d'installer. Ajouter ne lance rien : le serveur arrive désactivé.</p></div>
      <div class="subtabs" id="tools-cats" style="margin:12px 0 0"></div>
      <div class="tools-search"><input id="tools-q" class="input grow" style="min-width:260px" placeholder="Rechercher (3 lettres minimum) : comfyui, godot, blender, unreal…"><button class="btn primary" id="tools-go">Chercher</button>
        <div class="warn-box small"><span class="badge tw">serveur distant</span>&nbsp;Ce que le modèle envoie (scène, fichiers, texte) part sur Internet vers le serveur de l'outil.</div></div>
      <div class="toolbar tools-filters">
        <label class="check"><input type="checkbox" id="tf-install" checked> installables par PAIZ (npm, pypi, distant)</label>
        <label class="check"><input type="checkbox" id="tf-nokey"> sans clé d'API</label>
        <label class="check"><input type="checkbox" id="tf-local"> locaux seulement (rien ne part sur Internet)</label>
        <span class="grow"></span><span class="muted small" id="tools-count"></span></div>
      <div id="tools-results"></div><div id="tools-more" style="text-align:center;margin-top:10px"></div></div>
    <div class="panel"><div class="panel-head"><h3>Ajouter à la main</h3></div>
      <div class="toolbar"><input id="tools-name" class="input" placeholder="Nom (ex. comfyui)"><input id="tools-cmd" class="input grow" placeholder='Commande (ex. npx -y mon-serveur  ou  uvx mon-serveur)'><button class="btn" id="tools-add">Ajouter</button></div>
      <textarea id="tools-env" class="input" rows="2" placeholder="Variables d'environnement, une par ligne (CLE=valeur) — facultatif" style="max-width:none;width:100%;box-sizing:border-box;margin-top:8px"></textarea></div>`;
  $('#tools-go').onclick = () => { st.cat = ''; search(); };
  $('#tools-q').onkeydown = (e) => { if (e.key === 'Enter') { st.cat = ''; search(); } };
  for (const [id, k] of [['tf-install', 'install'], ['tf-nokey', 'nokey'], ['tf-local', 'local']]) $(`#${id}`).onchange = (e) => { st.f[k] = e.target.checked; paintResults(); };
  $('#tools-add').onclick = addManual;
  $('#skills-install').onclick = () => installSkill($('#skills-url').value.trim(), []);
}

// ---- Skills
const sk = { data: null, busy: false };
async function loadSkills() { try { sk.data = await call('/api/work/skills'); paintSkills(); } catch (e) { say(e.message, 'error'); } }
const mb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} Ko` : `${(n / 1048576).toFixed(1)} Mo`);
function needBadges(needs, p) {
  const ok = { node22: p.nodeOk, python: !!p.python, ffmpeg: !!p.ffmpeg, chrome: p.chrome };
  const lab = { node22: 'Node 22+', python: 'Python', ffmpeg: 'ffmpeg', chrome: 'Chrome' };
  return (needs || []).map((n) => `<span class="badge ${ok[n] ? 'ok' : 'danger'}" title="${ok[n] ? 'détecté' : 'non détecté sur cette machine'}">${esc(lab[n] || n)} ${ok[n] ? '✓' : '✗'}</span>`).join(' ');
}
function paintSkills() {
  const d = sk.data; if (!d || !$('#skills-mine')) return;
  const p = d.prereqs;
  $('#skills-req').textContent = `Détecté : Node ${p.node || '✗'} · Python ${p.python || '✗'} · ffmpeg ${p.ffmpeg ? '✓' : '✗'} · Chrome/Edge ${p.chrome ? '✓' : '✗'}`;
  const have = new Set(d.skills.map((s) => s.source)); // adresses déjà installées
  $('#skills-curated').innerHTML = `<div class="tool-grid">${d.curated.map((c) => `<div class="tool-card">
      <b>${esc(c.label)}</b><div class="muted small">${esc(c.description)}</div>
      <div class="small" style="margin:4px 0">${needBadges(c.needs, p)}</div>
      ${c.note ? `<div class="muted small tool-note">${esc(c.note)}</div>` : ''}
      <div class="toolbar"><a href="${esc(c.url)}" target="_blank" rel="noopener" class="muted small">dépôt ↗</a><span class="grow"></span>
      <button class="btn small" data-sk-inst="${esc(c.id)}" ${sk.busy ? 'disabled' : ''}>${have.has(c.url) ? 'Réinstaller' : 'Installer'}</button></div></div>`).join('')}</div>`;
  $('#skills-mine').innerHTML = d.skills.length ? d.skills.map((s) => `<div class="tool-row ${s.enabled ? 'on' : ''}">
      <label class="check"><input type="checkbox" data-sk-tg="${esc(s.id)}" ${s.enabled ? 'checked' : ''}> <b>${esc(s.name)}</b></label>
      <span class="muted small tool-desc" title="${esc(s.description)}">${esc(s.description.slice(0, 140))}${s.description.length > 140 ? '…' : ''}</span>
      <span class="grow"></span>
      ${s.enabled ? `<span class="badge ok" title="Texte ajouté au prompt par ce skill">≈ ${s.tokens} jetons</span>` : ''}
      <span class="muted small">${mb(s.size)}</span>
      <button class="btn ghost small" data-sk-rm="${esc(s.id)}">Retirer</button></div>`).join('') : '<div class="empty">Aucun skill installé.</div>';
  document.querySelectorAll('[data-sk-inst]').forEach((b) => { b.onclick = () => { const c = d.curated.find((x) => x.id === b.dataset.skInst); installSkill(c.url, c.needs, c.builtin); }; });
  document.querySelectorAll('[data-sk-tg]').forEach((b) => { b.onchange = () => toggleSkill(b); });
  document.querySelectorAll('[data-sk-rm]').forEach((b) => { b.onclick = () => removeSkill(b.dataset.skRm); });
}
async function skPost(body) {
  try { sk.data = await call('/api/work/skills', 'POST', body); if (sk.data.restarted) say('OpenCode relancé avec la nouvelle liste de skills.'); return true; } catch (e) { say(e.message, 'error'); return false; } finally { sk.busy = false; paintSkills(); }
}
async function installSkill(url, needs, builtin = false) {
  if (!url) { say("Colle l'adresse d'un dépôt GitHub.", 'error'); return; }
  if (!builtin && !confirm(`Télécharger les skills de :\n${url}\n\nIls seront installés désactivés. Un skill peut contenir des scripts : vérifie la source.`)) return;
  sk.busy = true; paintSkills(); if (!builtin) say('Téléchargement…');
  if (await skPost({ install: { url, needs, builtin } })) { say(`${sk.data.added.length} skill(s) installé(s), désactivé(s) : coche ceux que tu veux utiliser.`); $('#skills-url').value = ''; }
}
async function toggleSkill(cb) {
  const s = sk.data.skills.find((x) => x.id === cb.dataset.skTg);
  if (cb.checked && !confirm(`Activer « ${s.name} » ?\n\nLe modèle pourra lire ses consignes et lancer ses scripts.\nOpenCode sera relancé (un travail en cours serait interrompu).`)) { cb.checked = false; return; }
  await skPost({ toggle: { id: s.id, enabled: cb.checked } });
}
async function removeSkill(id) {
  if (!confirm(`Supprimer le skill « ${id} » du disque ?`)) return;
  await skPost({ remove: id });
}

async function load() {
  try { st.data = await call('/api/work/mcp'); paint(); } catch (e) { say(e.message, 'error'); }
}

const needTxt = { node: 'Node.js (npx)', uv: 'uv (uvx)' };
function paint() {
  const d = st.data; if (!d) return;
  $('#tools-req').innerHTML = `Prérequis : Node.js (npx) ${d.prereqs.node ? '✓ installé' : '<b>✗ absent</b>'} · uv (uvx) ${d.prereqs.uv ? '✓ installé' : '<b>✗ absent</b>'}`;
  $('#tools-mine').innerHTML = d.servers.length ? d.servers.map((s) => {
    const p = st.probes[s.id];
    return `<div class="tool-row ${s.enabled ? 'on' : ''}">
      <label class="check"><input type="checkbox" data-tg="${esc(s.id)}" ${s.enabled ? 'checked' : ''}> <b>${esc(s.label)}</b></label>
      <code class="tool-cmd" title="${esc(s.type === 'remote' ? s.url : s.command.join(' '))}">${esc(s.type === 'remote' ? s.url : s.command.join(' '))}</code>
      <span class="grow"></span>
      ${p ? (p.ok ? `<span class="badge ok" title="${esc(p.tools.map((t) => t.name).join(', '))}">${p.tools.length} outil(s) · ≈ ${p.tokens} jetons dans le prompt</span>` : `<span class="badge danger" title="${esc(p.error)}">échec de l'essai</span>`) : ''}
      <button class="btn ghost small" data-probe="${esc(s.id)}" ${s.type === 'remote' ? 'disabled title="Essai indisponible pour un serveur distant"' : ''}>Tester</button>
      <button class="btn ghost small" data-rm="${esc(s.id)}">Retirer</button>
      ${p && !p.ok ? `<div class="muted small tool-err">${esc(p.error)}</div>` : ''}${s.note ? `<div class="muted small tool-note">${esc(s.note)}</div>` : ''}
    </div>`;
  }).join('') : '<div class="empty">Aucun serveur. Ajoute-en un depuis le catalogue ci-dessous.</div>';
  const have = new Set(d.servers.map((s) => s.id));
  $('#tools-cats').innerHTML = `<button class="btn ${!st.cat && !st.q ? 'primary' : 'ghost'}" data-cat="">Tout</button>` + (d.categories || []).map((c) => `<button class="btn ${st.cat === c.id ? 'primary' : 'ghost'}" data-cat="${esc(c.id)}">${esc(c.label)}</button>`).join('');
  document.querySelectorAll('#tools-cats [data-cat]').forEach((b) => { b.onclick = () => { st.cat = b.dataset.cat; st.q = ''; $('#tools-q').value = ''; search(); }; });
  paintResults();
  document.querySelectorAll('#tools-mine [data-tg]').forEach((cb) => { cb.onchange = () => toggle(cb); });
  document.querySelectorAll('#tools-mine [data-probe]').forEach((b) => { b.onclick = () => probe(b.dataset.probe, b); });
  document.querySelectorAll('#tools-mine [data-rm]').forEach((b) => { b.onclick = () => remove(b.dataset.rm); });
  document.querySelectorAll('[data-add]').forEach((b) => { b.onclick = () => addFrom(b.dataset.add, b.dataset.src); });
}
function card(c, have, src) {
  const ok = src === 'curated' || c.supported;
  const missing = c.needs && st.data.prereqs[c.needs] === false;
  const cmd = c.type === 'remote' ? c.url : (c.command || []).join(' ');
  return `<div class="tool-card">
    <div><b>${esc(c.label || c.title)}</b> ${c.version ? `<span class="badge soft">v${esc(c.version)}</span>` : ''} ${c.repo ? `<a href="${esc(c.repo)}" target="_blank" rel="noopener" class="small">dépôt ↗</a>` : ''}</div>
    <div class="muted small">${esc(c.description || '')}</div>
    ${ok ? `<code class="tool-cmd" title="${esc(cmd)}">${esc(cmd)}</code>` : `<div class="muted small">Format « ${esc(c.kind)} » non pris en charge par PAIZ (npm, pypi et serveurs distants seulement).</div>`}
    ${src === 'curated' || c.type === 'remote' || missing ? `<div class="tool-badges">${src === 'curated' ? '<span class="badge ok" title="Sélectionné et vérifié par PAIZ">✓ vérifié</span>' : ''}${c.type === 'remote' ? '<span class="badge tw" title="Ce que le modèle envoie part sur Internet vers ce serveur">serveur distant</span>' : ''}${missing ? `<span class="badge tw" title="Prérequis absent de cette machine">demande ${esc(needTxt[c.needs])} — absent</span>` : ''}</div>` : ''}
    <div class="toolbar"><span class="grow"></span><button class="btn small ${have ? 'ghost' : 'primary'}" data-add="${esc(c.id)}" data-src="${src}" ${have || !ok ? 'disabled' : ''}>${have ? 'Déjà ajouté' : 'Ajouter'}</button></div>
  </div>`;
}
// outils vérifiés par PAIZ : rangés dans le même catalogue, sous leur rubrique (Blender → 3D)
function curatedShown() {
  const d = st.data; if (!d) return [];
  const q = (st.q || '').toLowerCase();
  return d.curated.filter((c) => (st.cat ? (c.category || '3d') === st.cat : !q || `${c.label} ${c.description}`.toLowerCase().includes(q)) && (!st.f.local || c.type === 'local'));
}
function paintResults() {
  const box = $('#tools-results'); if (!box) return;
  const cur = curatedShown();
  if (st.searching && !st.results && !cur.length) { box.innerHTML = '<div class="empty">Recherche…</div>'; return; }
  if (!st.results && !cur.length) { box.innerHTML = '<div class="empty">Choisis une rubrique ou lance une recherche.</div>'; $('#tools-more').innerHTML = ''; $('#tools-count').textContent = ''; return; }
  const have = new Set(st.data.servers.map((s) => s.id));
  const shown = (st.results || []).filter((c) => (!st.f.install || c.supported) && (!st.f.nokey || !(c.env || []).some((v) => v.required)) && (!st.f.local || c.type === 'local'))
    .sort((x, y) => Number(y.supported) - Number(x.supported));
  $('#tools-count').textContent = `${cur.length + shown.length} affiché(s) sur ${cur.length + (st.results || []).length}`;
  box.innerHTML = cur.length + shown.length ? `<div class="tool-grid">${cur.map((c) => card(c, have.has(c.id), 'curated')).join('')}${shown.map((c) => card(c, have.has(c.id), 'registry')).join('')}</div>${st.searching && !st.results ? '<div class="empty">Recherche…</div>' : ''}` : '<div class="empty">Rien avec ces filtres (décoche-en un).</div>';
  box.querySelectorAll('[data-add]').forEach((b) => { b.onclick = () => addFrom(b.dataset.add, b.dataset.src); });
  const more = $('#tools-more');
  more.innerHTML = st.next ? `<button class="btn" id="tools-next">${st.searching ? 'Chargement…' : 'Charger la suite'}</button>` : '';
  if (st.next) $('#tools-next').onclick = () => search(true);
}
async function search(more = false) {
  const q = $('#tools-q').value.trim();
  if (!st.cat && !q && !more) { st.q = ''; } else if (!st.cat) st.q = q;
  if (!st.cat && st.q && st.q.length < 3) { say('Tape au moins 3 lettres.', 'error'); return; }
  st.searching = true; if (!more) st.results = null; paintResults();
  try {
    const qs = st.cat ? `cat=${encodeURIComponent(st.cat)}` : `q=${encodeURIComponent(st.q)}${more && st.next ? `&cursor=${encodeURIComponent(st.next)}` : ''}`;
    const r = await call(`/api/work/mcp/search?${qs}`);
    st.results = more ? [...(st.results || []), ...r.items] : r.items; st.next = r.nextCursor || '';
  } catch (e) { say(e.message, 'error'); if (!more) st.results = []; }
  st.searching = false; paint();
}
async function post(body) {
  try { st.data = await call('/api/work/mcp', 'POST', body); if (st.data.restarted) say('OpenCode relancé avec la nouvelle liste.'); paint(); return true; } catch (e) { say(e.message, 'error'); return false; }
}
async function addFrom(id, src) {
  const c = src === 'curated' ? st.data.curated.find((x) => x.id === id) : st.results.find((x) => x.id === id);
  if (!c) return;
  const environment = {};
  for (const v of c.env || []) { // variables demandées par le serveur (clé d'API…) : saisies ici, gardées dans la base PAIZ
    const val = prompt(`${c.title || c.label} demande la variable ${v.name}${v.required ? ' (obligatoire)' : ''}.\n${v.description || ''}\nValeur (laisser vide pour passer) :`);
    if (val === null) return; if (val) environment[v.name] = val;
  }
  if (await post({ save: { id: c.id, label: c.label || c.title, type: c.type, command: c.command, url: c.url, environment, enabled: false, source: src, repo: c.repo, note: c.note || '' } })) say(`« ${c.label || c.title} » ajouté (désactivé).`);
}
async function addManual() {
  const name = $('#tools-name').value.trim(); const cmd = $('#tools-cmd').value.trim();
  const environment = {}; for (const l of $('#tools-env').value.split(/\r?\n/)) { const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l); if (m) environment[m[1]] = m[2]; }
  if (await post({ save: { name, command: cmd, type: /^https?:\/\//i.test(cmd) ? 'remote' : 'local', url: cmd, environment, enabled: false, source: 'manual' } })) { $('#tools-name').value = ''; $('#tools-cmd').value = ''; $('#tools-env').value = ''; }
}
async function toggle(cb) {
  const id = cb.dataset.tg; const s = st.data.servers.find((x) => x.id === id);
  if (cb.checked && !confirm(`Activer « ${s.label} » ?\n\nCe serveur exécutera du code sur ta machine :\n${s.type === 'remote' ? s.url : s.command.join(' ')}\n\nOpenCode sera relancé (un travail en cours serait interrompu).`)) { cb.checked = false; return; }
  await post({ toggle: { id, enabled: cb.checked } });
}
async function remove(id) {
  const s = st.data.servers.find((x) => x.id === id);
  if (!confirm(`Retirer « ${s?.label || id} » de la liste ?`)) return;
  delete st.probes[id]; await post({ remove: id });
}
async function probe(id, btn) {
  btn.disabled = true; btn.textContent = 'Essai…';
  try { st.probes[id] = await call('/api/work/mcp/probe', 'POST', { id }); } catch (e) { st.probes[id] = { ok: false, error: e.message }; }
  paint();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('#tabs .tab');
  if (t && t.dataset.view === 'tools') setTimeout(async () => { shell(); await Promise.all([load(), loadSkills()]); if (!st.results && !st.searching) search(); }, 0);
});
