// Nouvelle interface (« version simple ») : bandeau, quatre onglets, pastille moteur, roue des réglages, bulles d'aide.
// Les écrans existants sont réutilisés tels quels (on clique leurs onglets cachés) ; seule la coquille change. L'ancienne interface reste intacte.
import { getLang, setLang } from '/i18n.js';
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function call(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status}`);
  return d;
}
function say(msg, kind = '') { const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg; $('#toasts')?.appendChild(el); setTimeout(() => el.remove(), 5000); }
const svg = (d, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg>`;
const IC = {
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  models: 'M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10',
  tools: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
  care: 'M4 21h16M6 17l2-10h8l2 10M9 7V3h6v4',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  down: 'M6 9l6 6 6-6',
};
const GROUPS = {
  chat: { label: 'Discuter', icon: IC.chat, subs: [['work', '']] },
  models: { label: 'Modèles', icon: IC.models, subs: [['collection', 'Ma collection'], ['hub', 'Trouver en ligne'], ['catalogue', 'Liste détaillée'], ['v2roots', 'Dossiers']] },
  tools: { label: 'Outils', icon: IC.tools, subs: [['tools:mine', 'Mes outils'], ['tools:catalog', 'Catalogue']] },
  care: { label: 'Ménage', icon: IC.care, subs: [['v2care', 'Vue d’ensemble'], ['duplicates', 'Doublons'], ['components', 'Accessoires partagés'], ['ecurie', 'Réserve rangée'], ['care', 'Détails']] },
  settings: { label: 'Réglages', icon: IC.gear, subs: [['v2engine', 'Moteur'], ['engine:connexions', 'Connexions'], ['scan', 'Scanner'], ['disks', 'Disques'], ['settings', 'Avancé']] },
};
const mem = (() => { try { return JSON.parse(localStorage.getItem('paiz.v2') || '{}'); } catch { return {}; } })();
const save = () => { try { localStorage.setItem('paiz.v2', JSON.stringify(mem)); } catch { /* stockage indisponible */ } };
let group = GROUPS[mem.group] ? mem.group : 'chat';

function paintShell() {
  $('#v2-shell').innerHTML = `
  <header class="v2-head">
    <div class="v2-logo"><img src="/v2/logo.webp" alt=""><span>PA<b>IZ</b></span></div>
    <nav class="v2-tabs" aria-label="Onglets">${['chat', 'models', 'tools', 'care'].map((g) => `<button class="v2-tab" data-g="${g}">${svg(GROUPS[g].icon)}${GROUPS[g].label}</button>`).join('')}</nav>
    <span class="v2-grow"></span>
    <button class="v2-mon" id="v2-mon" aria-label="Charge de la machine" title="Charge de la machine"><i data-m="cpu"><b></b></i><i data-m="ram"><b></b></i><i data-m="gpu"><b></b></i><i data-m="vram"><b></b></i></button>
    <div class="v2-pillwrap"><button class="v2-pill" id="v2-pill" aria-haspopup="dialog" aria-label="Moteur : réglages rapides"><span class="v2-dot off"></span><span id="v2-pilltxt">Moteur…</span></button><div class="v2-pop" id="v2-pop" hidden></div></div>
    <button class="v2-lang" id="v2-lang" title="Language / Langue">${getLang() === 'en' ? 'FR' : 'EN'}</button>
    <button class="v2-gear" data-g="settings" aria-label="Réglages">${svg(IC.gear, 22)}</button>
  </header>
  <nav class="v2-subs" id="v2-subs" aria-label="Sous-sections"></nav>`;
  document.querySelectorAll('#v2-shell [data-g]').forEach((b) => { b.onclick = () => setGroup(b.dataset.g); });
  $('#v2-pill').onclick = (e) => { e.stopPropagation(); togglePop(); };
  $('#v2-lang').onclick = () => setLang(getLang() === 'en' ? 'fr' : 'en');
}

function show(view) {
  const [v, sub] = view.split(':');
  if (v === 'tools') { document.body.dataset.v2tools = sub || 'mine'; $(`#tabs .tab[data-view="tools"]`)?.click(); return; }
  $(`#tabs .tab[data-view="${v}"]`)?.click();
  if (sub) { // sous-écran du moteur (Réglages, Connexions) : on attend qu'il soit dessiné, puis on clique son bouton
    let n = 0; const t = setInterval(() => { const b = $(`#engine-body [data-sub="${sub}"]`); n++; if (b) { if (!b.classList.contains('primary')) b.click(); clearInterval(t); } else if (n > 40) clearInterval(t); }, 60);
  }
}
function setGroup(g, sub) {
  group = g; mem.group = g; const G = GROUPS[g];
  let cur = sub || mem[`sub_${g}`] || G.subs[0][0]; if (!G.subs.some(([v]) => v === cur)) cur = G.subs[0][0]; // un onglet disparu : le premier
  mem[`sub_${g}`] = cur; save();
  document.body.dataset.v2group = g;
  document.querySelectorAll('#v2-shell [data-g]').forEach((b) => b.classList.toggle('on', b.dataset.g === g));
  const subs = $('#v2-subs');
  subs.innerHTML = G.subs.length > 1 ? G.subs.map(([v, l]) => `<button class="v2-sub ${v === cur ? 'on' : ''}" data-v="${v}">${esc(l)}</button>`).join('') : '';
  subs.hidden = G.subs.length <= 1;
  subs.querySelectorAll('[data-v]').forEach((b) => { b.onclick = () => setGroup(g, b.dataset.v); });
  closePop(); show(cur);
}

// ------------------------------------------------------------------ pastille moteur
let eng = null; let pick = { assetId: null, where: null, profile: null }; let assets = null;
const isLossy = (name) => /(?:^|[-_.])I?Q[23](?:_[A-Z0-9]+)*\.gguf$/i.test(String(name || ''));
const shortName = (p) => String(p || '').split(/[\\/]/).pop().replace(/\.gguf$/i, '').replace(/[-_.](I?Q\d\w*|BF16|F16)$/i, '').replace(/[-_]/g, ' ');
const quantOf = (p) => (String(p || '').replace(/\.gguf$/i, '').match(/(?:^|[-_.])((?:I?Q\d(?:_[A-Z0-9]+)*)|BF16|F16|MXFP4)$/i) || [])[1] || '';
const clean = (l) => String(l || '').replace(/^[^\p{L}\p{N}]+\s*/u, '');
function optionOf(profile) { for (const w of eng?.grid || []) { const o = w.options.find((x) => x.profile === profile); if (o) return { where: w.id, option: o }; } return null; }

async function poll() {
  try { eng = await call('/api/engine'); } catch { eng = null; }
  const on = !!eng?.running; const cur = eng?.current;
  const dot = !on ? 'off' : eng.loading ? 'load' : '';
  const name = cur?.path ? shortName(cur.path) : '';
  const lossy = isLossy(cur?.path);
  const lvl = lossy ? '<span class="v2-chip light">Légère</span>' : on ? `<span class="v2-chip go">${esc(clean(optionOf(cur?.profile)?.option?.label) || cur?.profile || '')}</span>` : '';
  const pct = eng?.loading && eng.loadEstimate ? ` · ${Math.min(99, Math.round((eng.loadElapsed / eng.loadEstimate) * 100))} %` : '';
  const pill = $('#v2-pill'); if (!pill) return;
  pill.classList.toggle('light', on && lossy);
  pill.innerHTML = `<span class="v2-dot ${dot}"></span><span>${on ? esc(name) + (eng.loading ? ` <span class="v2-muted">chargement${pct}</span>` : '') : 'Moteur éteint'}</span>${lvl}${svg(IC.down, 16)}`;
  if (!$('#v2-pop').hidden) paintPop(false);
}
async function togglePop() { const p = $('#v2-pop'); if (!p.hidden) { closePop(); return; } p.hidden = false; $('#v2-pill').classList.add('open'); await paintPop(true); }
function closePop() { const p = $('#v2-pop'); if (p) p.hidden = true; $('#v2-pill')?.classList.remove('open'); }
async function paintPop(fresh) {
  const pop = $('#v2-pop'); if (!pop || pop.hidden) return;
  if (fresh || !assets) {
    try {
      const [a, r] = await Promise.all([call('/api/assets?q=.gguf&limit=1000&sort=size'), call('/api/models/recent').catch(() => ({ recent: {} }))]);
      const rec = r.recent || {};
      assets = (a.items || []).filter((x) => /\.gguf$/i.test(x.file_name) && !/mmproj/i.test(x.file_name) && x.root_role === 'active' && x.state !== 'missing')
        .sort((x, y) => (Date.parse(rec[y.id] || 0) || 0) - (Date.parse(rec[x.id] || 0) || 0));
    } catch { assets = []; }
    const cur = eng?.current;
    pick.assetId = cur?.assetId || pick.assetId || assets[0]?.id || null;
    const p0 = cur?.profile || eng?.defaultProfile || 'normal'; const o = optionOf(p0);
    pick.profile = o ? p0 : 'normal'; pick.where = o?.where || 'gpu';
  }
  const a = assets.find((x) => x.id === pick.assetId) || null;
  const lossy = isLossy(a?.file_name);
  const on = !!eng?.running; const cur = eng?.current;
  const same = on && cur?.assetId === pick.assetId && (lossy || cur?.profile === pick.profile);
  const grid = (eng?.grid || []).filter((w) => w.id !== 'xl');
  const W = grid.find((w) => w.id === pick.where) || grid[0];
  if (W && !W.options.some((o) => o.profile === pick.profile)) pick.profile = W.options[Math.min(1, W.options.length - 1)].profile;
  const info = eng?.profileInfo?.[lossy ? 'extralight' : pick.profile] || {};
  const action = same ? '<button class="v2-btn" id="v2-stop">Arrêter</button>' : `<button class="v2-btn p" id="v2-go">${on ? 'Relancer avec ce choix' : 'Lancer'}</button>`;
  pop.innerHTML = `
    <div class="v2-poph"><span class="v2-dot ${on ? (eng.loading ? 'load' : '') : 'off'}"></span><b>${on ? (eng.loading ? 'Chargement du modèle…' : 'Moteur allumé') : 'Moteur éteint'}</b><span class="v2-grow"></span>${action}</div>
    <div class="v2-lbl">Modèle</div>
    <div class="v2-mlist">${assets.slice(0, 7).map((x) => `<button class="v2-m ${x.id === pick.assetId ? 'on' : ''}" data-a="${x.id}"><span class="v2-mn">${esc(shortName(x.file_name))}</span>${isLossy(x.file_name) ? '<span class="v2-chip light">Légère</span>' : `<span class="v2-chip">${esc(quantOf(x.file_name))}</span>`}<span class="v2-chip">${(x.size_bytes / 1024 ** 3).toFixed(1).replace('.', ',')} Go</span></button>`).join('') || '<div class="v2-muted">Aucun modèle de discussion prêt à lancer. Sors-en un de la réserve dans Modèles.</div>'}</div>
    <button class="v2-m v2-cloudbtn" id="v2-cloud" title="Choisir un modèle cloud gratuit (OpenCode) pour la session de discussion ouverte"><span class="v2-mn">☁ OpenCode Free Cloud Models…</span><span class="v2-chip">OpenCode</span></button>
    ${lossy ? '<div class="v2-note">Version légère : plus rapide, moins fiable. Elle a un seul réglage, rien à choisir.</div>' : `
    <div class="v2-lbl">Où il travaille <button class="v2-q" data-tip="La carte graphique va plus vite. La mémoire vive laisse la carte libre pour un jeu ou une autre appli. Adaptatif suit la mémoire libre de la machine.">?</button></div>
    <div class="v2-seg">${grid.map((w) => `<button class="${w.id === pick.where ? 'on' : ''}" data-w="${w.id}">${esc({ gpu: 'Carte graphique', ram: 'Mémoire vive', auto: 'Adaptatif' }[w.id] || clean(w.label))}</button>`).join('')}</div>
    <div class="v2-lbl">Sobre ou rapide</div>
    <div class="v2-steps">${(W?.options || []).map((o) => `<button class="${o.profile === pick.profile ? 'on' : ''}" data-p="${esc(o.profile)}" title="${esc(eng?.profileInfo?.[o.profile]?.desc || '')}">${esc(clean(o.label))}</button>`).join('')}</div>`}
    ${info.conso ? `<div class="v2-conso">${esc(info.conso)}</div>` : ''}
    <label class="v2-check"><input type="checkbox" id="v2-auto" ${eng?.autoload ? 'checked' : ''}> Lancer au démarrage de PAIZ</label>`;
  $('#v2-cloud')?.addEventListener('click', () => { closePop(); setGroup('chat'); setTimeout(() => { const b = document.getElementById('w-modelbtn'); if (b) b.click(); else say('Ouvre d’abord une session de discussion : le modèle cloud se choisit pour la session.', 'error'); }, 200); });
  pop.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => { pick.assetId = Number(b.dataset.a); paintPop(false); }; });
  pop.querySelectorAll('[data-w]').forEach((b) => { b.onclick = () => { pick.where = b.dataset.w; paintPop(false); }; });
  pop.querySelectorAll('[data-p]').forEach((b) => { b.onclick = () => { pick.profile = b.dataset.p; paintPop(false); }; });
  if ($('#v2-stop')) $('#v2-stop').onclick = async () => { try { await call('/api/engine/stop', 'POST'); say('Moteur arrêté.'); } catch (e) { say(e.message, 'error'); } poll(); };
  if ($('#v2-go')) $('#v2-go').onclick = async () => {
    if (!a) return;
    try { await call('/api/engine/summon', 'POST', { assetId: a.id, profile: lossy ? 'extralight' : pick.profile, activeRoot: a.root_id }); say(`${shortName(a.file_name)} se lance.`); closePop(); } catch (e) { say(e.message, 'error'); }
    setTimeout(poll, 800);
  };
  $('#v2-auto').onchange = async (e) => { try { await call('/api/engine/settings', 'POST', { autoload: e.target.checked }); say(e.target.checked ? 'Le dernier modèle se lancera au démarrage de PAIZ.' : 'Lancement au démarrage désactivé.'); } catch (er) { say(er.message, 'error'); } };
}
document.addEventListener('click', (e) => { const p = $('#v2-pop'); if (p && !p.hidden && e.target.isConnected && !e.target.closest('#v2-pop') && !e.target.closest('#v2-pill')) closePop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePop(); closeTip(); } });
window.paizV2 = { setGroup, poll, openModel: (id) => { setGroup('models', 'collection'); window.dispatchEvent(new CustomEvent('paiz:v2-select', { detail: id })); } };

// ------------------------------------------------------------------ bulles d'aide
// Les longs paragraphes d'explication des anciens écrans deviennent une bulle derrière un « ? » à côté du titre.
let tipEl = null;
function closeTip() { tipEl?.remove(); tipEl = null; }
function openTip(btn, text) {
  closeTip(); tipEl = document.createElement('div'); tipEl.className = 'v2-bubble'; tipEl.textContent = text; document.body.appendChild(tipEl);
  const r = btn.getBoundingClientRect(); const w = Math.min(340, window.innerWidth - 24);
  tipEl.style.width = `${w}px`; tipEl.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, r.left - 20))}px`; tipEl.style.top = `${r.bottom + window.scrollY + 8}px`;
}
document.addEventListener('click', (e) => {
  const q = e.target.closest('.v2-q');
  if (q) { e.preventDefault(); e.stopPropagation(); if (tipEl && tipEl.dataset.for === q.dataset.tip) { closeTip(); return; } openTip(q, q.dataset.tip); tipEl.dataset.for = q.dataset.tip; return; }
  if (tipEl && !e.target.closest('.v2-bubble')) closeTip();
}, true);
function bubbleize(root) {
  root.querySelectorAll('.panel-head > p, .panel-head > .muted').forEach((p) => {
    if (p.dataset.v2b) return; const t = p.textContent.replace(/\s+/g, ' ').trim(); p.dataset.v2b = '1';
    if (t.length < 90) return;
    const h = p.parentElement.querySelector('h2, h3'); if (!h) return;
    p.classList.add('v2-hidden-help');
    const b = document.createElement('button'); b.className = 'v2-q'; b.type = 'button'; b.textContent = '?'; b.dataset.tip = t; b.setAttribute('aria-label', 'Aide');
    h.appendChild(b);
  });
}
new MutationObserver(() => bubbleize(document.querySelector('main') || document.body)).observe(document.body, { childList: true, subtree: true });

// ------------------------------------------------------------------ réglages du moteur (écran propre)
const CTX = [[4096, '4 000'], [8192, '8 000'], [16384, '16 000 (conseillé)'], [32768, '32 000'], [65536, '65 000']];
const KV = [['', 'Normale'], ['q8_0', 'Réduite (−47 %)'], ['q4_0', 'Très réduite (−72 %, change le texte)']];
const TOOLS = [['auto', 'Automatique'], ['focus', 'Fichiers seulement'], ['all', 'Tous']];
let ES = null;
async function paintEngineSettings() {
  const el = $('#v2engine-body'); if (!el) return;
  try { const [st, e] = await Promise.all([call('/api/engine/settings'), call('/api/engine')]); ES = { ...st }; ES.profiles = e.profiles || []; ES.info = e.profileInfo || {}; ES.running = !!e.running; } catch (er) { el.innerHTML = `<div class="v2-empty">${esc(er.message)}</div>`; return; }
  draw();
  function draw() {
    const ctxList = CTX.some(([v]) => v === Number(ES.ctx)) ? CTX : [...CTX, [Number(ES.ctx), String(ES.ctx)]];
    const seg = (key, list) => `<div class="v2-seg">${list.map(([v, l]) => `<button data-k="${key}" data-v="${esc(v)}" class="${String(ES[key]) === String(v) ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
    el.innerHTML = `<div class="v2-form">
      <section class="v2-fsec"><h2>Au démarrage</h2>
        <label class="v2-check"><input type="checkbox" id="e-auto" ${ES.autoload ? 'checked' : ''}> Lancer le dernier modèle utilisé quand PAIZ s’ouvre</label></section>
      <section class="v2-fsec"><h2>Mémoire de conversation</h2>
        <div class="v2-lbl">Longueur retenue (en jetons) <button class="v2-q" data-tip="Combien de texte le modèle garde en tête pendant une conversation. Plus c’est long, plus il faut de mémoire. 16 000 convient aux agents de code.">?</button></div>
        ${seg('ctx', ctxList)}
        <div class="v2-lbl">Conversations en même temps <button class="v2-q" data-tip="Chaque conversation en plus garde environ 2 Go de mémoire graphique. Une seule suffit : une tâche de fond en ouvre une seconde toute seule, le temps qu’elle tourne.">?</button></div>
        ${seg('slots', [[1, '1'], [2, '2'], [3, '3'], [4, '4']])}
        <div class="v2-lbl">Compression de cette mémoire <button class="v2-q" data-tip="Réduire la place prise par la conversation. « Réduite » ne change presque rien ; « Très réduite » change un peu le texte produit.">?</button></div>
        ${seg('kvType', KV)}</section>
      <section class="v2-fsec"><h2>Agents de code</h2>
        <div class="v2-lbl">Outils proposés au modèle <button class="v2-q" data-tip="Chaque outil proposé est relu à chaque conversation. Automatique ne garde que ceux dont la demande a besoin : plus rapide.">?</button></div>
        ${seg('toolMode', TOOLS)}</section>
      <details class="v2-fsec v2-adv"><summary>Avancé</summary>
        <label class="v2-field">Réglage par défaut<select id="e-profile">${ES.profiles.map((p) => `<option value="${esc(p)}" ${p === ES.profile ? 'selected' : ''}>${esc(ES.info[p]?.label || p)}</option>`).join('')}</select></label>
        <label class="v2-field">Port de l’API <span class="v2-muted">(8770 est aussi utilisé par d’autres applis)</span><input id="e-port" type="number" min="1024" max="65535" value="${esc(ES.port)}"></label>
        <label class="v2-field">Options supplémentaires du moteur<input id="e-extra" value="${esc(ES.extraArgs || '')}" placeholder="ex. --ubatch 512"></label>
        <label class="v2-field">Programme du moteur<input id="e-exe" value="${esc(ES.exe || '')}"></label>
        <label class="v2-field">Dossier du moteur<input id="e-dir" value="${esc(ES.dir || '')}"></label></details>
      <div class="v2-fsave"><button class="v2-btn p" id="e-save">Enregistrer</button><span class="v2-muted">${ES.running ? 'Le modèle en marche garde ses réglages jusqu’à son prochain lancement.' : 'Pris en compte au prochain lancement d’un modèle.'}</span></div></div>`;
    el.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => { ES[b.dataset.k] = b.dataset.v; draw(); }; });
    $('#e-auto').onchange = (e) => { ES.autoload = e.target.checked; };
    $('#e-save').onclick = async () => {
      try {
        await call('/api/engine/settings', 'POST', { profile: $('#e-profile').value, ctx: ES.ctx, slots: ES.slots, kvType: ES.kvType, toolMode: ES.toolMode, port: $('#e-port').value, extraArgs: $('#e-extra').value, exe: $('#e-exe').value, dir: $('#e-dir').value, autoload: ES.autoload });
        say('Réglages du moteur enregistrés.'); poll();
      } catch (er) { say(er.message, 'error'); }
    };
  }
}
document.addEventListener('click', (e) => { if (e.target.closest('#tabs .tab[data-view="v2engine"]')) setTimeout(paintEngineSettings, 0); });

// Outils : chaque panneau est rangé dans un des trois onglets (Mes outils / Catalogue / Skills)
function tagTools() {
  document.querySelectorAll('#view-tools .panel').forEach((p) => {
    if (p.dataset.v2part) return; const h = p.querySelector(':scope > .panel-head h2, :scope > .panel-head h3')?.textContent || '';
    p.dataset.v2part = /Mes serveurs/i.test(h) ? 'mine' : /Catalogue|Ajouter à la main/i.test(h) ? 'catalog' : /Skills/i.test(h) ? 'skills' : /Outils \(MCP\)/i.test(h) ? 'mcp' : p.classList.contains('muted') ? 'hint' : 'other';
  });
}
function addToolCta() {
  const p = document.querySelector('#view-tools [data-v2part="mine"]'); if (!p || p.querySelector('.v2-cta')) return;
  const b = document.createElement('button'); b.className = 'v2-btn p v2-cta'; b.type = 'button'; b.textContent = '+ Ajouter un outil'; b.style.marginTop = '12px';
  b.onclick = () => setGroup('tools', 'tools:catalog'); p.appendChild(b);
}
new MutationObserver(() => { tagTools(); addToolCta(); }).observe(document.body, { childList: true, subtree: true });

// Connexions : chaque exemple de code est replié (on ne voit que son titre), un clic l'ouvre.
function foldExamples(root) {
  // aussi : les panneaux secondaires des Dossiers suivis (journal, données & API)
  const secondary = [...root.querySelectorAll('#view-settings .panel')].slice(1);
  [...root.querySelectorAll('#engine-body .panel'), ...secondary].forEach((p) => {
    if (p.dataset.v2f || (!p.querySelector('pre') && !secondary.includes(p))) return; p.dataset.v2f = '1';
    const head = p.querySelector('.panel-head'); if (!head) return;
    p.classList.add('v2-fold'); head.setAttribute('role', 'button'); head.tabIndex = 0;
    const flip = () => p.classList.toggle('open');
    head.addEventListener('click', (e) => { if (!e.target.closest('.v2-q')) flip(); });
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
  });
}
new MutationObserver(() => foldExamples(document)).observe(document.body, { childList: true, subtree: true });


// ------------------------------------------------------------------ jauges de la machine
// Quatre barres verticales (processeur, mémoire vive, carte graphique, mémoire graphique), du vert au rouge, mises à jour en direct.
let monTxt = '';
async function pollSys() {
  let s; try { s = await call('/api/sys'); } catch { return; }
  const pct = { cpu: s.cpu, ram: s.ram ? (s.ram.usedMb / s.ram.totalMb) * 100 : null, gpu: s.gpu?.util ?? null, vram: s.gpu ? (s.gpu.vramUsedMb / s.gpu.vramTotalMb) * 100 : null };
  document.querySelectorAll('#v2-mon i').forEach((i) => {
    const v = pct[i.dataset.m]; i.hidden = v == null; if (v == null) return;
    const b = i.firstElementChild; const x = Math.max(4, Math.min(100, v));
    b.style.height = `${x}%`;
  });
  const go = (mb) => `${(mb / 1024).toFixed(1).replace('.', ',')} Go`;
  monTxt = [s.cpu != null && `Processeur : ${s.cpu} %`, s.ram && `Mémoire vive : ${go(s.ram.usedMb)} / ${go(s.ram.totalMb)}`, s.gpu && `Carte graphique : ${s.gpu.util} % de calcul`, s.gpu && `Mémoire graphique : ${go(s.gpu.vramUsedMb)} / ${go(s.gpu.vramTotalMb)}`].filter(Boolean).join('\n');
  const m = $('#v2-mon'); if (m) { m.title = monTxt; if (tipEl?.dataset.for === 'mon') tipEl.textContent = monTxt; }
}

paintShell();
$('#v2-mon').onclick = (e) => { e.stopPropagation(); if (tipEl?.dataset.for === 'mon') { closeTip(); return; } openTip($('#v2-mon'), monTxt || 'Mesure en cours…'); tipEl.dataset.for = 'mon'; tipEl.style.whiteSpace = 'pre-line'; };
pollSys(); setInterval(() => { if (!document.hidden) pollSys(); }, 1500);
setGroup(group);
poll(); setInterval(() => { if (!document.hidden) poll(); }, 3000);
