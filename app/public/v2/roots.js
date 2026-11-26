// Réglages › Dossiers de modèles (nouvelle interface) : deux colonnes, « Prêts à lancer » (disque rapide) et « Réserve » (stockage).
// Un dossier s'ajoute en un clic (n'importe où, ou un dossier standard X:\PAIZ\Ready / X:\PAIZ\Reserve), s'ouvre dans l'Explorateur,
// change de rôle d'un bouton. Chaque dossier porte un repère (PAIZ-repo.json) : déplacé, il est retrouvé par « Retrouver mes dossiers ».
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const go = (n) => (n == null ? '—' : n >= 1024 ** 4 ? `${(n / 1024 ** 4).toFixed(1).replace('.', ',')} To` : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(n >= 100 * 1024 ** 3 ? 0 : 1).replace('.', ',')} Go` : `${Math.round(n / 1024 ** 2)} Mo`);
async function call(p, method = 'GET', body) {
  const r = await fetch(p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `${r.status}`); return d;
}
function say(msg, kind = '') { const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg; $('#toasts')?.appendChild(el); setTimeout(() => el.remove(), 6000); }

const S = { roots: [], drives: [], stats: {}, busy: false };
async function load() {
  try {
    const [r, d, a] = await Promise.all([call('/api/roots'), call('/api/roots/drives').catch(() => ({ drives: [] })), call('/api/assets?limit=5000').catch(() => ({ items: [] }))]);
    S.roots = r.roots || r; S.drives = d.drives || []; S.stats = {};
    for (const x of a.items || []) { if (x.root_id == null || x.state !== 'present') continue; const s = S.stats[x.root_id] || (S.stats[x.root_id] = { n: 0, b: 0 }); s.n++; s.b += x.size_bytes || 0; }
  } catch (e) { say(e.message, 'error'); }
  paint();
}

function card(r) {
  const st = S.stats[r.id] || { n: 0, b: 0 };
  const other = r.role === 'active' ? ['store', '→ Réserve', 'Passer ce dossier en réserve (stockage)'] : ['active', '→ Prêts à lancer', 'Passer ce dossier en « prêts à lancer » (disque rapide)'];
  return `<div class="v2-root ${r.exists ? '' : 'gone'}">
    <div class="v2-root-h"><b>${esc(r.name)}</b>${r.exists ? '' : '<span class="v2-chip light">introuvable</span>'}</div>
    <div class="v2-root-p" data-noi18n>${esc(r.path)}</div>
    <div class="v2-root-c"><span class="v2-chip">${esc(r.volume || '')}</span><span class="v2-chip">${st.n} modèle(s) · ${go(st.b)}</span>${r.free != null ? `<span class="v2-chip">${go(r.free)} libres</span>` : ''}</div>
    ${r.exists ? '' : '<div class="v2-root-w">Ce dossier a été déplacé ou son disque est débranché. « Retrouver mes dossiers » le cherche sur tous les disques.</div>'}
    <div class="v2-root-a"><button class="v2-btn s" data-open="${r.id}" ${r.exists ? '' : 'disabled'}>Ouvrir</button><button class="v2-btn s" data-role="${r.id}" data-to="${other[0]}" title="${other[2]}">${other[1]}</button>${r.exists && st.n ? `<button class="v2-btn s" data-merge="${r.id}" title="Déplacer tous les modèles de ce dossier dans un autre">⇢ Fusionner…</button>` : ''}${r.role === 'store' && r.exists ? `<button class="v2-btn s" data-tidy="${r.id}" title="Ranger ce dossier proprement (par type et par famille), avec un CATALOGUE.md de suivi">🧹 Ranger…</button>` : ''}<span class="v2-grow"></span><button class="v2-btn ghost s" data-del="${r.id}" title="PAIZ arrête de suivre ce dossier ; les fichiers restent sur le disque">Retirer</button></div>
  </div>`;
}
function column(role, title, sub) {
  const list = S.roots.filter((r) => r.role === role);
  const std = role === 'active' ? 'Ready' : 'Reserve';
  return `<section class="v2-rcol"><h2>${title}</h2><p class="v2-muted">${sub}</p>
    <div class="v2-rlist">${list.map(card).join('') || '<div class="v2-empty"><b>Aucun dossier</b>Ajoute-en un ci-dessous.</div>'}</div>
    <div class="v2-radd"><button class="v2-btn p" data-add="${role}">+ Ajouter un dossier</button>
      <span class="v2-muted">ou créer</span><select id="std-${role}" class="v2-sel">${S.drives.map((d) => `<option value="${esc(d.path.replace(/[\\/]+$/, ''))}">${esc(d.path.replace(/[\\/]+$/, ''))}\\PAIZ\\${std} · ${go(d.free)} libres</option>`).join('')}</select><button class="v2-btn s" data-std="${role}">Créer</button></div>
  </section>`;
}
function paint() {
  const el = $('#v2roots-body'); if (!el) return;
  const others = S.roots.filter((r) => r.role !== 'active' && r.role !== 'store');
  el.innerHTML = `<div class="v2-roots">
    <div class="v2-rhead"><div><h2 style="margin:0">Mes dossiers de modèles</h2><p class="v2-muted" style="margin:4px 0 0">PAIZ lance les modèles depuis les dossiers « prêts à lancer » et range les autres en réserve. Tu peux en avoir plusieurs de chaque, sur plusieurs disques.</p></div>
      <button class="v2-btn" onclick="window.paizSetup?.open()" title="Dossiers sur SSD et écurie, OpenCode, premiers modèles">🧭 Assistant de démarrage</button><button class="v2-btn" id="v2-find" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Recherche…' : '🔎 Retrouver mes dossiers'}</button></div>
    <div class="v2-rcols">${column('active', 'Prêts à lancer', 'Sur un disque rapide (SSD). Les modèles que tu utilises.')}${column('store', 'Réserve', 'Sur un disque de stockage. Les modèles que tu ne lances pas en ce moment.')}</div>
    ${others.length ? `<section class="v2-rcol"><h2>Autres dossiers suivis</h2><p class="v2-muted">Dossiers d’autres applis que PAIZ surveille sans y ranger.</p><div class="v2-rlist">${others.map(card).join('')}</div></section>` : ''}
    <p class="v2-muted v2-rnote">Chaque dossier contient un petit fichier <b>PAIZ-repo.json</b> qui dit à quoi il sert. Tu peux déplacer un dossier où tu veux, même sur un autre disque : « Retrouver mes dossiers » le reconnaît et met à jour l’adresse de ses modèles.</p>
  </div>`;
  bind(el);
}
function bind(el) {
  el.querySelector('#v2-find').onclick = async () => {
    S.busy = true; paint();
    try {
      const r = await call('/api/roots/find', 'POST');
      const moved = r.found.filter((x) => x.status === 'moved'); const added = r.found.filter((x) => x.status === 'added');
      say(moved.length || added.length ? `${moved.length} dossier(s) retrouvé(s) à leur nouvelle place, ${added.length} ajouté(s).` : r.missing.length ? `${r.missing.length} dossier(s) toujours introuvable(s) : disque débranché ?` : 'Tous tes dossiers sont à leur place.');
    } catch (e) { say(e.message, 'error'); }
    S.busy = false; load();
  };
  el.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => call(`/api/roots/${b.dataset.open}/open`, 'POST').catch((e) => say(e.message, 'error')); });
  el.querySelectorAll('[data-role]').forEach((b) => { b.onclick = async () => { try { await call(`/api/roots/${b.dataset.role}`, 'PATCH', { role: b.dataset.to }); } catch (e) { say(e.message, 'error'); } load(); }; });
  el.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => {
    const r = S.roots.find((x) => x.id === Number(b.dataset.del)); if (!r || !confirm(`Ne plus suivre « ${r.name} » ?\nLes fichiers restent sur le disque ; PAIZ cesse seulement de surveiller ce dossier.`)) return;
    try { await call(`/api/roots/${r.id}`, 'DELETE'); } catch (e) { say(e.message, 'error'); } load();
  }; });
  el.querySelectorAll('[data-add]').forEach((b) => { b.onclick = async () => {
    let p; try { p = (await call('/api/pick-folder', 'POST', {})).path; } catch (e) { say(e.message, 'error'); return; }
    if (!p) return;
    const base = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p; let name = base; let n = 2;
    while (S.roots.some((r) => r.name.toLowerCase() === name.toLowerCase())) name = `${base} ${n++}`;
    try { await call('/api/roots', 'POST', { name, path: p, role: b.dataset.add }); say('Dossier ajouté. Lance un scan pour y trouver les modèles déjà présents.'); } catch (e) { say(e.message, 'error'); }
    load();
  }; });
  el.querySelectorAll('[data-merge]').forEach((b) => { b.onclick = () => mergeModal(Number(b.dataset.merge)); });
  el.querySelectorAll('[data-tidy]').forEach((b) => { b.onclick = () => tidy(Number(b.dataset.tidy)); });
  el.querySelectorAll('[data-std]').forEach((b) => { b.onclick = async () => {
    const drive = $(`#std-${b.dataset.std}`)?.value; if (!drive) return;
    try { const r = await call('/api/roots/standard', 'POST', { drive, role: b.dataset.std }); say(`Dossier ${r.path} prêt.`); } catch (e) { say(e.message, 'error'); }
    load();
  }; });
}
document.addEventListener('click', (e) => { if (e.target.closest('#tabs .tab[data-view="v2roots"]')) setTimeout(load, 0); });
if (document.querySelector('#view-v2roots.active')) load();

// ---------------------------------------------------------------- Ranger proprement : plan, puis rangement (renommages sur le même disque)
const TOP_FR = { LLM: 'LLM', Images: 'Images (Stable Diffusion, Flux…)', Video: 'Vidéo (Wan, LTX…)', Composants: 'Composants (encodeurs, ONNX)', Applis: 'Fichiers d’applis (structure gardée)', 'A-trier': 'À trier (PAIZ ne sait pas classer)' };
const drive = (p) => String(p || '').slice(0, 2).toUpperCase();
function modal(html) {
  let m = document.getElementById('v2-tidy'); if (!m) { m = document.createElement('div'); m.id = 'v2-tidy'; m.className = 'v2-modal'; document.body.appendChild(m); }
  m.innerHTML = `<div class="v2-modal-box">${html}</div>`; m.hidden = false;
  m.onclick = (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; };
  return m;
}
// Fusionner deux dossiers : les modèles du dossier choisi partent dans l'autre (rangés au passage si c'est une écurie propre).
async function mergeModal(fromId) {
  const r = S.roots.find((x) => x.id === fromId); if (!r) return;
  const st = S.stats[r.id] || { n: 0, b: 0 };
  const targets = S.roots.filter((x) => x.id !== r.id && x.exists).sort((a, b) => (b.role === r.role) - (a.role === r.role));
  let clean = {}; try { clean = Object.fromEntries(((await call('/api/ecurie')).roots || []).filter((c) => c.clean).map((c) => [c.id, true])); } catch {}
  const m = modal(`<h2>Fusionner « ${esc(r.name)} »</h2>
    <p class="v2-muted">Les <b>${st.n}</b> modèle(s) (${go(st.b)}) de ce dossier partent dans le dossier choisi. Sur le même disque c'est instantané ; sur un autre disque ils sont copiés puis vérifiés avant d'effacer l'original. La progression s'affiche dans Modèles › Ma collection.</p>
    <label class="v2-muted">Les envoyer dans</label>
    <select id="merge-into" class="v2-sel" style="width:100%">${targets.map((x) => `<option value="${x.id}">${esc(x.name)} — ${esc(x.path)} · ${go(x.free)} libres${clean[x.id] ? ' · rangé automatiquement' : ''}</option>`).join('')}</select>
    <p class="v2-muted" id="merge-note" style="margin-top:10px"></p>
    <div class="v2-root-a" style="margin-top:14px"><button class="v2-btn p" id="merge-go">Fusionner</button><button class="v2-btn ghost" data-close>Fermer</button></div>`);
  const note = () => { const id = Number(m.querySelector('#merge-into').value); m.querySelector('#merge-note').textContent = clean[id] ? 'Ce dossier est une écurie propre : chaque modèle sera classé par type et par famille en arrivant.' : 'Les modèles arrivent à plat. Ensuite, « Ranger… » du dossier cible les classe proprement.'; };
  m.querySelector('#merge-into').onchange = note; note();
  m.querySelector('#merge-go').onclick = async () => {
    const btn = m.querySelector('#merge-go'); btn.disabled = true; btn.textContent = 'Lancement…';
    try { const res = await call('/api/roots/merge', 'POST', { from: fromId, into: Number(m.querySelector('#merge-into').value), confirm: true }); m.hidden = true; say(`Fusion lancée : ${res.files} modèle(s). Suis-la dans Modèles › Ma collection.`); window.paizV2?.setGroup('models', 'collection'); }
    catch (e) { say(e.message, 'error'); btn.disabled = false; btn.textContent = 'Fusionner'; }
  };
}
async function tidy(rootId) {
  const r = S.roots.find((x) => x.id === rootId); if (!r) return;
  const same = S.roots.filter((x) => x.role === 'store' && x.exists && drive(x.path) === drive(r.path));
  const std = `${drive(r.path)}\\PAIZ\\Reserve`;
  const hasStd = same.some((x) => x.path.toLowerCase() === std.toLowerCase());
  const m = modal(`<h2>Ranger « ${esc(r.name)} »</h2>
    <p class="v2-muted">PAIZ classe chaque modèle par type et par famille, sur le même disque (renommages instantanés, rien n'est copié ni effacé). Les fichiers qui accompagnent un modèle (tokenizer, config) le suivent. Un journal permet de tout annuler.</p>
    <label class="v2-muted">Ranger vers</label>
    <select id="tidy-into" class="v2-sel" style="width:100%">
      ${hasStd ? '' : `<option value="new">Une nouvelle écurie propre : ${esc(std)} (recommandé)</option>`}
      ${same.map((x) => `<option value="${x.id}" ${x.path.toLowerCase() === std.toLowerCase() ? 'selected' : ''}>${x.id === r.id ? 'Sur place, dans ce dossier' : `${esc(x.name)} — ${esc(x.path)}`}</option>`).join('')}
    </select>
    <div id="tidy-plan" style="margin-top:12px"></div>
    <div class="v2-root-a" style="margin-top:14px"><button class="v2-btn p" id="tidy-go" disabled>Ranger</button><button class="v2-btn ghost" data-close>Fermer</button><span class="v2-grow"></span><button class="v2-btn ghost s" id="tidy-undo" title="Remet chaque fichier là où il était avant le dernier rangement">Annuler le dernier rangement</button></div>`);
  let into = null; let plan = null;
  const showPlan = async () => {
    const v = m.querySelector('#tidy-into').value; const box = m.querySelector('#tidy-plan'); m.querySelector('#tidy-go').disabled = true;
    if (v === 'new') { into = 'new'; box.innerHTML = `<p class="v2-muted">Le dossier <b>${esc(std)}</b> sera créé, puis le plan affiché.</p>`; m.querySelector('#tidy-go').disabled = false; m.querySelector('#tidy-go').textContent = 'Créer et voir le plan'; return; }
    into = Number(v); box.innerHTML = '<p class="v2-muted">Calcul du plan…</p>';
    try { plan = await call(`/api/ecurie/plan?rootId=${rootId}&into=${into}`); } catch (e) { box.innerHTML = `<p class="v2-root-w">${esc(e.message)}</p>`; return; }
    const tops = Object.entries(plan.tops || {}).sort((a, b) => b[1] - a[1]);
    box.innerHTML = `<p><b>${plan.moves.length}</b> fichier(s) à ranger (${go(plan.bytes)}) · ${plan.stay} déjà à leur place${plan.merges.length ? ` · <b>${plan.merges.length}</b> copie(s) identique(s) fusionnée(s) (contenu vérifié avant)` : ''}${plan.dupes.length ? ` · ${plan.dupes.length} laissé(s) : nom déjà pris` : ''}</p>
      <div class="v2-root-c">${tops.map(([t, n]) => `<span class="v2-chip">${esc(TOP_FR[t] || t)} · ${n}</span>`).join('')}</div>
      <details style="margin-top:10px"><summary class="v2-muted">Voir chaque fichier (ancien → nouveau)</summary><div class="v2-tidy-list">${plan.moves.map((x) => `<div><span class="v2-root-p">${esc(x.from.slice(plan.root.path.length + 1))}</span><span>→ ${esc(x.rel)}</span></div>`).join('')}</div></details>
      ${plan.toSort.length ? `<p class="v2-root-w" style="margin-top:8px">${plan.toSort.length} fichier(s) iront dans « A-trier » : PAIZ ne devine pas leur type. Tu pourras corriger leur catégorie dans CATALOGUE.md.</p>` : ''}`;
    m.querySelector('#tidy-go').textContent = `Ranger (${plan.moves.length + plan.merges.length})`; m.querySelector('#tidy-go').disabled = !(plan.moves.length + plan.merges.length);
  };
  m.querySelector('#tidy-into').onchange = showPlan; showPlan();
  m.querySelector('#tidy-go').onclick = async () => {
    const btn = m.querySelector('#tidy-go'); btn.disabled = true;
    if (into === 'new') {
      try { const nr = await call('/api/roots/standard', 'POST', { drive: drive(r.path), role: 'store' }); await load(); tidy(rootId); setTimeout(() => { const sel = document.querySelector('#tidy-into'); if (sel) { sel.value = String(nr.id); sel.onchange(); } }, 50); } catch (e) { say(e.message, 'error'); btn.disabled = false; }
      return;
    }
    btn.textContent = 'Rangement…';
    try {
      const res = await call('/api/ecurie/apply', 'POST', { rootId, into, confirm: true });
      m.querySelector('#tidy-plan').innerHTML = `<p>✔ <b>${res.moved}</b> modèle(s) rangé(s), ${res.companions} fichier(s) d'accompagnement, ${res.merged} copie(s) fusionnée(s).${res.failed.length ? ` <span class="v2-root-w">${res.failed.length} non rangé(s) : ${esc(res.failed.slice(0, 4).map((f) => `${f.file || ''} (${f.error})`).join(' ; '))}</span>` : ''}</p><p class="v2-muted">Le fichier <b>CATALOGUE.md</b> est dans le dossier rangé : tu peux y écrire des notes et corriger des catégories, PAIZ les relit.</p>`;
      btn.textContent = 'Fait'; load();
    } catch (e) { say(e.message, 'error'); btn.disabled = false; btn.textContent = 'Ranger'; }
  };
  m.querySelector('#tidy-undo').onclick = async () => {
    const target = typeof into === 'number' ? into : rootId;
    if (!confirm('Annuler le dernier rangement de ce dossier ? Chaque fichier retourne à son ancienne place.')) return;
    try { const u = await call('/api/ecurie/undo', 'POST', { rootId: target }); say(`${u.restored} fichier(s) remis en place.${u.failed.length ? ` ${u.failed.length} problème(s).` : ''}`); load(); showPlan(); } catch (e) { say(e.message, 'error'); }
  };
}
