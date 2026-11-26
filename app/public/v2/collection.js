// « Ma collection » (nouvelle interface) : tous les modèles sur deux étagères (prêts à lancer / en réserve), des filtres simples,
// et une fiche par modèle qui regroupe ce qui était éparpillé : infos, utilisation, modèles liés, version légère.
import { famBadge } from '/fam.js';
import { moveFlow } from '/moveflow.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const go = (n) => (n == null ? '—' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} Go` : `${Math.max(1, Math.round(n / 1024 ** 2))} Mo`);
const day = (iso) => { if (!iso) return 'jamais'; const d = new Date(iso); const diff = (Date.now() - d) / 86400000; return diff < 1 ? 'aujourd’hui' : diff < 2 ? 'hier' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: diff > 300 ? 'numeric' : undefined }); };
async function call(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status}`);
  return d;
}
function say(msg, kind = '') { const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg; $('#toasts')?.appendChild(el); setTimeout(() => el.remove(), 5000); }

const ACC = new Set(['vae', 'clip', 'embedding', 'controlnet', 'upscaler', 'ipadapter', 'faceid', 'onnx']);
// Accessoire : encodeur de texte, VAE, CLIP, module d'image… reconnu à sa catégorie, à son dossier (clip, text_encoders, vae…) ou à son nom.
const ACC_DIR = /[\\/](clip|clip_vision|text_encoders?|vae|vae_approx|embeddings|controlnet|upscale_models|ipadapter|insightface|facerestore_models|sams?|yolo\w*)[\\/]/i;
const ACC_NAME = /^(clip_[lg]\b|clip[-_]vit|t5xxl|umt5|qwen_3_\d|qwen_2\.5_vl|byt5|llava.*vision|text_enc|models_t5|models_clip|sam_vit|depth[-_]anything|open_clip|model_bs_roformer|synchformer|mmaudio)|(^|[-_.])vae([-_.]|$)|^ae\.safetensors$/i;
const kindOf = (a) => {
  if (a.category === 'lora') return 'lora';
  if (/mmproj/i.test(a.file_name) || ACC.has(a.category) || ACC_DIR.test(a.abs_path) || ACC_NAME.test(a.file_name)) return 'acc';
  if (/\.gguf$/i.test(a.file_name) && a.category !== 'checkpoint') return 'llm';
  if (a.category !== 'checkpoint' && (a.size_bytes || 0) < 800 * 1024 ** 2) return 'acc'; // petits fichiers d'outils (détection de visages, segmentation…)
  return 'media';
};
const KIND_LABEL = { llm: 'discussion', media: 'image · vidéo', lora: 'LoRA', acc: 'accessoire' };
const quantOf = (n) => (String(n).replace(/\.gguf$/i, '').match(/(?:^|[-_.])((?:I?Q\d(?:_[A-Z0-9]+)*)|BF16|F16|F32|MXFP4)$/i) || [])[1]?.toUpperCase() || '';
const isLossy = (n) => /(?:^|[-_.])I?Q[23](?:_[A-Z0-9]+)*\.gguf$/i.test(n);
const nice = (a) => (a.title || a.file_name).replace(/\.(gguf|safetensors|ckpt|pt|bin|sft|pth|onnx)$/i, '');
const FILTERS = [['all', 'Tout'], ['llm', 'Discussion'], ['media', 'Images et vidéo'], ['lora', 'LoRA'], ['acc', 'Accessoires']];

const S = { moe: {}, items: [], recent: {}, usage: {}, fresh: new Set(), eng: null, filter: 'all', q: '', sel: null, tab: 'infos', more: {}, quant: null, qpick: null, rel: {}, opts: {} };
let qTimer = null;

async function load() {
  try {
    const [a, r, u, e, q] = await Promise.all([
      call('/api/assets?limit=5000&sort=size'), call('/api/models/recent').catch(() => ({ recent: {} })),
      call('/api/usage/models').catch(() => ({ rows: [] })), call('/api/engine').catch(() => null), call('/api/quantize/status').catch(() => null)]);
    S.items = (a.items || []).filter((x) => x.state !== 'missing' && x.state !== 'trashed');
    S.recent = r.recent || {}; S.usage = Object.fromEntries((u.rows || []).map((x) => [x.id, x])); S.eng = e; S.quant = q; S.fresh = new Set(q?.fresh || []);
  } catch (err) { say(err.message, 'error'); }
  paint();
  call('/api/models/moe').then((m) => { S.moe = m.moe || {}; paint(); }).catch(() => {});
  if (S.quant?.running) { clearTimeout(qTimer); qTimer = setTimeout(load, 1500); }
}

function card(a) {
  const k = kindOf(a); const ready = a.root_role === 'active'; const u = S.usage[a.id];
  const cur = S.eng?.current?.assetId === a.id && S.eng?.running;
  const q = k === 'llm' ? quantOf(a.file_name) : '';
  const chips = [
    isLossy(a.file_name) ? `<span class="v2-chip light" title="Version allégée (avec perte) : plus rapide, moins fiable">${esc(q)} · légère</span>` : q ? `<span class="v2-chip" title="Niveau de compression">${esc(q)}</span>` : '',
    k === 'llm' && S.moe[a.id] ? (S.moe[a.id].moe ? `<span class="v2-chip moe" title="Modèle à experts (MoE) : ${S.moe[a.id].used || '?'} experts sur ${S.moe[a.id].experts || '?'} par mot. PAIZ le streame : il tourne avec bien moins de mémoire.">MoE</span>` : '<span class="v2-chip" title="Modèle dense : il utilise tous ses poids à chaque mot. PAIZ le lance, mais ne peut pas l’alléger par le streaming.">dense</span>') : '',
    cur ? '<span class="v2-chip go">en marche</span>' : '',
    u?.status === 'star' ? '<span class="v2-chip go">souvent utilisé</span>' : u?.status === 'jamais' ? '<span class="v2-chip never">jamais utilisé</span>' : '',
    S.fresh.has(a.id) ? '<span class="v2-chip light">nouveau</span>' : '',
  ].join('');
  const act = k === 'llm' && ready ? (cur ? '' : `<button class="v2-btn sp" data-run="${a.id}">Lancer</button>`) : !ready ? `<button class="v2-btn s" data-out="${a.id}">Sortir</button>` : '';
  return `<div class="v2-card ${S.sel === a.id ? 'on' : ''} ${S.fresh.has(a.id) ? 'fresh' : ''}" data-id="${a.id}" tabindex="0" role="button" aria-label="${esc(nice(a))}">
    <div class="v2-ct">${famBadge(nice(a))}<div class="v2-cn"><b>${esc(nice(a))}</b><span>${go(a.size_bytes)} · ${esc(a.base_model && k !== 'llm' ? a.base_model : KIND_LABEL[k])}</span></div></div>
    <div class="v2-cb">${chips}<span class="v2-grow"></span>${act}</div></div>`;
}

function paint() {
  const el = $('#collection-body'); if (!el) return;
  const keep = el.querySelector('.v2-shelves')?.scrollTop || 0;
  const q = S.q.toLowerCase();
  const vis = S.items.filter((a) => { const k = kindOf(a); return (S.filter === 'all' ? (k === 'llm' || k === 'media') : k === S.filter) && (!q || (a.title || '').toLowerCase().includes(q) || a.file_name.toLowerCase().includes(q)); })
    .sort((x, y) => (Date.parse(S.recent[y.id] || 0) || 0) - (Date.parse(S.recent[x.id] || 0) || 0) || (S.fresh.has(y.id) - S.fresh.has(x.id)) || y.size_bytes - x.size_bytes);
  const shelves = [['ready', 'Prêts à lancer', 'sur le SSD rapide', vis.filter((a) => a.root_role === 'active')], ['store', 'En réserve', 'rangés sur les disques de stockage', vis.filter((a) => a.root_role === 'store')], ['other', 'Ailleurs', 'dossiers suivis par PAIZ', vis.filter((a) => a.root_role !== 'active' && a.root_role !== 'store')]].filter((s) => s[3].length);
  const counts = Object.fromEntries(FILTERS.map(([f]) => [f, S.items.filter((a) => { const k = kindOf(a); return f === 'all' ? (k === 'llm' || k === 'media') : k === f; }).length]));
  const qrow = S.quant?.running ? `<div class="v2-qrow"><b>Version légère de ${esc(S.quant.name)} (${esc(S.quant.target)}) en préparation</b><div class="v2-bar"><i style="width:${Number(S.quant.pct) || 0}%"></i></div><span class="v2-muted">${Number(S.quant.pct) || 0} % · elle apparaîtra ici en orange</span></div>` : '';
  el.innerHTML = `<div class="v2-coll">
    <div class="v2-ctools">
      <input class="v2-search" id="v2-q" type="search" placeholder="Chercher un modèle…" value="${esc(S.q)}" aria-label="Chercher un modèle">
      <div class="v2-filters">${FILTERS.map(([f, l]) => `<button class="v2-filt ${S.filter === f ? 'on' : ''}" data-f="${f}">${l} <span>${counts[f]}</span></button>`).join('')}<button class="v2-filt" id="v2-groups" title="Ranger ou rappeler d'un coup tous les modèles d'un projet">📦 Groupes</button></div>
    </div>
    <div class="v2-cmain">
      <div class="v2-shelves">${qrow}${shelves.map(([id, t, sub, list]) => { const n = S.more[id] ? list.length : Math.min(list.length, 36); return `<section class="v2-shelf"><h2>${t} <span>${list.length} · ${esc(sub)}</span></h2>
        <div class="v2-grid">${list.slice(0, n).map(card).join('')}</div>${list.length > n ? `<button class="v2-btn" data-more="${id}">Afficher les ${list.length - n} autres</button>` : ''}</section>`; }).join('') || '<div class="v2-empty"><b>Rien ici.</b> Change de filtre, ou ajoute un dossier dans Réglages › Dossiers suivis.</div>'}</div>
      <div class="v2-side"><aside class="v2-drawer" id="v2-drawer">${drawer()}</aside><div id="v2-moves">${movesHtml()}</div></div>
    </div></div>`;
  const sh = el.querySelector('.v2-shelves'); if (sh) sh.scrollTop = keep;
  bind(el);
}

// Déplacements en cours ou en file (Sortir / Ranger…) : barre de progression par transfert, mise à jour toutes les secondes.
let MV = { jobs: [], busy: false, seeded: false };
const DISMISS_KEY = 'paiz.moves.dismissed';
const dismissed = (() => { try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')); } catch { return new Set(); } })();
const saveDismissed = () => { try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissed].slice(-200))); } catch {} };
// Notification de fin : bandeau dans PAIZ, et notification du système si l'utilisateur l'a autorisée.
function notifyDone(j) {
  const name = String(j.label).replace(/^Déplacement de /, '').replace(/^Copie de /, '');
  const msg = j.status === 'done' ? `Déplacement terminé : ${name}` : j.status === 'cancelled' ? `Déplacement annulé : ${name}` : `Déplacement en échec : ${name}`;
  say(msg, j.status === 'done' ? '' : 'error');
  try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('PAIZ', { body: msg }); } catch {}
}
const MOVE_TYPES = new Set(['transfer', 'bulk-transfer', 'download']);
// débit et temps restant : calculés entre deux relevés (la barre de la copie repart de zéro pendant la vérification)
const SPD = new Map();
function speedOf(j) {
  const p = j.progress || {}; const now = Date.now(); const h = SPD.get(j.id) || { t: now, b: p.bytes || 0, ph: p.phase, mbs: 0 };
  if (h.ph !== p.phase) { h.t = now; h.b = p.bytes || 0; h.ph = p.phase; h.mbs = 0; }
  const dt = (now - h.t) / 1000;
  if (dt >= 3 && (p.bytes || 0) >= h.b) { const inst = ((p.bytes - h.b) / 1e6) / dt; h.mbs = h.mbs ? h.mbs * 0.6 + inst * 0.4 : inst; h.t = now; h.b = p.bytes; }
  SPD.set(j.id, h);
  if (!h.mbs || h.mbs < 0.1) return null;
  const left = p.totalBytes && p.bytes != null ? Math.max(0, p.totalBytes - p.bytes) / 1e6 / h.mbs : 0;
  return { mbs: Math.round(h.mbs), eta: left > 5 ? (left >= 5400 ? `${(left / 3600).toFixed(1).replace('.', ',')} h` : left >= 90 ? `${Math.round(left / 60)} min` : `${Math.round(left)} s`) : '' };
}
const mvBar = (p) => (p.totalBytes ? Math.min(100, Math.round((p.bytes / p.totalBytes) * 100)) : p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0);
function movesHtml() {
  const list = MV.jobs.filter((j) => MOVE_TYPES.has(j.type) && !dismissed.has(j.id)).slice(0, 8);
  if (!list.length) return '';
  const rows = list.map((j) => {
    const p = j.progress || {}; const run = j.status === 'running'; const pct = run ? mvBar(p) : 100;
    const sp = speedOf(j); const ver = p.phase === 'verify';
    const sub = run ? (p.total > 1 ? `${p.done || 0} / ${p.total} fichiers · ` : '') + (ver ? 'vérification de la copie (relecture du fichier) · ' : '') + (p.totalBytes ? `${go(p.bytes)} / ${go(p.totalBytes)}` : (p.phase === 'start' ? 'en attente de son tour…' : 'en cours…')) + (sp ? ` · ${sp.mbs} Mo/s${sp.eta ? ` · reste ≈ ${sp.eta}` : ''}` : '')
      : j.status === 'done' ? 'terminé' : j.status === 'cancelled' ? 'annulé' : `échec : ${esc(j.error || '')}`;
    return `<div class="v2-mv ${run ? '' : j.status}"><b>${esc(String(j.label).replace(/^Déplacement de /, '').replace(/^Copie de /, 'Copie : '))}</b>${j.type === 'download' ? '' : `<div class="v2-lane ${run ? (j.meta?.toRole === 'active' ? 'l' : 'r') : 'still'}" title="${j.meta?.toRole === 'active' ? 'Vers les prêts à lancer' : 'Vers la réserve'}"><em>Prêts</em><span class="v2-flow"></span><em>Réserve</em></div>`}<div class="v2-bar g"><i style="width:${pct}%"></i></div><span class="v2-muted">${run ? pct + ' % · ' : ''}${sub}</span>${run ? `<button class="v2-btn s" data-mvx="${esc(j.id)}">Annuler</button>` : `<button class="v2-x" data-mvd="${esc(j.id)}" title="Fermer" aria-label="Fermer">✕</button>`}</div>`;
  }).join('');
  return `<section class="v2-movebox"><h3>Déplacements</h3>${rows}${list.some((j) => j.status !== 'running') ? '<button class="v2-btn s" data-mvclear>Tout fermer</button>' : ''}</section>`;
}
async function pollMoves() {
  if (MV.busy) return;
  if (!document.querySelector('#view-collection.active') && MV.jobs.some((j) => j.status === 'running') === false && MV.seeded) return; // ailleurs : on ne suit que les déplacements en cours
  MV.busy = true;
  try {
    const was = new Set(MV.jobs.filter((j) => j.status === 'running').map((j) => j.id));
    MV.jobs = (await call('/api/jobs')).jobs || [];
    if (!MV.seeded) { // au premier passage, ce qui était déjà fini avant l'ouverture n'est pas re-notifié
      MV.seeded = true; for (const j of MV.jobs) if (MOVE_TYPES.has(j.type) && j.status !== 'running') dismissed.add(j.id); saveDismissed();
      try { if (typeof Notification !== 'undefined' && Notification.permission === 'default' && MV.jobs.some((j) => j.status === 'running' && MOVE_TYPES.has(j.type))) Notification.requestPermission(); } catch {}
    }
    for (const j of MV.jobs) if (MOVE_TYPES.has(j.type) && was.has(j.id) && j.status !== 'running') notifyDone(j);
    const el = $('#v2-moves'); if (el) { el.innerHTML = movesHtml();
      el.querySelectorAll('[data-mvd]').forEach((b) => { b.onclick = () => { dismissed.add(b.dataset.mvd); saveDismissed(); el.innerHTML = movesHtml(); pollMoves(); }; });
      el.querySelector('[data-mvclear]')?.addEventListener('click', () => { MV.jobs.filter((j) => j.status !== 'running').forEach((j) => dismissed.add(j.id)); saveDismissed(); pollMoves(); });
      el.querySelectorAll('[data-mvx]').forEach((b) => { b.onclick = () => call(`/api/jobs/${b.dataset.mvx}/cancel`, 'POST').catch((e) => say(e.message, 'error')); }); }
    if (MV.jobs.some((j) => was.has(j.id) && j.status !== 'running') && document.querySelector('#view-collection.active')) load(); // un transfert vient de finir : la collection se met à jour
  } catch {} finally { MV.busy = false; }
}
setInterval(pollMoves, 1000);

function drawer() {
  const a = S.items.find((x) => x.id === S.sel);
  if (!a) return '<div class="v2-empty"><b>Choisis un modèle</b>Sa fiche s’ouvre ici : infos, utilisation, modèles liés, version légère.</div>';
  const k = kindOf(a); const ready = a.root_role === 'active'; const u = S.usage[a.id];
  const tabs = [['infos', 'Infos'], ['use', 'Utilisation'], ['linked', 'Liés'], ...(k === 'llm' ? [['light', 'Alléger']] : [])];
  if (!tabs.some(([t]) => t === S.tab)) S.tab = 'infos';
  const dir = a.abs_path.slice(0, a.abs_path.length - a.file_name.length).replace(/[\\/]$/, '');
  let body = '';
  const roleBox = () => {
    if (k !== 'acc') return '';
    const r = S.rel[a.id];
    if (!r) { call(`/api/assets/${a.id}/related`).then((x) => { S.rel[a.id] = x; paintDrawer(); }).catch(() => { S.rel[a.id] = { uses: [], usedBy: [], same: [] }; }); return ''; }
    const ro = r.role;
    if (!ro) return `<div class="v2-role unk"><b>À quoi il sert : PAIZ ne sait pas</b><span class="v2-muted">Nom non reconnu. Vérifie dans SwarmUI / ComfyUI avant de le supprimer.</span></div>`;
    return `<div class="v2-role ${ro.orphan ? 'orphan' : 'ok'}"><b>${esc(ro.role)}</b><span class="v2-muted">Sert à : ${esc(ro.who)}</span>`
      + (ro.orphan ? `<span class="v2-verdict">Aucun modèle de ce type sur tes disques : tu peux le mettre à la corbeille sans risque (il reste récupérable).</span>`
        : `<span class="v2-muted">Nécessaire pour ${ro.mains.length} modèle(s) présent(s) :</span>${ro.mains.map((x) => `<button class="v2-li link" data-open="${x.id}"><span>${esc(x.name)}</span><span class="v2-chip">${go(x.size)}</span></button>`).join('')}<span class="v2-muted">À garder tant que tu utilises l’un d’eux.</span>`)
      + `</div>`;
  };
  if (S.tab === 'infos') {
    const src = u?.source;
    body = `<dl class="v2-kv"><dt>Taille</dt><dd>${go(a.size_bytes)}${k === 'llm' && quantOf(a.file_name) ? ` · ${esc(quantOf(a.file_name))}` : ''}</dd>
      <dt>Rangé</dt><dd>${ready ? 'prêt à lancer' : a.root_role === 'store' ? 'en réserve' : 'ailleurs'} · ${esc(a.root_name || '')}</dd>
      <dt>Type</dt><dd>${esc(KIND_LABEL[k])}${a.base_model ? ` · ${esc(a.base_model)}` : ''}</dd>
      ${k === 'llm' && S.moe[a.id] ? `<dt>Streaming</dt><dd>${S.moe[a.id].moe ? `oui : MoE, ${S.moe[a.id].used || '?'} experts sur ${S.moe[a.id].experts || '?'} par mot` : 'non : modèle dense (tous ses poids servent à chaque mot)'}</dd>` : ''}
      <dt>Origine</dt><dd>${src ? esc(src.how || src.repo || 'inconnue') + (src.downloadedAt ? ` · ${day(src.downloadedAt)}` : '') : 'inconnue'}</dd>
      <dt>Fichier</dt><dd class="v2-path" title="${esc(a.abs_path)}">${esc(a.file_name)}<br><span>${esc(dir)}</span></dd></dl>`;
  } else if (S.tab === 'use') {
    body = u?.uses ? `<div class="v2-big">${u.uses} fois</div><div class="v2-muted">Dernière fois ${day(u.lastUse)}.</div>${(u.programs || []).map((p) => `<div class="v2-li"><span>${esc(p.name)}</span><span class="v2-chip">${p.n} fois</span></div>`).join('')}`
      : '<div class="v2-big">Jamais</div><div class="v2-muted">PAIZ ne l’a jamais lancé. Il sert peut-être à une autre appli (SwarmUI, ComfyUI…), que PAIZ ne voit pas.</div>';
  } else if (S.tab === 'linked') {
    const r = S.rel[a.id];
    if (!r) { call(`/api/assets/${a.id}/related`).then((x) => { S.rel[a.id] = x; paintDrawer(); }).catch(() => { S.rel[a.id] = { uses: [], usedBy: [], same: [] }; paintDrawer(); }); body = '<div class="v2-muted">Recherche…</div>'; } else {
      const li = (x) => `<button class="v2-li link" data-open="${x.id}"><span>${esc(x.name)}</span><span class="v2-chip">${go(x.size)}</span></button>`;
      body = (r.usedBy.length ? `<div class="v2-lbl">Utilisé par</div>${r.usedBy.slice(0, 12).map(li).join('')}` : '') + (r.uses.length ? `<div class="v2-lbl">Utilise</div>${r.uses.map(li).join('')}` : '')
        + (r.same.length ? `<div class="v2-lbl">Même fichier ailleurs</div>${r.same.map((x) => `<div class="v2-li"><span class="v2-path">${esc(x.path)}</span><span class="v2-chip ${x.linked ? 'go' : ''}">${x.linked ? 'fusionné' : 'copie'}</span></div>`).join('')}` : '')
        || '<div class="v2-muted">Aucun modèle lié repéré d’après les noms de fichiers.</div>';
    }
  } else if (S.tab === 'light') {
    const o = S.opts[a.id];
    if (!o) { call(`/api/quantize/options?assetId=${a.id}`).then((x) => { S.opts[a.id] = x; paintDrawer(); }).catch((e) => { S.opts[a.id] = { ok: false, reason: e.message }; paintDrawer(); }); body = '<div class="v2-muted">…</div>'; }
    else if (!o.ok) body = `<div class="v2-muted">${esc(o.reason)}</div>`;
    else {
      if (!S.qpick || !o.levels.some((l) => l.q === S.qpick)) S.qpick = (o.levels.find((l) => l.risk === 1) || o.levels[0]).q;
      body = `<div class="v2-muted">Crée une copie plus petite et plus rapide, à côté de l’original (qui ne bouge pas). Plus c’est léger, moins c’est fiable.</div>
        ${o.levels.map((l) => `<button class="v2-lvl r${l.risk} ${S.qpick === l.q ? 'on' : ''}" data-ql="${l.q}"><b>${esc(l.label)}</b><span>≈ ${go(l.estimateBytes)} · ${esc(l.note)}</span>${l.warn ? `<em>${esc(l.warn)}</em>` : ''}</button>`).join('')}
        ${S.quant?.running ? '<div class="v2-muted">Une version légère est déjà en préparation.</div>' : '<button class="v2-btn p" id="v2-qgo">Créer la version légère</button>'}`;
    }
  }
  const main = k === 'llm' && ready ? `<button class="v2-btn p" data-run="${a.id}">Lancer</button>` : !ready ? `<button class="v2-btn p" data-out="${a.id}">Sortir</button>` : '';
  return `<div class="v2-dh">${famBadge(nice(a))}<h2>${esc(nice(a))}</h2></div>
    <div class="v2-dtabs">${tabs.map(([t, l]) => `<button class="${S.tab === t ? 'on' : ''}" data-tab="${t}">${l}</button>`).join('')}</div>
    <div class="v2-dbody">${S.tab === 'infos' || S.tab === 'linked' ? roleBox() : ''}${body}</div>
    <div class="v2-dact">${main}${ready ? `<button class="v2-btn" data-store="${a.id}">Ranger</button>` : ''}<button class="v2-btn ghost" data-trash="${a.id}">Corbeille</button></div>`;
}
function paintDrawer() { const d = $('#v2-drawer'); if (!d) return; d.innerHTML = drawer(); bind(d); }

function bind(root) {
  root.querySelector('#v2-q')?.addEventListener('input', (e) => { S.q = e.target.value; clearTimeout(bind.t); bind.t = setTimeout(() => { paint(); const i = $('#v2-q'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 200); });
  root.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { S.filter = b.dataset.f; paint(); }; });
  root.querySelector('#v2-groups')?.addEventListener('click', () => { import('/groups.js').then((m) => m.groupsDialog(() => load())); });
  root.querySelectorAll('[data-more]').forEach((b) => { b.onclick = () => { S.more[b.dataset.more] = true; paint(); }; });
  root.querySelectorAll('.v2-card').forEach((c) => {
    const open = () => { const id = Number(c.dataset.id); S.sel = id; if (S.fresh.has(id)) { S.fresh.delete(id); call('/api/quantize/seen', 'POST', { id }).catch(() => {}); } paint(); };
    c.onclick = (e) => { if (!e.target.closest('button')) open(); };
    c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
  root.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { S.tab = b.dataset.tab; paintDrawer(); }; });
  root.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => { S.sel = Number(b.dataset.open); S.tab = 'infos'; paint(); }; });
  root.querySelectorAll('[data-ql]').forEach((b) => { b.onclick = () => { S.qpick = b.dataset.ql; paintDrawer(); }; });
  root.querySelector('#v2-qgo')?.addEventListener('click', async () => {
    try { await call('/api/quantize/start', 'POST', { assetId: S.sel, target: S.qpick, confirm: true }); say('Version légère en préparation : elle apparaîtra dans la collection.'); } catch (e) { say(e.message, 'error'); }
    load();
  });
  root.querySelectorAll('[data-run]').forEach((b) => { b.onclick = async (e) => {
    e.stopPropagation(); const a = S.items.find((x) => x.id === Number(b.dataset.run)); if (!a) return;
    const prof = isLossy(a.file_name) ? 'extralight' : (S.eng?.current?.profile && S.eng.current.profile !== 'extralight' ? S.eng.current.profile : S.eng?.defaultProfile || 'normal');
    try { await call('/api/engine/summon', 'POST', { assetId: a.id, profile: prof, activeRoot: a.root_id }); say(`${nice(a)} se lance.`); window.paizV2?.poll(); } catch (er) { say(er.message, 'error'); }
    setTimeout(load, 1200);
  }; });
  const mv = (role) => (b) => { b.onclick = (e) => { e.stopPropagation(); const a = S.items.find((x) => x.id === Number(b.dataset[role === 'active' ? 'out' : 'store'])); if (a) moveFlow({ id: a.id, name: nice(a), size: a.size_bytes, role, onDone: () => setTimeout(load, 1500) }); }; };
  root.querySelectorAll('[data-out]').forEach(mv('active'));
  root.querySelectorAll('[data-store]').forEach(mv('store'));
  root.querySelectorAll('[data-trash]').forEach((b) => { b.onclick = async () => {
    const a = S.items.find((x) => x.id === Number(b.dataset.trash)); if (!a || !confirm(`Mettre « ${nice(a)} » à la corbeille ?\nIl reste récupérable depuis la corbeille.`)) return;
    try { await call('/api/jobs/trash', 'POST', { assetIds: [a.id], permanent: false }); say('Mis à la corbeille.'); S.sel = null; } catch (e) { say(e.message, 'error'); }
    setTimeout(load, 1200);
  }; });
}

window.addEventListener('paiz:v2-select', (e) => { S.sel = Number(e.detail); S.tab = 'infos'; });
document.addEventListener('click', (e) => { if (e.target.closest('#tabs .tab[data-view="collection"]')) setTimeout(load, 0); });
if (document.querySelector('#view-collection.active')) load();
