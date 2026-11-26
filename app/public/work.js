// Écran « Travail » : sessions OpenCode rangées par dossier, discussion en direct (SSE), contrôles pause / stop / modèle, progression.
// Tout passe par PAIZ : /oc/* = API d'OpenCode (authentification injectée côté serveur), /api/work/* = contrôle du relais et du moteur.
import { modeControlsHtml, wireModeControls, locate } from '/modes.js';
import { initTasksBar } from '/tasksbar.js';
import { initMemory } from '/memory.js';
import { mountToolBudget, chooseToolProfile } from '/toolbudget.js';
import { blip, blipSettings, setBlipSettings, VOICES, stopBlips, voiceKeyFor, setVoiceFor } from '/blips.js';
// Une image jointe est ramenée à 1024 px sur son plus grand côté (JPEG) : un modèle de vision la découpe en morceaux,
// plus elle est grande, plus il en a à lire — sur processeur, c'est le gros du temps de l'œil.
const SHRINK_PX = 1024;
function shrink(uri) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const k = Math.min(1, SHRINK_PX / Math.max(im.naturalWidth, im.naturalHeight));
      if (k >= 1 && uri.length < 1.5e6) { resolve(uri); return; }
      const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      try { resolve(c.toDataURL('image/jpeg', 0.9)); } catch { resolve(uri); }
    };
    im.onerror = () => resolve(uri);
    im.src = uri;
  });
}
// ---- visage du caractère : 6 jeux de 4 expressions (public/v2/faces), choix gardé par caractère dans ce navigateur
const FACES = [['assistant', 'Le moustachu'], ['leo', 'Léo'], ['lea', 'Léa'], ['hal', 'HAL'], ['blip', 'BLIP'], ['blup', 'BLUP']];
const FACE_LOCKED = {}; // aucun visage imposé : tête, voix et personnalité sont associées à titre indicatif, tout se change
const FACE_DEFAULT = { leo: 'leo', lea: 'lea', hal: 'hal', concis: 'assistant' };
const faceMap = () => { try { return JSON.parse(localStorage.getItem('paiz.faces') || '{}') || {}; } catch { return {}; } };
const faceOf = (id) => {
  if (FACE_LOCKED[id]) return FACE_LOCKED[id];
  const m = faceMap(); if (m[id]) return m[id];
  if (id === 'assistant') { const f = Math.random() < 0.5 ? 'blip' : 'blup'; setFace(id, f); return f; } // tiré au hasard une fois, puis gardé
  return FACE_DEFAULT[id] || 'blip';
};
function setFace(id, f) { try { localStorage.setItem('paiz.faces', JSON.stringify({ ...faceMap(), [id]: f })); } catch { /* stockage indisponible */ } }
let faceExpr = 'normal'; let faceTimer = null;
function paintFace() { const i = document.getElementById('w-face-img'); if (i) i.src = `/v2/faces/${faceOf(S.per?.active || 'assistant')}-${faceExpr}.webp`; }
function mood(expr, ms = 4000) { faceExpr = expr; paintFace(); clearTimeout(faceTimer); faceTimer = setTimeout(() => { faceExpr = 'normal'; paintFace(); }, ms); }
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const root = $('#work-body');
if (!root) throw new Error('work: conteneur absent');

async function call(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || d.message || `${r.status}`);
  return d;
}
function say(msg, kind = '') {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg;
  $('#toasts')?.appendChild(el); setTimeout(() => el.remove(), 5000);
}
const copyText = async (t) => { try { await navigator.clipboard.writeText(t); say('Copié.'); } catch { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); say('Copié.'); } };
const mmss = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const base = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

// Projets (dossiers) connus de l'écran : mémorisés pour apparaître dans la liste même sans session.
const normDir = (d) => String(d || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const loadProjects = () => { try { const a = JSON.parse(localStorage.getItem('paiz.projects') || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch { return []; } };
// Les projets et la corbeille sont gardés dans la base de PAIZ (le navigateur n'en garde qu'une copie de secours) : ils survivent à une réinstallation.
let projLoaded = false;
const syncServer = () => { if (projLoaded) call('/api/work/projects', 'PUT', { projects: S.projects, trash: S.trash }).catch(() => {}); };
const saveProjects = (a) => { try { localStorage.setItem('paiz.projects', JSON.stringify(a)); } catch { /* ignore */ } syncServer(); };
const S = {
  ready: false, sessions: [], cur: null, folder: '', msgs: [], busy: false, execStart: 0, lastOutcome: null,
  st: null, stick: true, es: null, newDir: false,
  projects: loadProjects(), starting: false, startErr: '', startSig: '',
  files: [], timings: [], queue: {}, qOpen: false, hidden: new Set(), ctlSig: '', per: null,
  trash: [], trashOpen: false,
  test: { chat: [], sending: false, max: 1200, temp: 0.7, sig: '' },
  tabsBy: {}, tab: 'chat', headSig: '',
};
// Corbeille des projets : un projet jeté disparaît de la liste (avec ses conversations) mais reste restaurable 7 jours.
// Rien n'est jamais supprimé sur le disque : le dossier du projet n'est pas touché, seules les conversations OpenCode le sont.
const WEEK = 7 * 24 * 3600 * 1000;
const QKEY = 'paiz.queue';
const loadQueue = () => { try { const o = JSON.parse(localStorage.getItem(QKEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const saveQueue = () => { try { localStorage.setItem(QKEY, JSON.stringify(S.queue)); } catch { /* trop gros : la file reste en mémoire */ } };
S.queue = loadQueue();
const loadTrash = () => { try { const a = JSON.parse(localStorage.getItem('paiz.trash') || '[]'); return Array.isArray(a) ? a.filter((x) => x && typeof x.dir === 'string') : []; } catch { return []; } };
const saveTrash = () => { try { localStorage.setItem('paiz.trash', JSON.stringify(S.trash)); } catch { /* ignore */ } syncServer(); };
S.trash = loadTrash();
const inTrash = (d) => S.trash.some((t) => !t.sid && normDir(t.dir) === normDir(d));
const sessTrashed = (id) => S.trash.some((t) => t.sid === id);
const HKEY = 'paiz.hidden';
const loadHidden = (sid) => { try { return new Set((JSON.parse(localStorage.getItem(HKEY) || '{}')[sid]) || []); } catch { return new Set(); } };
const saveHidden = () => { try { const all = JSON.parse(localStorage.getItem(HKEY) || '{}'); all[S.cur] = [...S.hidden].slice(-300); localStorage.setItem(HKEY, JSON.stringify(all)); } catch { /* ignore */ } };

// ------------------------------------------------------------------ modèle de messages
function fromApi(m) {
  if (m.type === 'user') return { id: m.id, role: 'user', parts: [{ k: 'text', text: m.text || '' }], done: true, nfiles: (m.files || m.payload?.files || []).length };
  if (m.type === 'assistant') {
    const parts = (m.content || []).map((c) => {
      if (c.type === 'text') return { k: 'text', text: c.text };
      if (c.type === 'tool') return { k: 'tool', id: c.id, name: c.name, input: c.state?.input, status: c.state?.status === 'completed' ? 'ok' : c.state?.status === 'error' ? 'err' : 'run', out: c.state?.content?.map((x) => x.text).join('\n') || c.state?.error?.message || '' };
      return null;
    }).filter(Boolean);
    return { id: m.id, role: 'assistant', parts, done: !!m.time?.completed, error: m.error?.message, t0: m.time?.created || 0, t1: m.time?.completed || 0, model: String(m.model?.id || m.modelID || m.model?.modelID || (typeof m.model === 'string' ? m.model : '') || '') };
  }
  return null;
}
async function loadMessages() {
  if (!S.cur) return;
  const id = S.cur;
  const all = []; let cursor = '';
  for (let i = 0; i < 25; i++) {
    const r = await call(`/oc/session/${id}/message?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&order=asc'}`);
    all.push(...(r.data || []));
    cursor = r.cursor?.next; if (!cursor || !(r.data || []).length) break;
  }
  if (S.cur !== id) return;
  if (!S.hiddenFor || S.hiddenFor !== id) { S.hidden = loadHidden(id); S.hiddenFor = id; }
  S.msgs = all.map(fromApi).filter(Boolean);
  const idle = [...all].reverse().find((m) => m.type === 'idle');
  S.lastOutcome = idle?.outcome || null;
  renderChat(true);
}
const asst = (id) => S.msgs.find((m) => m.id === id) || (() => { const m = { id, role: 'assistant', parts: [], done: false }; S.msgs.push(m); return m; })();

function onEvent(ev) {
  const d = ev.data || {};
  if (/^session\.(created|renamed|deleted|archived|unarchived|moved)$/.test(ev.type)) { refreshSessions(); return; }
  if (d.sessionID !== S.cur) return;
  switch (ev.type) {
    case 'session.execution.started': S.busy = true; S.execStart = Date.now(); S.lastOutcome = null; renderControls(); break;
    case 'session.execution.succeeded': case 'session.execution.failed': case 'session.execution.interrupted':
      S.busy = false; S.lastOutcome = ev.type.split('.').pop(); mood(S.lastOutcome === 'succeeded' ? 'souriant' : 'mecontent'); renderControls(); loadMessages(); refreshSessions(); renderQueue();
      if (S.lastOutcome === 'succeeded' && (S.queue[S.cur] || []).length) setTimeout(flushQueue, 400); break;
    case 'session.step.started': { const m = asst(d.assistantMessageID); m.t0 ||= Date.now(); renderChat(); break; }
    case 'session.text.started': { const m = asst(d.assistantMessageID); m.parts.push({ k: 'text', text: '', ord: d.ordinal }); renderChat(); break; }
    case 'session.text.delta': { const m = asst(d.assistantMessageID); let p = m.parts.findLast((x) => x.k === 'text' && x.ord === d.ordinal); if (!p) { p = { k: 'text', text: '', ord: d.ordinal }; m.parts.push(p); } p.text += d.delta; renderChat(); break; }
    case 'session.text.ended': { const m = asst(d.assistantMessageID); const p = m.parts.findLast((x) => x.k === 'text' && x.ord === d.ordinal); if (p && d.text != null) p.text = d.text; renderChat(); break; }
    case 'session.tool.input.started': asst(d.assistantMessageID).parts.push({ k: 'tool', id: d.id, name: d.name, status: 'run', input: null, out: '' }); renderChat(); break;
    case 'session.tool.called': { const t = asst(d.assistantMessageID).parts.find((x) => x.k === 'tool' && x.id === d.id); if (t) t.input = d.input; renderChat(); break; }
    case 'session.tool.success': { const t = asst(d.assistantMessageID).parts.find((x) => x.k === 'tool' && x.id === d.id); if (t) { t.status = 'ok'; t.out = (d.content || []).map((x) => x.text).join('\n'); } renderChat(); break; }
    case 'session.tool.failed': { const t = asst(d.assistantMessageID).parts.find((x) => x.k === 'tool' && x.id === d.id); if (t) { t.status = 'err'; t.out = d.error?.message || ''; } renderChat(); break; }
    case 'session.step.ended': case 'session.step.failed': { const m = asst(d.assistantMessageID); m.done = true; m.t1 ||= Date.now(); if (ev.type.endsWith('failed')) m.error = d.error?.message; renderChat(); break; }
    default: break;
  }
}
function openStream() {
  if (S.es) S.es.close();
  const es = new EventSource('/oc/event');
  es.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch { /* battement de cœur */ } };
  es.onopen = () => { if (S.cur) loadMessages().catch(() => {}); };
  S.es = es;
}

// ------------------------------------------------------------------ rendu
function frame() {
  root.innerHTML = `<div class="work">
    <aside class="work-side">
      <button class="btn primary big" id="w-new">＋ Nouveau projet</button>
      <div id="w-newbox" class="w-newbox hidden"><input class="input" id="w-dir" placeholder="Dossier, ex. D:/005-GIT/mon-projet"><button class="btn" id="w-browse" title="Parcourir les dossiers">📁 Parcourir…</button><button class="btn primary" id="w-dirok">Créer</button></div>
      <button class="btn w-testbtn" id="w-testbtn" title="Discuter avec le modèle chargé, sans projet ni session">🧪 Test</button>
      <div id="w-list" class="w-list"></div>
      <div id="w-tasks" class="w-tasks"></div>
      <div id="w-trash" class="w-trash"></div>
      <button class="btn ghost w-archbtn" id="w-archbtn" title="Tous les projets et conversations, où ils sont">🗄 Archive</button>
    </aside>
    <section class="work-main">
      <div class="work-head" id="w-head"></div>
      <div class="work-chat-wrap" id="w-wrap"><button class="w-face" id="w-face" title="Caractère du modèle : changer de caractère ou de visage"><img id="w-face-img" alt=""></button><button class="btn small w-todo" id="w-todo" title="Bloc-notes du projet : les idées à ne pas oublier">📝 To-do</button><button class="btn small w-todo w-memb" id="w-mem" title="Mémoire : ce que les assistants retiennent du projet et de toi">🧠 Mémoire</button><button class="btn small w-todo w-tbb" id="w-tbbtn" title="Outils de l'agent : profils d'usage (discussion, code, recherche…) et allègement du prompt">⚖ Outils</button><div class="work-chat" id="w-chat"></div><div class="w-prev hidden" id="w-prev"></div><div class="w-start hidden" id="w-start"></div><div class="w-test hidden" id="w-test"></div><div class="w-hint hidden" id="w-hint">Sélectionne un projet et une session.</div><button class="btn primary w-down hidden" id="w-down">↓ nouveau texte</button></div>
      <div class="w-planbar hidden" id="w-planbar"></div>
      <div class="work-bar" id="w-bar"></div>
      <div class="work-controls" id="w-controls"></div>
      <div class="work-compose"><div class="w-cbox" id="w-drop"><div class="w-q" id="w-q"></div><div class="w-thumbs" id="w-thumbs"></div><textarea class="input" id="w-text" rows="2" placeholder="Message… (glisse des images ici, ou colle-les)"></textarea><div class="w-cbar"><button class="btn small" id="w-img" title="Joindre des images">🖼 Image</button><button class="btn small" id="w-qtask" title="Mettre ce texte dans la file des tâches du gros modèle local au lieu de le poser dans la discussion">📋 En tâche</button><button class="btn small" id="w-qplan" title="Faire rédiger un plan par un modèle à partir de cette discussion (il arrive en brouillon dans la barre des tâches)">🗺 Plan</button><input type="file" id="w-file" accept="image/*" multiple hidden><span class="muted small">Entrée = envoyer · Maj+Entrée = nouvelle ligne</span></div></div><button class="btn primary big" id="w-send">Envoyer</button></div>
    </section>
    <div class="care-modal hidden" id="w-del"><div class="care-box"><button class="w-x" id="w-del-x" title="Annuler">✕</button><h2 id="w-del-h"></h2><p class="muted small" id="w-del-p"></p><div class="toolbar" style="justify-content:flex-end;margin-top:16px"><button class="btn big" id="w-del-trash">🗑 Jeter dans la corbeille</button><button class="btn danger big" id="w-del-erase">Effacer</button></div></div></div>
    <div class="care-modal hidden" id="w-per"><div class="care-box w-perbox"><button class="w-x" id="w-per-x" title="Fermer">✕</button><h2>Caractère du modèle</h2>
      <p class="muted small">Un pré-prompt ajouté aux consignes envoyées au modèle, pour toutes les conversations de l'écran Travail, dès le prochain message. Changer le texte fait relire le prompt une fois (un peu plus long).</p>
      <label class="w-sel">Profil <select id="w-per-sel"></select></label>
      <div class="w-faces" id="w-faces">${FACES.map(([f, l]) => `<button class="w-facepick" data-face="${f}" title="${l}"><img src="/v2/faces/${f}-normal.webp" alt=""><span>${l}</span></button>`).join('')}</div>
      <div class="toolbar" style="gap:16px;margin:6px 0"><label class="check" title="Le modèle peut mettre des émojis dans ses réponses"><input type="checkbox" id="w-per-emoji"> Émojis</label><label class="check" title="Une phrase courte lui dit qu’il tourne en local dans PAIZ, sur ta machine"><input type="checkbox" id="w-per-aware"> Sait qu’il tourne dans PAIZ</label><label class="check" title="Autorise le jeu de rôle romantique ou érotique entre adultes, si tu le demandes clairement (tous les caractères)"><input type="checkbox" id="w-per-nsfw"> NSFW</label><label class="check" title="Le modèle connaît l’heure et le jour, remarque une absence ou une longue séance (une ligne courte, ajoutée à la fin de ton message)"><input type="checkbox" id="w-per-time"> Notion du temps</label></div>
      <div class="toolbar" style="gap:12px;margin:0 0 6px"><label class="check" title="Chaque lettre qui s’affiche fait un petit son, comme dans les dialogues des vieux jeux vidéo"><input type="checkbox" id="w-blip-on"> Sons de dialogue</label><label class="w-sel">Voix <select id="w-blip-voice">${Object.entries(VOICES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></label><button class="btn small" id="w-blip-try">Écouter</button></div>
      <input class="input" id="w-per-name" placeholder="Nom du profil">
      <textarea class="input" id="w-per-text" rows="9" placeholder="Ex. : Tu es un relecteur de code sévère mais bienveillant…"></textarea>
      <div class="toolbar" style="margin-top:10px"><button class="btn danger" id="w-per-del">Supprimer</button><span class="grow"></span><button class="btn" id="w-per-new">Nouveau profil</button><button class="btn primary" id="w-per-apply">Enregistrer et appliquer</button></div></div></div>
    <div class="care-modal hidden" id="w-tb"><div class="care-box w-tbbox"><button class="w-x" id="w-tb-x" title="Fermer">✕</button><div id="w-tb-body"></div></div></div>
    <div class="care-modal hidden" id="w-arch"><div class="care-box w-archbox"><button class="w-x" id="w-arch-x" title="Fermer">✕</button><h2>🗄 Archive des projets</h2><div id="w-arch-body"></div></div></div>
    <div class="care-modal hidden" id="w-modal"><div class="care-box"><h2>Interrompre les opérations ?</h2><div class="toolbar" style="justify-content:flex-end;margin-top:16px"><button class="btn big" id="w-no">Annuler</button><button class="btn danger big" id="w-yes">■ Interrompre</button></div></div></div>
  </div>`;
  $('#w-new').onclick = () => { $('#w-newbox').classList.toggle('hidden'); $('#w-dir').value ||= localStorage.getItem('paiz.workdir') || ''; $('#w-dir').focus(); };
  $('#w-dirok').onclick = () => startProject($('#w-dir').value.trim());
  $('#w-testbtn').onclick = openTest;
  $('#w-archbtn').onclick = openArchive;
  $('#w-tbbtn').onclick = () => { $('#w-tb').classList.remove('hidden'); mountToolBudget($('#w-tb-body')); };
  $('#w-tb-x').onclick = () => $('#w-tb').classList.add('hidden');
  $('#w-arch-x').onclick = () => $('#w-arch').classList.add('hidden');
  $('#w-browse').onclick = async () => {
    const b = $('#w-browse'); b.disabled = true;
    try { const d = await call('/api/pick-folder', 'POST', { start: $('#w-dir').value.trim() }); if (d.path) { $('#w-dir').value = d.path; startProject(d.path); } }
    catch (e) { say(e.message, 'error'); } finally { b.disabled = false; }
  };
  $('#w-dir').onkeydown = (e) => { if (e.key === 'Enter') $('#w-dirok').click(); };
  $('#w-send').onclick = send;
  const addFiles = (list) => {
    for (const f of [...list]) {
      if (!/^image\//.test(f.type)) { say(`« ${f.name} » n'est pas une image.`, 'error'); continue; }
      if (f.size > 12 * 1024 * 1024) { say(`« ${f.name} » dépasse 12 Mo.`, 'error'); continue; }
      const fr = new FileReader(); fr.onload = async () => { S.files.push({ name: f.name || 'image', uri: await shrink(String(fr.result)) }); renderThumbs(); }; fr.readAsDataURL(f);
    }
  };
  $('#w-img').onclick = () => $('#w-file').click();
  $('#w-file').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  const drop = $('#w-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
  $('#w-text').addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type)); if (fs.length) { e.preventDefault(); addFiles(fs); } });
  $('#w-thumbs').addEventListener('click', (e) => { const b = e.target.closest('[data-rmf]'); if (b) { S.files.splice(Number(b.dataset.rmf), 1); renderThumbs(); } });
  $('#w-text').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  const chat = $('#w-chat');
  chat.addEventListener('scroll', () => {
    if (Date.now() - (S.progAt || 0) < 250) return; // défilement déclenché par PAIZ : ne change pas l'intention de l'utilisateur
    S.stick = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 28;
    if (S.stick) $('#w-down').classList.add('hidden');
  });
  $('#w-down').onclick = () => { S.stick = true; S.progAt = Date.now(); chat.scrollTop = chat.scrollHeight; $('#w-down').classList.add('hidden'); };
  chat.addEventListener('click', (e) => {
    const x = e.target.closest('[data-act="hide"]');
    if (x) { const hm = S.msgs.find((q) => q.id === x.closest('.w-msg').dataset.id); if (S.hiddenFor !== S.cur) { S.hidden = loadHidden(S.cur); S.hiddenFor = S.cur; } if (hm?.hkey) { S.hidden.add(hm.hkey); saveHidden(); } S.rendered = []; renderChat(true); return; }
    const mk = e.target.closest('[data-mktask]'); if (mk) { const mm = S.msgs.find((q) => q.id === mk.closest('.w-msg').dataset.id); const t = mm && taskBlocks(mm)[Number(mk.dataset.mktask)]; if (t) { mk.disabled = true; call('/api/tasks', 'POST', { title: t.title, spec: t.spec, draft: true, source: 'chat', project: sessionDir() || '' }).then(() => { say('Brouillon créé dans la barre des tâches : relis-le avant de le lancer.'); TB?.pollTasks?.(); mk.textContent = '✔ Brouillon créé'; }).catch((er) => { say(er.message, 'error'); mk.disabled = false; }); } return; }
    const rb = e.target.closest('[data-run]'); if (rb) { const rm = S.msgs.find((q) => q.id === rb.closest('.w-msg').dataset.id); const t = rm && runnables(rm)[Number(rb.dataset.run)]; if (t) runFile(t.file); return; }
    const pb = e.target.closest('[data-prev]'); if (pb) { const pm = S.msgs.find((q) => q.id === pb.closest('.w-msg').dataset.id); if (pm) openPreview(pm, Number(pb.dataset.prev)); return; }
    const b = e.target.closest('[data-copy]'); if (!b) return;
    copyText(b.dataset.copy === 'msg' ? S.msgs.find((m) => m.id === b.closest('.w-msg').dataset.id)?.parts.filter((p) => p.k === 'text').map((p) => p.text).join('\n\n') || '' : b.closest('.w-para').dataset.raw);
  });
  $('#w-per-x').onclick = () => $('#w-per').classList.add('hidden');
  $('#w-per-sel').onchange = (e) => { fillPersona(e.target.value); markFace(); };
  const markFace = () => { const id = $('#w-per-sel').value || S.per?.active; const f = faceOf(id); const locked = !!FACE_LOCKED[id]; document.querySelectorAll('.w-facepick').forEach((b) => { b.classList.toggle('on', b.dataset.face === f); b.disabled = locked && b.dataset.face !== f; b.title = locked ? 'Ce caractère garde son visage' : b.dataset.face; }); const vs = $('#w-blip-voice'); if (vs) vs.value = voiceKeyFor(id); };
  document.querySelectorAll('.w-facepick').forEach((b) => { b.onclick = () => { const id = $('#w-per-sel').value || S.per?.active; if (!id || FACE_LOCKED[id]) return; setFace(id, b.dataset.face); markFace(); paintFace(); }; });
  S.markFace = markFace;
  const perOpt = (k) => async (e) => { try { S.per = await call('/api/work/persona', 'POST', { opts: { [k]: e.target.checked } }); say('Réglage du caractère enregistré (pris en compte au prochain message).'); } catch (er) { say(er.message, 'error'); } };
  $('#w-per-emoji').onchange = perOpt('emoji'); $('#w-per-aware').onchange = perOpt('aware'); $('#w-per-nsfw').onchange = perOpt('nsfw'); $('#w-per-time').onchange = perOpt('time');
  { const b = blipSettings(); $('#w-blip-on').checked = b.on; $('#w-blip-voice').value = voiceKeyFor($('#w-per-sel')?.value || S.per?.active); }
  $('#w-blip-on').onchange = (e) => { setBlipSettings({ on: e.target.checked }); if (!e.target.checked) stopBlips(); renderHead(); };
  $('#w-blip-voice').onchange = (e) => { setVoiceFor($('#w-per-sel')?.value || S.per?.active, e.target.value); blip('Bonjour ! Voici ma voix.', $('#w-per-sel')?.value || S.per?.active, true); };
  $('#w-blip-try').onclick = () => blip('Bonjour ! Voici ma voix, comme dans un vieux jeu.', $('#w-per-sel')?.value || S.per?.active, true);
  $('#w-per-new').onclick = () => { $('#w-per-sel').value = ''; $('#w-per-name').readOnly = false; $('#w-per-text').readOnly = false; $('#w-per-del').disabled = true; $('#w-per-name').value = ''; $('#w-per-text').value = ''; $('#w-per-apply').textContent = 'Enregistrer et appliquer'; $('#w-per-sel').selectedIndex = -1; $('#w-per-name').focus(); };
  $('#w-per-apply').onclick = async () => {
    const id = $('#w-per-sel').value; const p = S.per.profiles.find((x) => x.id === id);
    try {
      const body = p?.builtin ? { active: id } : { save: { id: p ? id : undefined, name: $('#w-per-name').value, text: $('#w-per-text').value }, activate: true };
      S.per = await call('/api/work/persona', 'POST', body);
      say(`Caractère appliqué : ${S.per.profiles.find((x) => x.id === S.per.active)?.name}`);
      $('#w-per').classList.add('hidden'); renderHead();
    } catch (e) { say(e.message, 'error'); }
  };
  $('#w-per-del').onclick = async () => {
    const id = $('#w-per-sel').value; const p = S.per.profiles.find((x) => x.id === id); if (!p || p.builtin || !confirm(`Supprimer le profil « ${p.name} » ?`)) return;
    try { S.per = await call('/api/work/persona', 'POST', { remove: id }); await openPersona(); renderHead(); } catch (e) { say(e.message, 'error'); }
  };
  $('#w-del-x').onclick = () => { delDir = null; delSess = null; $('#w-del').classList.add('hidden'); };
  $('#w-del-trash').onclick = () => { if (delSess) { S.trash.unshift({ sid: delSess.id, title: delSess.title || 'Sans titre', dir: delSess.location?.directory || '', at: Date.now() }); saveTrash(); if (S.cur === delSess.id) { S.cur = null; S.msgs = []; S.rendered = []; const c = $('#w-chat'); if (c) c.innerHTML = ''; renderAll(); } delSess = null; $('#w-del').classList.add('hidden'); renderList(); return; }
    if (delDir) { if (!inTrash(delDir)) { S.trash.unshift({ dir: delDir, at: Date.now() }); saveTrash(); } if (S.folder && normDir(S.folder) === normDir(delDir)) S.folder = ''; } delDir = null; $('#w-del').classList.add('hidden'); renderList(); };
  $('#w-del-erase').onclick = async () => { if (delSess) { const s = delSess; delSess = null; $('#w-del').classList.add('hidden'); await eraseOne(s.id); await refreshSessions(); return; } const d = delDir; delDir = null; $('#w-del').classList.add('hidden'); if (!d) return; dropProject(d); await eraseSessions(d); await refreshSessions(); };
  $('#w-no').onclick = () => $('#w-modal').classList.add('hidden');
  $('#w-yes').onclick = async () => { $('#w-modal').classList.add('hidden'); try { await call('/api/work/stop', 'POST', { sessionID: S.cur }); } catch (e) { say(e.message, 'error'); } poll(); };
}

function renderThumbs() {
  const el = $('#w-thumbs'); if (!el) return;
  el.innerHTML = S.files.map((f, i) => `<span class="w-th"><img src="${esc(f.uri)}" alt=""><button data-rmf="${i}" title="Retirer">✕</button></span>`).join('');
}

// ---- caractère du modèle (pré-prompt)
async function loadPersona() { try { S.per = await call('/api/work/persona'); S.eye = await call('/api/eye').catch(() => S.eye); renderHead(); } catch { /* serveur pas prêt */ } }
function fillPersona(id) {
  const p = S.per.profiles.find((x) => x.id === id) || S.per.profiles[0];
  $('#w-per-sel').value = p.id; $('#w-per-name').value = p.name; $('#w-per-text').value = p.text;
  $('#w-per-name').readOnly = !!p.builtin; $('#w-per-text').readOnly = !!p.builtin; $('#w-per-del').disabled = !!p.builtin;
  $('#w-per-apply').textContent = p.builtin ? 'Appliquer' : 'Enregistrer et appliquer';
}
async function openPersona() {
  await loadPersona(); if (!S.per) return;
  S.markFace?.();
  if ($('#w-per-emoji')) { $('#w-per-emoji').checked = S.per.opts?.emoji !== false; $('#w-per-aware').checked = S.per.opts?.aware !== false; $('#w-per-nsfw').checked = S.per.opts?.nsfw === true; $('#w-per-time').checked = S.per.opts?.time !== false; }
  $('#w-per-sel').innerHTML = S.per.profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.id === S.per.active ? ' (actif)' : ''}</option>`).join('');
  fillPersona(S.per.active);
  $('#w-per').classList.remove('hidden');
}
// ---- fermeture d'un projet : overlay « corbeille ou effacer »
let delDir = null; let delSess = null;
function askRemoveSession(id) {
  const s = S.sessions.find((x) => x.id === id); if (!s) return;
  delSess = s; delDir = null;
  $('#w-del-h').textContent = `Fermer la conversation « ${s.title || 'Sans titre'} » ?`;
  $('#w-del-p').textContent = 'Le dossier du projet n\'est pas touché. Corbeille : la conversation est gardée 7 jours (restaurable). Effacer : elle est supprimée tout de suite.';
  $('#w-del').classList.remove('hidden');
}
function askRemove(dir) {
  delDir = dir;
  const n = S.sessions.filter((s) => normDir(s.location?.directory) === normDir(dir)).length;
  $('#w-del-h').textContent = `Fermer le projet « ${base(dir)} » ?`;
  $('#w-del-p').textContent = `${n} conversation(s). Le dossier sur le disque n'est jamais touché. Corbeille : le projet et ses conversations sont gardés 7 jours (restaurables). Effacer : les conversations sont supprimées tout de suite.`;
  $('#w-del').classList.remove('hidden');
}
async function eraseSessions(dir) {
  const ids = S.sessions.filter((s) => normDir(s.location?.directory) === normDir(dir)).map((s) => s.id);
  for (const id of ids) { try { await call(`/oc/session/${encodeURIComponent(id)}`, 'DELETE'); } catch { /* déjà supprimée */ } }
  if (ids.includes(S.cur)) { S.cur = null; S.folder = ''; S.msgs = []; S.rendered = []; const c = $('#w-chat'); if (c) c.innerHTML = ''; }
}
async function eraseOne(id) {
  try { await call(`/oc/session/${encodeURIComponent(id)}`, 'DELETE'); } catch { /* déjà supprimée */ }
  if (S.cur === id) { S.cur = null; S.folder = ''; S.msgs = []; S.rendered = []; const c = $('#w-chat'); if (c) c.innerHTML = ''; renderAll(); }
}
function dropProject(dir) { S.projects = S.projects.filter((x) => normDir(x) !== normDir(dir)); saveProjects(S.projects); }
async function purgeTrash() {
  const old = S.trash.filter((t) => Date.now() - t.at > WEEK);
  if (!old.length || !S.ready) return;
  for (const t of old) { if (t.sid) await eraseOne(t.sid); else await eraseSessions(t.dir); }
  S.trash = S.trash.filter((t) => Date.now() - t.at <= WEEK); saveTrash();
  await refreshSessions();
}
function renderTrash() {
  const el = $('#w-trash'); if (!el) return;
  const days = (t) => Math.max(0, Math.ceil((WEEK - (Date.now() - t.at)) / 86400000));
  el.innerHTML = `<button class="btn ghost w-trash-h" id="w-trash-t">🗑 Corbeille (${S.trash.length}) ${S.trashOpen ? '▾' : '▸'}</button>${S.trashOpen && !S.trash.length ? '<div class="muted small" style="padding:6px 4px">Vide. Les projets et conversations jetés restent ici 7 jours.</div>' : ''}${S.trashOpen ? S.trash.map((t, i) => `<div class="w-trash-i"><span title="${esc(t.dir)}">${t.sid ? '💬 ' + esc(t.title) : '📁 ' + esc(base(t.dir))}</span><span class="muted small">${days(t)} j</span><button class="btn small" data-rest="${i}" title="Remettre dans la liste">Restaurer</button><button class="btn small danger" data-wipe="${i}" title="Effacer définitivement ses conversations">✕</button></div>`).join('') : ''}`;
  $('#w-trash-t').onclick = () => { S.trashOpen = !S.trashOpen; renderTrash(); };
  el.querySelectorAll('[data-rest]').forEach((b) => { b.onclick = () => { const t = S.trash[Number(b.dataset.rest)]; if (!t) return; S.trash.splice(Number(b.dataset.rest), 1); saveTrash(); if (!t.sid && !S.projects.some((x) => normDir(x) === normDir(t.dir))) { S.projects.unshift(t.dir); saveProjects(S.projects); } renderList(); }; });
  el.querySelectorAll('[data-wipe]').forEach((b) => { b.onclick = async () => { const t = S.trash[Number(b.dataset.wipe)]; if (!t || !confirm(t.sid ? `Effacer définitivement la conversation « ${t.title} » ?` : `Effacer définitivement les conversations de « ${base(t.dir)} » ? (le dossier sur le disque n'est pas touché)`)) return; if (t.sid) await eraseOne(t.sid); else await eraseSessions(t.dir); S.trash.splice(Number(b.dataset.wipe), 1); saveTrash(); await refreshSessions(); }; });
}

// Renommer une session : double-clic sur son nom (liste ou en-tête) -> champ de saisie ; Entrée valide, Échap annule.
function renameSession(id, anchor) {
  const s = S.sessions.find((x) => x.id === id); if (!s || !anchor || S.renaming) return;
  S.renaming = true;
  const inp = document.createElement('input'); inp.className = 'input w-rename'; inp.value = s.title || '';
  anchor.style.display = 'none'; anchor.insertAdjacentElement('afterend', inp); inp.focus(); inp.select();
  let done = false;
  const end = async (ok) => {
    if (done) return; done = true;
    const v = inp.value.trim(); inp.remove(); anchor.style.display = ''; S.renaming = false;
    if (ok && v && v !== s.title) { try { await call(`/oc/session/${encodeURIComponent(id)}`, 'PATCH', { title: v }); s.title = v; } catch (e) { say('Renommage impossible : ' + e.message, 'error'); } }
    S.headSig = ''; renderList(); renderHead();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') end(true); else if (e.key === 'Escape') end(false); e.stopPropagation(); };
  keepFocus(inp, end);
}
// Une session qui se (re)charge redonne le focus à la zone de saisie : sans cette garde, le champ de renommage se fermait aussitôt.
// On ne valide donc la perte de focus que si l'utilisateur a vraiment cliqué ailleurs.
function keepFocus(inp, end) {
  let down = 0; const md = (e) => { if (e.target !== inp) down = Date.now(); };
  document.addEventListener('mousedown', md, true);
  const stop = () => document.removeEventListener('mousedown', md, true);
  const orig = end;
  inp.addEventListener('blur', () => { if (Date.now() - down < 600) { stop(); orig(true); } else setTimeout(() => { if (inp.isConnected) { inp.focus(); } }, 0); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') stop(); });
}
function renameProject(dir, anchor) {
  if (!anchor || S.renaming) return; S.renaming = true;
  const inp = document.createElement('input'); inp.className = 'input w-rename'; inp.value = projName(dir);
  anchor.style.display = 'none'; anchor.insertAdjacentElement('afterend', inp); inp.focus(); inp.select();
  let done = false;
  const end = (ok) => { if (done) return; done = true; const v = inp.value.trim(); inp.remove(); anchor.style.display = ''; S.renaming = false; if (ok) { const a = loadAliases(); if (v && v !== base(dir)) a[normDir(dir)] = v; else delete a[normDir(dir)]; try { localStorage.setItem('paiz.projAlias', JSON.stringify(a)); } catch { /* ok */ } } renderList(); };
  inp.onkeydown = (e) => { if (e.key === 'Enter') end(true); else if (e.key === 'Escape') end(false); e.stopPropagation(); };
  keepFocus(inp, end);
}
const loadAliases = () => { try { return JSON.parse(localStorage.getItem('paiz.projAlias') || '{}') || {}; } catch { return {}; } };
const projName = (d) => loadAliases()[normDir(d)] || base(d);
// double-clic sur un nom (session ou projet, liste ou en-tête) -> édition sur place
root.addEventListener('dblclick', (e) => {
  const s = e.target.closest('.w-sess'); if (s) { e.preventDefault(); renameSession(s.dataset.id, s); return; }
  const f = e.target.closest('.w-folder > span'); if (f) { e.preventDefault(); renameProject(f.closest('.w-folder').title, f); return; }
  const h = e.target.closest('#w-head [data-tab="chat"] b'); if (h && S.cur) { e.preventDefault(); e.stopPropagation(); renameSession(S.cur, h); }
});
function renderList() {
  if (S.renaming) return;
  const groups = new Map(); const label = new Map();
  const add = (d) => { const k = normDir(d); if (!groups.has(k)) { groups.set(k, []); label.set(k, d); } return k; };
  for (const d of S.projects) if (!inTrash(d)) add(d);
  for (const s of S.sessions) { const d = s.location?.directory || '?'; if (!inTrash(d) && !sessTrashed(s.id)) groups.get(add(d)).push(s); }
  $('#w-list').innerHTML = [...groups].map(([k, ss]) => { const d = label.get(k); return `<div class="w-group"><div class="w-folder" title="${esc(d)}"><span title="Double-clic pour renommer">📁 ${esc(projName(d))}</span><button class="btn small" data-newin="${esc(d)}" title="Nouvelle session ici">＋</button><button class="btn small ghost" data-rmproj="${esc(d)}" title="Fermer ce projet">✕</button></div>${ss.map((s) => `<div class="w-srow"><button class="w-sess ${s.id === S.cur ? 'active' : ''}" data-id="${esc(s.id)}" title="${esc(s.title || '')}">${esc(s.title || 'Sans titre')}</button><button class="w-sx" data-rmsess="${esc(s.id)}" title="Fermer cette conversation">✕</button></div>`).join('')}</div>`; }).join('') || '<div class="muted small" style="padding:8px">Aucun projet. « Nouveau projet » pour en ajouter un.</div>';
  $('#w-list').querySelectorAll('[data-rmproj]').forEach((b) => { b.onclick = () => askRemove(b.dataset.rmproj); });
  renderTrash();
  $('#w-list').querySelectorAll('.w-sess').forEach((b) => { b.onclick = () => { if (S.cur === b.dataset.id && S.tab === 'chat') return; openSession(b.dataset.id); }; });
  $('#w-list').querySelectorAll('[data-rmsess]').forEach((b) => { b.onclick = () => askRemoveSession(b.dataset.rmsess); });
  $('#w-list').querySelectorAll('[data-newin]').forEach((b) => { b.onclick = () => { S.cur = null; S.folder = b.dataset.newin; S.msgs = []; S.rendered = []; $('#w-chat').innerHTML = ''; S.busy = false; renderAll(); $('#w-text').focus(); }; });
}

function para(text) {
  text = String(text ?? '').replace(/<|channel>s*thoughts*<channel|>/g, ''); // balises de réflexion de Gemma, parfois au milieu d'un message
  // paragraphes séparés par une ligne vide ; blocs de code ``` gardés entiers
  const out = []; const re = /```[\s\S]*?(```|$)/g; let last = 0; let m;
  const push = (t) => { for (const p of t.split(/\n{2,}/)) if (p.trim()) out.push({ raw: p.replace(/^\n+|\n+$/g, ''), code: false }); };
  while ((m = re.exec(text))) { push(text.slice(last, m.index)); out.push({ raw: m[0], code: true }); last = m.index + m[0].length; }
  push(text.slice(last));
  return out;
}
const inline = (t) => esc(t).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
function toolLine(p) {
  const i = p.input || {};
  const arg = i.path || i.filePath || i.file || i.command || i.pattern || i.url || i.query || (Object.values(i).find((v) => typeof v === 'string') || '');
  const ico = p.status === 'ok' ? '✓' : p.status === 'err' ? '✗' : '⏳';
  // contenu lisible : chaque champ de l'appel (chemin, contenu du fichier, commande…) avec ses vrais retours à la ligne
  const fields = Object.entries(i).map(([k, v]) => {
    const t = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    const long = t.length > 30000;
    return `<div class="w-tf"><span class="muted small">${esc(k)}</span><pre>${esc(long ? t.slice(0, 30000) : t)}${long ? `\n… (${t.length - 30000} caractères de plus)` : ''}</pre></div>`;
  }).join('');
  const res = p.out ? `<div class="w-tf"><span class="muted small">résultat</span><pre>${esc(String(p.out).slice(0, 6000))}</pre></div>` : '';
  return `<details class="w-tool ${p.status}"><summary><span class="w-ico">${ico}</span> <b>${esc(p.name)}</b> <span class="muted">${esc(String(arg).slice(0, 110))}</span> <span class="w-arrow muted small" title="Voir le contenu">détails ▸</span></summary>${fields}${res}</details>`;
}
// ---- aperçus : blocs de code web (HTML, SVG) d'un message et fichiers .html/.svg écrits par le modèle
function fences(text) {
  const out = []; const re = /```([\w+-]*)[ \t]*\n([\s\S]*?)```/g; let m;
  while ((m = re.exec(text || ''))) out.push({ lang: m[1].toLowerCase(), code: m[2] });
  return out;
}
const hashStr = (t) => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
function previewables(m) {
  if (m.role !== 'assistant') return [];
  const out = []; const seen = new Set();
  const add = (title, kind, code) => { const key = hashStr(code); if (code.trim().length < 20 || seen.has(key)) return; seen.add(key); out.push({ key, title, kind, code }); };
  for (const p of m.parts) {
    if (p.k === 'text') for (const f of fences(p.text)) {
      const c = f.code; const t = c.match(/<title>([^<]{1,40})<\/title>/i)?.[1];
      if (/^(html?|svg)$/.test(f.lang) || (!f.lang || f.lang === 'xml') && /^\s*(<!doctype html|<html|<svg)/i.test(c)) add(t || (f.lang === 'svg' || /^\s*<svg/i.test(c) ? 'Aperçu SVG' : 'Aperçu HTML'), /^\s*<svg/i.test(c) ? 'svg' : 'html', c);
    }
    if (p.k === 'tool' && /^(write|create)$/i.test(p.name || '')) {
      const i = p.input || {}; const file = String(i.filePath || i.path || i.file || ''); const c = typeof i.content === 'string' ? i.content : '';
      if (/\.(html?|svg)$/i.test(file)) add(base(file), /\.svg$/i.test(file) ? 'svg' : 'html', c);
    }
  }
  return out;
}
// scripts écrits par le modèle qu'on peut exécuter (Python, Node) : bouton « ▶ Lancer »
const RUNEXT = /\.(py|pyw|js|mjs|cjs)$/i;
// Le modèle propose une tâche de fond avec un bloc ```paiz-task (titre: … / --- / consigne) : l'interface la transforme en brouillon à relire.
function taskBlocks(m) {
  if (m.role !== 'assistant') return [];
  const out = [];
  for (const p of m.parts) if (p.k === 'text') for (const mt of p.text.matchAll(/```paiz-task[^\n]*\n([\s\S]*?)```/g)) {
    const raw = mt[1]; const i = raw.indexOf('\n---'); const head = i >= 0 ? raw.slice(0, i) : ''; const spec = (i >= 0 ? raw.slice(i + 4) : raw).trim();
    const title = (/^\s*titre\s*:\s*(.+)$/im.exec(head || raw) || [])[1]?.trim() || spec.split('\n')[0].slice(0, 60);
    if (spec) out.push({ title: title.slice(0, 120), spec });
  }
  return out;
}
function runnables(m) {
  if (m.role !== 'assistant') return [];
  const out = []; const seen = new Set();
  for (const p of m.parts) if (p.k === 'tool' && /^(write|create)$/i.test(p.name || '') && p.status === 'ok') {
    const i = p.input || {}; const f = String(i.filePath || i.path || i.file || '');
    if (RUNEXT.test(f) && !seen.has(f.toLowerCase())) { seen.add(f.toLowerCase()); out.push({ file: f }); }
  }
  return out;
}
const sessionDir = () => S.sessions.find((x) => x.id === S.cur)?.location?.directory || S.folder || '';
const absOf = (f) => (/^[a-zA-Z]:|^[\\/]/.test(f) ? f : `${sessionDir()}\\${f}`);
const runKey = (f) => absOf(f).replace(/\//g, '\\').toLowerCase();
S.running = new Set(); S.askedRun = new Set();
async function runFile(file) {
  const k = runKey(file);
  try {
    if (S.running.has(k)) { await call('/api/work/run/stop', 'POST', { file: absOf(file) }); S.running.delete(k); say(`${base(file)} arrêté.`); S.rendered = []; renderChat(true); return; }
    if (!S.askedRun.has(k) && !confirm(`Lancer « ${base(file)} » ?\n\nCe programme a été écrit par le modèle et s'exécute sur ton ordinateur avec tes droits, dans le dossier du projet.`)) return;
    S.askedRun.add(k);
    const r = await call('/api/work/run', 'POST', { file, dir: sessionDir() });
    if (r.running) { S.running.add(k); say(`${base(file)} est lancé (fenêtre séparée).`); S.rendered = []; renderChat(true); return; }
    say(r.hint || `${base(file)} s'est arrêté (code ${r.code})${r.output ? ' : ' + r.output.split('\n').slice(-3).join(' | ') : ''}`, r.code === 0 ? '' : 'error');
  } catch (e) { say(e.message, 'error'); }
}
function previewDoc(t) {
  if (/^\s*<(!doctype|html)/i.test(t.code) || t.kind === 'svg') return t.kind === 'svg' ? `<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff">${t.code}</body>` : t.code;
  return `<!doctype html><meta charset="utf-8"><body>${t.code}</body>`;
}
function openPreview(m, idx) {
  const t = previewables(m)[idx]; if (!t || !S.cur) return;
  const list = (S.tabsBy[S.cur] ||= []);
  let tab = list.find((x) => x.key === t.key);
  if (!tab) { tab = { id: `pv${Date.now().toString(36)}`, key: t.key, title: t.title, doc: previewDoc(t), fresh: true }; list.push(tab); setTimeout(() => { tab.fresh = false; }, 3200); }
  S.tab = tab.id; S.headSig = ''; renderHead();
}
function syncPrev() {
  const box = $('#w-prev'); const wrap = $('#w-wrap'); if (!box || !wrap) return;
  const tabs = S.tabsBy[S.cur || ''] || []; const active = tabs.find((x) => x.id === S.tab);
  for (const f of [...box.querySelectorAll('iframe')]) if (!tabs.some((x) => x.id === f.dataset.id)) f.remove();
  for (const t of tabs) if (!box.querySelector(`iframe[data-id="${t.id}"]`)) {
    const f = document.createElement('iframe'); f.dataset.id = t.id; f.className = 'w-prev-frame';
    f.setAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-modals allow-forms'); f.setAttribute('allow', 'fullscreen; autoplay; gamepad');
    f.srcdoc = t.doc; box.appendChild(f);
  }
  box.querySelectorAll('iframe').forEach((f) => { f.style.display = active && f.dataset.id === active.id ? '' : 'none'; });
  box.classList.toggle('hidden', !active); wrap.classList.toggle('prev-on', !!active);
}
function msgHtml(m) {
  const body = m.parts.map((p) => {
    if (p.k === 'tool') return toolLine(p);
    return para(p.text).map((q) => q.code
      ? `<div class="w-para" data-raw="${esc(q.raw)}"><pre>${esc(q.raw.replace(/^```\w*\n?|```$/g, ''))}</pre><button class="w-pc" data-copy="para" title="Copier">⧉</button></div>`
      : `<div class="w-para" data-raw="${esc(q.raw)}"><p>${inline(q.raw).replace(/\n/g, '<br>')}</p><button class="w-pc" data-copy="para" title="Copier">⧉</button></div>`).join('');
  }).join('');
  if (m.hkey && S.hidden.has(m.hkey)) return `<div class="w-msg hid" data-id="${esc(m.id)}" hidden></div>`;
  const hasText = m.parts.some((p) => p.k === 'text' && p.text.trim());
  const live = m.role === 'assistant' && !m.done;
  const tm = m.role === 'assistant' && m.done && m.t0 && m.t1 ? S.timings.filter((x) => x.up >= m.t0 - 4000 && x.end <= m.t1 + 4000 && !x.aborted) : [];
  const sum = (k) => tm.reduce((a, x) => a + x[k], 0);
  const detail = tm.length ? ` · lecture ${mmss(sum('read'))} · écriture ${mmss(sum('write'))}${sum('load') > 1 ? ` · chargement ${mmss(sum('load'))}` : ''}` : '';
  const dur = m.role === 'assistant' && m.done && m.t0 && m.t1 && m.t1 >= m.t0 ? `<span class="w-dur muted" title="Lecture du prompt, écriture de la réponse, puis durée totale (de la demande à la fin)">⏱${detail.replace(/^ · /, ' ')}${detail ? ' · total' : ''} ${mmss((m.t1 - m.t0) / 1000)}</span>` : '';
  const mdl = m.role === 'assistant' && m.done && m.model ? `<span class="w-mdl" title="Modèle qui a écrit ce message : ${esc(m.model)}">${esc(m.model.length > 22 ? m.model.slice(0, 21) + '…' : m.model)}</span>` : '';
  const pv = !live ? previewables(m) : [];
  const rn = !live ? runnables(m) : [];
  const tk = !live ? taskBlocks(m) : [];
  const tkBtns = tk.map((t, i) => `<button class="btn small w-pvbtn" data-mktask="${i}" title="Crée ce brouillon dans la barre des tâches : tu le relis, tu choisis le modèle, puis tu lances">📝 Créer le brouillon : ${esc(t.title.length > 40 ? t.title.slice(0, 39) + '…' : t.title)}</button>`).join('');
  const rnBtns = tkBtns + rn.map((t, i) => `<button class="btn small w-pvbtn" data-run="${i}" title="${S.running.has(runKey(t.file)) ? 'Fermer le programme' : 'Exécuter ce script (fenêtre séparée)'}">${S.running.has(runKey(t.file)) ? '■ Arrêter' : '▶ Lancer'}${rn.length > 1 || pv.length ? ' ' + esc(base(t.file)) : ''}</button>`).join('');
  const pvBtns = pv.map((t, i) => `<button class="btn small w-pvbtn" data-prev="${i}" title="Ouvrir ${esc(t.title)} dans un onglet à côté de la conversation">▶ ${pv.length > 1 ? 'Preview : ' + esc(t.title) : 'Open preview'}</button>`).join('');
  return `<div class="w-msg ${m.role}${live ? ' live' : ''}" data-id="${esc(m.id)}">${live ? '' : '<button class="w-x" data-act="hide" title="Fermer ce message">✕</button>'}${m.nfiles ? `<div class="muted small">🖼 ${m.nfiles} image(s) jointe(s)</div>` : ''}${body || (live ? '<span class="muted">…</span>' : '')}${m.error ? `<div class="w-err">${esc(/interrupted/i.test(m.error) ? 'Interrompu' : m.error)}</div>` : ''}${(hasText || dur || pvBtns || rnBtns) && !live ? `<div class="w-mc">${hasText ? '<button class="btn small" data-copy="msg">Copier</button>' : ''}${pvBtns}${rnBtns}${hasText && m.role === 'assistant' ? '<button class="btn small" data-tomem="1" title="Faire retenir ce message par la mémoire du projet">🧠 Retenir</button><button class="btn small" data-tonote="1" title="Noter ce message dans la To-do du projet">📝 Noter</button><button class="btn small" data-totask="1" title="Envoyer ce texte comme cahier des charges au gros modèle local (file des tâches)">📋 En file</button>' : ''}${dur}${mdl}</div>` : ''}</div>`;
}
let raf = 0;
// Aperçu en direct : OpenCode ne publie le texte d'une étape qu'une fois l'étape finie ; le relais, lui, voit les mots arriver du moteur.
// On affiche donc ce texte au fur et à mesure dans une bulle provisoire, remplacée par le vrai message dès qu'il arrive.
function renderLive() {
  const chat = $('#w-chat'); if (!chat) return;
  let el = chat.querySelector('.w-msg.pv');
  const lv = S.live;
  if (!lv || (!lv.text && !lv.tool)) { if (el) el.remove(); S.liveSaid = 0; S.liveHead = ''; return; }
  // bips au rythme de l'aperçu : c'est lui qui montre les mots pendant l'écriture (le vrai message n'arrive qu'en fin d'étape)
  if (lv.text) {
    if (!lv.text.startsWith(S.liveHead || '')) S.liveSaid = 0; // nouvelle étape : l'aperçu repart de zéro
    if (lv.text.length > (S.liveSaid || 0)) { blip(lv.text.slice(S.liveSaid || 0), S.per?.active); S.liveSaid = lv.text.length; S.liveHead = lv.text.slice(0, 24); S.liveAt = Date.now(); }
  }
  if (!el) { el = document.createElement('div'); el.className = 'w-msg assistant live pv'; chat.appendChild(el); }
  const body = lv.text ? para(lv.text).map((q) => (q.code ? `<div class="w-para"><pre>${esc(q.raw.replace(/^```\w*\n?|```$/g, ''))}</pre></div>` : `<div class="w-para"><p>${inline(q.raw).replace(/\n/g, '<br>')}</p></div>`)).join('') : '';
  const html = `${body}${lv.tool ? `<div class="muted small">⏳ prépare l'outil <b>${esc(lv.tool)}</b>…</div>` : ''}<div class="muted small">writing…</div>`;
  if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; if (S.stick) { S.progAt = Date.now(); chat.scrollTop = chat.scrollHeight; } }
}
async function pollLive() {
  if (!root.closest('.view.active') || !S.ready) return;
  try { const r = await call('/api/work/live'); S.live = r.active && r.writing ? r : null; } catch { return; }
  renderLive();
}
setInterval(pollLive, 500);
async function pollTimings() {
  if (!root.closest('.view.active') || !S.ready) return;
  try { const t = await call('/api/work/timings'); if (t.length !== S.timings.length || t.at(-1)?.end !== S.timings.at(-1)?.end) { S.timings = t; renderChat(true); } } catch { /* serveur pas prêt */ }
}
setInterval(pollTimings, 2500);
// Les bips suivent le texte AFFICHÉ : tout ce qui apparaît dans la conversation (en direct, ou par rechargement) est « dit », une seule fois.
// Au premier affichage d'une session, ce qui s'y trouve déjà est muet. Clé = position du message (stable d'un rechargement à l'autre).
function speakGrowth() {
  if (S.seenFor !== S.cur) { S.seenFor = S.cur; S.seenLen = new Map(); S.seedNext = true; }
  const seed = S.seedNext && S.msgs.length > 0;
  S.msgs.forEach((m, i) => {
    if (m.role !== 'assistant') return;
    m.parts.forEach((p, pi) => {
      if (p.k !== 'text') return;
      const key = `${i}:${pi}`; const len = p.text.length; const from = seed ? len : (S.seenLen.get(key) ?? 0);
      if (len > from && !(Date.now() - (S.liveAt || 0) < 20000)) blip(p.text.slice(from), S.per?.active); // déjà « dit » pendant l'aperçu : pas une 2e fois à l'arrivée du message
      S.seenLen.set(key, len);
    });
  });
  if (S.msgs.length) S.seedNext = false;
}
function renderChat(force) {
  if (raf && !force) return;
  const run = () => {
    raf = 0;
    const chat = $('#w-chat'); if (!chat) return;
    const wasStick = S.stick;
    speakGrowth();
    chat.querySelector('.w-msg.pv')?.remove();
    // ne rebâtit que les messages modifiés : la sélection de texte ailleurs n'est pas perdue
    S.rendered ||= [];
    // clé STABLE de chaque message (rôle + texte + n-ième occurrence) : les identifiants changent entre l'affichage direct et le rechargement,
    // le contenu non. C'est elle qui garde un message fermé fermé d'une visite à l'autre.
    const seen = new Map();
    for (const q of S.msgs) {
      const sig = `${q.role}|${q.parts.map((p) => (p.k === 'text' ? p.text : p.name)).join(' ').slice(0, 120)}|${(q.error || '').slice(0, 40)}`;
      const n = (seen.get(sig) || 0) + 1; seen.set(sig, n); q.hkey = `${sig}#${n}`;
    }
    S.msgs.forEach((m, i) => {
      const html = msgHtml(m);
      if (S.rendered[i] === html && chat.children[i]) return;
      S.rendered[i] = html;
      if (chat.children[i]) { chat.children[i].insertAdjacentHTML('afterend', html); chat.children[i].remove(); } else chat.insertAdjacentHTML('beforeend', html);
    });
    while (chat.children.length > S.msgs.length) chat.lastChild.remove();
    S.rendered.length = S.msgs.length;
    renderLive();
    if (wasStick) { S.progAt = Date.now(); chat.scrollTop = chat.scrollHeight; }
    else if (S.busy) $('#w-down').classList.remove('hidden');
  };
  if (force) run(); else raf = requestAnimationFrame(run);
}
function renderHead() {
  if (S.renaming) return;
  const s = S.sessions.find((x) => x.id === S.cur);
  const snd = blipSettings().on;
  const EYE = { live: ['👁', 'Œil : toujours prêt (chargé au lancement de PAIZ). Clic : à la demande'], demand: ['👁', 'Œil : à la demande (chargé pour une image, déchargé après 10 min). Clic : éteint'], off: ['👁', 'Œil éteint : les images ne sont pas vues. Clic : toujours prêt'] };
  const em = S.eye?.mode || 'demand';
  const eyeBtn = `<button class="btn small ghost w-eye ${em}" id="w-eye" title="${EYE[em][1]}" aria-label="${EYE[em][1]}">${EYE[em][0]}<small>${em === 'live' ? 'live' : em === 'demand' ? 'auto' : 'off'}</small></button>`;
  const gear = eyeBtn + `<button class="btn small ghost w-snd ${snd ? 'on' : ''}" id="w-snd" title="${snd ? 'Couper les sons de dialogue' : 'Activer les sons de dialogue (bips façon jeux rétro)'}" aria-label="${snd ? 'Couper les sons de dialogue' : 'Activer les sons de dialogue'}">${snd ? '🔊' : '🔇'}</button><label class="w-vol ${snd ? '' : 'off'}" title="Volume des sons de dialogue"><span class="w-vol-tri"><i style="width:${Math.round(blipSettings().vol * 100)}%"></i></span><input type="range" id="w-vol" min="0" max="100" value="${Math.round(blipSettings().vol * 100)}" aria-label="Volume des sons de dialogue"></label><button class="btn small ghost w-pergear" id="w-pergear" title="Caractère du modèle (pré-prompt)">⚙ ${esc(S.per ? (S.per.profiles.find((p) => p.id === S.per.active)?.name || 'Assistant') : 'Assistant')}</button>`;
  const sm = s?.model; const cloud = !!sm && sm.providerID && sm.providerID !== 'paiz';
  const modelBtn = S.cur ? `<button class="btn small ghost w-modelbtn ${cloud ? 'cloud' : ''}" id="w-modelbtn" title="Choisir le modèle de cette session : local ou cloud gratuit (OpenCode)">${cloud ? `☁ ${esc(sm.id)}` : `🖥 ${esc(S.st?.engine?.lastAssetName || 'Local')}`} ▾</button><button class="btn small ghost" id="w-usagebtn" title="Consommation de jetons : local et distant">📊 Jetons</button>` : '';
  const tabs = S.tabsBy[S.cur || ''] || [];
  if (S.tab !== 'chat' && !tabs.some((x) => x.id === S.tab)) S.tab = 'chat';
  const chatTitle = (S.cur || S.folder ? `<b>${esc(s?.title || 'Nouvelle session')}</b> <span class="muted">${esc(s?.location?.directory || S.folder)}</span>` : (S.st?.oc?.running ? `<b>🧪 Test :</b> ${testModelHtml()} <span class="muted">· aucun projet ni session sélectionné</span>` : '<span class="muted">Sélectionne un projet et une session.</span>'));
  const title = chatTitle;
  const html = `<div class="w-tabs"><button class="w-tab ${S.tab === 'chat' ? 'active' : ''}" data-tab="chat" title="Retour à la conversation">${title}</button>${tabs.map((t) => `<div class="w-tab ${S.tab === t.id ? 'active' : ''} ${t.fresh ? 'new' : ''}" data-tab="${t.id}" title="${esc(t.title)}">🖼 <span class="w-tab-t">${esc(t.title)}</span><button class="w-tab-x" data-closetab="${t.id}" title="Fermer l'aperçu">✕</button></div>`).join('')}<span class="grow"></span>${modelBtn}${gear}</div>`;
  if (html !== S.headSig) {
    S.headSig = html; $('#w-head').innerHTML = html; TB?.refreshTodo?.();
    $('#w-pergear').onclick = openPersona; paintFace();
    if ($('#w-face')) $('#w-face').onclick = openPersona;
    $('#w-vol').oninput = (e) => { const v = Number(e.target.value) / 100; setBlipSettings({ vol: v }); const i = e.target.parentElement.querySelector('i'); if (i) i.style.width = `${e.target.value}%`; };
    $('#w-vol').onchange = (e) => { if (!blipSettings().on) { setBlipSettings({ on: true }); renderHead(); } blip('Volume.', S.per?.active, true); };
    $('#w-eye').onclick = async () => { const nx = { live: 'demand', demand: 'off', off: 'live' }[S.eye?.mode || 'demand']; try { S.eye = await call('/api/eye', 'POST', { mode: nx }); say({ live: 'Œil toujours prêt : il se charge maintenant (processeur, ~2,5 Go de RAM).', demand: 'Œil à la demande : chargé pour une image, déchargé après 10 min.', off: 'Œil éteint : les images ne seront pas vues.' }[nx]); } catch (e) { say(e.message, 'error'); } renderHead(); };
    $('#w-snd').onclick = () => { const on = !blipSettings().on; setBlipSettings({ on }); if ($('#w-blip-on')) $('#w-blip-on').checked = on; if (on) blip('Son activé.', S.per?.active, true); else stopBlips(); renderHead(); };
    if ($('#w-modelbtn')) $('#w-modelbtn').onclick = openModelMenu;
    if ($('#w-usagebtn')) $('#w-usagebtn').onclick = openUsage;
    $('#w-head').querySelectorAll('[data-tab]').forEach((el) => { el.onclick = (e) => { const x = e.target.closest('[data-closetab]'); if (x) { S.tabsBy[S.cur || ''] = (S.tabsBy[S.cur || ''] || []).filter((q) => q.id !== x.dataset.closetab); if (S.tab === x.dataset.closetab) S.tab = 'chat'; S.headSig = ''; renderHead(); return; } if (S.tab === el.dataset.tab) return; S.tab = el.dataset.tab; S.headSig = ''; renderHead(); }; });
  }
  syncPrev();
  window.paizActiveDir = (S.cur || S.folder) ? (s?.location?.directory || S.folder || '') : ''; // lu par l'onglet Découvrir (destination « projet actif »)
  $('#w-hint')?.classList.toggle('hidden', !!(S.cur || S.folder) || testOn());
  $('#w-testbtn')?.classList.toggle('primary', !S.cur && !S.folder);
}
// ---- consommation de jetons (local / distant)
const nf = (n) => Number(n || 0).toLocaleString('fr-FR');
async function openUsage() {
  document.getElementById('w-usage')?.remove();
  const ov = document.createElement('div'); ov.id = 'w-usage'; ov.className = 'w-usage-ov';
  ov.innerHTML = '<div class="w-usage"><div class="w-usage-h"><b>📊 Consommation de jetons</b><span class="grow"></span><button class="btn small ghost" id="wu-x">✕</button></div><div id="wu-body" class="muted" style="padding:14px">Calcul…</div></div>';
  document.body.appendChild(ov); ov.onclick = (e) => { if (e.target === ov) ov.remove(); }; $('#wu-x').onclick = () => ov.remove();
  let u; try { u = await call('/api/work/usage'); } catch (e) { $('#wu-body').innerHTML = `<div class="w-err">${esc(e.message)}</div>`; return; }
  let per = 'today';
  const block = (title, kind, list, tot, note) => `<div class="wu-block ${kind}"><h4>${title}</h4>${list.length ? `<table class="wu-t"><thead><tr><th>Modèle</th><th class="n">Réponses</th><th class="n">Lus (entrée)</th><th class="n">Produits (sortie)</th></tr></thead><tbody>${list.filter((m) => m[per].msgs).map((m) => `<tr><td>${esc(m.name)}</td><td class="n">${nf(m[per].msgs)}</td><td class="n">${nf(m[per].in)}</td><td class="n"><b>${nf(m[per].out + m[per].reasoning)}</b>${m[per].errors ? ` <span class="badge danger" title="Réponses en erreur">${m[per].errors} err.</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Rien sur cette période.</td></tr>'}</tbody><tfoot><tr><td>Total ${kind === 'local' ? 'local' : 'distant'}</td><td class="n">${nf(tot[per].msgs)}</td><td class="n">${nf(tot[per].in)}</td><td class="n"><b>${nf(tot[per].out + tot[per].reasoning)}</b></td></tr></tfoot></table>` : '<p class="muted small">Aucune utilisation relevée.</p>'}${note || ''}</div>`;
  const paint = () => {
    $('#wu-body').innerHTML = `<div class="wu-per">${[['today', "Aujourd'hui"], ['week', '7 jours'], ['all', 'Tout']].map(([k, l]) => `<button class="btn small ${per === k ? 'primary' : ''}" data-per="${k}">${l}</button>`).join('')}</div>
      ${block('🖥 Local', 'local', u.local, u.total.local, '')}
      ${block('☁ Distant', 'remote', u.remote, u.total.remote, u.errors.length ? `<div class="muted small" style="margin-top:8px"><b>Dernières erreurs distantes</b> (quota atteint, refus…)${u.errors.map((e) => `<div class="wu-err ${e.exhausted ? 'ex' : ''}">${e.exhausted ? '⛔ <b>Blocage probable (quota)</b> · ' : ''}${new Date(e.t).toLocaleString('fr-FR')} · ${esc(e.model)} · ${esc(e.type)}${e.message ? ` — ${esc(e.message)}` : ''}<br><span>Jetons produits par ce modèle avant : <b>${nf(e.before.h1)}</b> sur 1 h · <b>${nf(e.before.h5)}</b> sur 5 h · <b>${nf(e.before.h24)}</b> sur 24 h <i>(indicatif)</i></span></div>`).join('')}</div>` : '')}
      <details class="wu-hours"><summary>Par heure (24 dernières heures, jetons produits)</summary><table class="wu-t"><thead><tr><th>Heure</th><th class="n">🖥 Local</th><th class="n">☁ Distant</th></tr></thead><tbody>${u.hourly.filter((x) => x.local || x.remote).reverse().map((x) => `<tr><td>${new Date(x.h).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit' })} h</td><td class="n">${nf(x.local)}</td><td class="n">${nf(x.remote)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Rien sur les dernières 24 h.</td></tr>'}</tbody></table></details>
      <p class="muted small">« Produits » = jetons écrits par le modèle (réflexion comprise). Relevé dans les sessions de l'écran Travail, toutes les 10 minutes et à l'ouverture de ce panneau (l'historique horaire est gardé même si une session est effacée)${u.since ? ` depuis le ${new Date(u.since).toLocaleDateString('fr-FR')}` : ''} (${u.sessions} session(s)) : effacer une session efface aussi son décompte. Le mode Test n'est pas compté.</p>`;
    $('#wu-body').querySelectorAll('[data-per]').forEach((b) => { b.onclick = () => { per = b.dataset.per; paint(); }; });
  };
  $('#wu-body').classList.remove('muted'); paint();
}
// ---- modèle de la session : local ou cloud gratuit d'OpenCode, changeable en cours de route
async function openModelMenu(e) {
  e.stopPropagation(); document.getElementById('w-modelmenu')?.remove();
  const s = S.sessions.find((x) => x.id === S.cur); if (!s) return;
  const cur = s.model || { providerID: 'paiz', id: 'local' };
  const m = document.createElement('div'); m.id = 'w-modelmenu'; m.className = 'w-modelmenu'; m.innerHTML = '<div class="muted small" style="padding:8px">Loading OpenCode free cloud models…</div>';
  const r = e.currentTarget.getBoundingClientRect(); m.style.top = `${r.bottom + 6}px`; m.style.right = `${Math.max(8, innerWidth - r.right)}px`;
  document.body.appendChild(m);
  const close = () => { m.remove(); document.removeEventListener('click', away, true); };
  const away = (ev) => { if (!m.contains(ev.target)) close(); };
  setTimeout(() => document.addEventListener('click', away, true), 0);
  let free = []; try { free = (await call('/api/work/models')).free; } catch (err) { m.innerHTML = `<div class="w-err" style="padding:8px">${esc(err.message)}</div>`; return; }
  const LV = { bad: ['🔴', 'données utilisées'], warn: ['🟡', 'conservé / limité'], ok: ['🟢', 'zéro rétention'], unk: ['⚪', 'non précisé'] };
  const item = (prov, id, label, sub, f) => `<button class="w-mi ${cur.providerID === prov && cur.id === id ? 'on' : ''}" data-p="${prov}" data-i="${esc(id)}"${f ? ` title="${esc(f.note)}"` : ''}><b>${label}</b><span class="muted small">${f ? `<span class="w-lv ${f.level}" title="${esc(f.note)}">${LV[f.level][0]} ${LV[f.level][1]}</span>${f.limit ? ` · ${esc(f.limit)}` : ''} · ` : ''}${sub || ''}</span></button>`;
  m.innerHTML = `<div class="w-mh">Modèle de cette session</div>${item('paiz', 'local', '🖥 Local', S.st?.engine?.lastAssetName ? esc(S.st.engine.lastAssetName) : 'ton modèle chargé dans PAIZ')}
    <div class="w-mh">☁ OpenCode Free Cloud Models</div>${free.length ? free.map((f) => item('opencode', f.id, esc(f.name), f.context ? `${Math.round(f.context / 1000)}k${f.tools ? '' : ' · sans outils'}` : '', f)).join('') : '<div class="muted small" style="padding:6px 10px">Aucun modèle gratuit disponible.</div>'}
    <div class="warn-box small" style="margin:6px"><span class="badge tw">cloud</span>&nbsp;Les messages et les fichiers lus par l'outil partent chez le fournisseur : 🔴 = données utilisées / journalisées, 🟡 = conservées ou limitées, 🟢 = zéro rétention annoncée (d'après la doc OpenCode, à vérifier). Passe la souris sur un modèle pour le détail.</div>
    <div class="muted small" style="margin:4px 8px 8px">💳 Aucun compte ni clé de paiement OpenCode n'est branché dans PAIZ : ces modèles passent par l'accès public gratuit, aucune facturation n'est possible. Les limites d'usage ne sont pas annoncées par OpenCode (sauf LongCat) : au-delà, attends-toi à un refus temporaire.</div>`;
  m.querySelectorAll('.w-mi').forEach((b) => { b.onclick = async () => {
    const prov = b.dataset.p; const id = b.dataset.i; close();
    if (prov === 'opencode' && !localStorage.getItem('paiz.cloudOk') && !confirm("Passer cette session sur un modèle cloud gratuit ?\n\nTes messages et les extraits de fichiers lus par le modèle partent sur Internet vers le fournisseur (via OpenCode). Rien ne reste privé sur ta machine pendant ce temps.\n\nTu pourras revenir au modèle local à tout moment (la conversation est conservée).")) return;
    if (prov === 'opencode') { try { localStorage.setItem('paiz.cloudOk', '1'); } catch { /* ignoré */ } }
    try { await call('/api/work/session-model', 'POST', { sessionID: S.cur, providerID: prov, id }); S.headSig = ''; await refreshSessions(); say(prov === 'paiz' ? 'Modèle local : les prochains messages utilisent ton modèle.' : `Modèle cloud « ${id} » : les prochains messages l'utilisent.`); } catch (err) { say(err.message, 'error'); }
  }; });
}
const GEARS = [[0, 'Auto'], [1, '1 😇 Ange'], [2, '2 🙂'], [3, '3 😐'], [4, '4 😠'], [5, '5 😡'], [6, '6 🤬 Ultra']];
const TPROFS = [['auto', '✨ Automatique'], ['chat', '💬 Discussion'], ['code', '⌨️ Code'], ['search', '🔎 Recherche'], ['full', '🧰 Complet']];
function renderControls() {
  const st = S.st; const eng = st?.engine; const act = st?.relay?.active; const as = act?.state;
  const paused = !!st?.relay?.paused || as === 'paused' || as === 'memory';
  const loading = !!eng?.loading || (eng?.running && !eng?.responding);
  const crashed = as === 'interrupted';
  const canResume = !act && !S.busy && S.cur && (['failed', 'interrupted'].includes(S.lastOutcome) || (S.msgs.at(-1)?.role === 'user'));
  const pp = crashed ? { l: '↻ Reprendre', t: 'Relancer le moteur : le travail repart de son dernier point de reprise', c: 'primary' }
    : as === 'pausing' ? { l: '⏳ Mise en pause…', t: 'Point de reprise en cours', c: '', d: true }
      : paused ? { l: '▶ Reprendre', t: 'Reprendre exactement là où le travail s\'est arrêté', c: 'primary' }
        : { l: '⏸ Pause', t: 'Mettre en pause avec un point de reprise', c: '' };
  const isAuto = locate(st?.engine?.grid, st?.engine?.profile).where === 'auto';
  const html = `
    <button class="btn big w-play" id="w-pp" title="Mettre en pause avec un point de reprise" ${paused || crashed || as === 'pausing' || !(S.busy || act) ? 'disabled' : ''}>${as === 'pausing' ? '⏳ Mise en pause…' : '⏸ Pause'}</button>
    <button class="btn big danger" id="w-stop" ${S.busy || st?.relay?.active || S.test.sending ? '' : 'disabled'}>■ Stop</button>
    <button class="btn big ${paused || crashed ? 'primary' : ''}" id="w-resume" title="${paused ? 'Reprendre exactement là où le travail s’est arrêté' : crashed ? 'Relancer le moteur : le travail repart de son dernier point de reprise' : 'Relancer le travail interrompu'}" ${paused || crashed || canResume ? '' : 'disabled'}>↻ Reprendre</button>
    <span class="grow"></span>
    ${loading ? '<span class="muted">Chargement du modèle…</span>' : ''}
    ${modeControlsHtml(st?.engine, st?.engine?.profile, { where: 'w-where', how: 'w-mode' })}
    ${isAuto ? `<label class="w-sel" title="Combien de la machine le mode adaptatif peut prendre (agit tout de suite)">Vitesse <select id="w-gear">${GEARS.map(([v, l]) => `<option value="${v}" ${Number(st?.engine?.gear ?? 0) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
    <label class="w-sel" title="Ce que tu veux faire avec l'agent : moins d'outils = prompt plus court = réponse plus rapide au démarrage. Modifiable à tout moment (le changement fait relire le prompt une fois).">Outils <select id="w-tprof">${TPROFS.map(([v, l]) => `<option value="${v}" ${(st?.tools?.profile || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <button class="btn" id="w-model" ${loading ? 'disabled' : ''}>${eng?.responding ? 'Décharger le modèle' : 'Charger le modèle'}</button>
    <span class="muted small w-modehelp" title="${esc([st?.engine?.profileInfo?.[st?.engine?.profile]?.desc, st?.engine?.profileInfo?.[st?.engine?.profile]?.conso].filter(Boolean).join(String.fromCharCode(10)))}">${esc([st?.engine?.profileInfo?.[st?.engine?.profile]?.desc, st?.engine?.profileInfo?.[st?.engine?.profile]?.conso].filter(Boolean).join(' · '))}</span>`;
  if (html === S.ctlSig) return; // rien n'a changé : on ne touche pas aux boutons (une liste ouverte reste ouverte)
  S.ctlSig = html; $('#w-controls').innerHTML = html;
  $('#w-tprof').onchange = async (e) => { try { await chooseToolProfile(e.target.value); say(`Outils : profil « ${TPROFS.find(([v]) => v === e.target.value)?.[1]} » (pris en compte à la prochaine requête).`); } catch (er) { say(er.message, 'error'); } poll(); };
  if ($('#w-gear')) $('#w-gear').onchange = async (e) => { try { await call('/api/work/engine/gear', 'POST', { gear: Number(e.target.value) }); say(`Vitesse : ${GEARS.find(([v]) => v === Number(e.target.value))?.[1]}`); } catch (er) { say(er.message, 'error'); } poll(); };
  wireModeControls(st?.engine, st?.engine?.profile, { where: 'w-where', how: 'w-mode' }, async (profile) => {
    if (!confirm(`Passer en mode « ${st?.engine?.profileInfo?.[profile]?.label || profile} » recharge le modèle${st?.relay?.active ? ' et interrompt le travail en cours' : ''}. Continuer ?`)) { S.ctlSig = ''; renderControls(); return; }
    try { await call('/api/work/engine/load', 'POST', { profile }); say('Rechargement du modèle…'); } catch (er) { say(er.message, 'error'); } poll();
  });
  $('#w-pp').onclick = async () => {
    try {
      await call('/api/work/pause', 'POST', { paused: true });
    } catch (e) { say(e.message, 'error'); }
    poll();
  };
  $('#w-stop').onclick = () => { if (S.test.sending) { S.test.ac?.abort(); return; } $('#w-modal').classList.remove('hidden'); };
  $('#w-model').onclick = async () => {
    try { await call(eng?.responding ? '/api/work/engine/unload' : '/api/work/engine/load', 'POST', {}); } catch (e) { say(e.message, 'error'); } poll();
  };
  $('#w-resume').onclick = async () => {
    try {
      if (crashed) { if (!eng?.responding && !eng?.running) { await call('/api/work/engine/load', 'POST', {}); say('Rechargement du modèle, le travail reprendra de son dernier point de reprise…'); } } // le relais se rattache tout seul au même travail
      else if (paused) await call('/api/work/pause', 'POST', { paused: false });
      else await resume();
    } catch (e) { say(e.message, 'error'); }
    poll();
  };
}
function renderBar() {
  const st = S.st; const a = st?.relay?.active; const paused = st?.relay?.paused;
  let label = ''; let pct = 0; let right = '';
  if (paused) { label = 'En pause'; right = st.relay.held ? 'étape suivante retenue' : 'l\'étape en cours se termine'; pct = a ? a.progress : 0; }
  let cls = '';
  if (a) {
    label = paused ? label : (a.phase === 'chargement' ? 'Chargement du modèle en mémoire' : a.phase === 'lecture' ? (a.loaded && a.loadSec ? `Modèle chargé (${mmss(a.loadSec)}) · lecture du prompt` : 'Lecture du prompt') : 'Écriture');
    pct = a.progress;
    right = a.overrun ? `${mmss(a.stepElapsed)} · plus long que prévu (≈ ${mmss(a.stepEstimate)}), toujours en cours` : `${mmss(a.stepElapsed)} / ≈ ${mmss(a.stepEstimate)}${a.phase === 'ecriture' ? ` · ${a.outTok} tok` : ''}`;
    const sec = (v) => (v < 10 ? v.toFixed(1) : Math.round(v)).toString().replace('.', ',');
    const tokens = a.jobN != null ? `${a.jobN} jetons conservés` : '';
    if (a.state === 'pausing') { label = 'Mise en pause… (point de reprise)'; cls = 'pause'; right = ''; }
    else if (a.state === 'paused') { label = 'En pause · point de reprise enregistré'; cls = 'pause'; right = [tokens, a.pausedFor != null ? `depuis ${mmss(a.pausedFor)}` : ''].filter(Boolean).join(' · '); }
    else if (a.state === 'memory') { label = `Interrompu : mémoire critique${a.memFreeMib != null ? ` (${Math.round(a.memFreeMib)} Mo libres)` : ''} · point de reprise enregistré`; cls = 'warn'; right = tokens; }
    else if (a.state === 'interrupted') { label = 'Moteur interrompu · travail conservé, prêt à reprendre'; cls = 'warn'; right = a.interruptedFor != null ? `depuis ${mmss(a.interruptedFor)}` : ''; }
    else if (a.state === 'resuming') { label = 'En reprise…'; cls = 'pause'; right = `${sec(a.resumeWait ?? 0)} s`; }
    else if (a.resumeTook != null || a.engineResume != null) { right += ` · reprise en ${sec(a.engineResume ?? a.resumeTook)} s`; }
  } else if (st?.engine?.loading) { label = st.engine.current?.phase === 'warm' ? 'Préchauffage du prompt (la 1re fois ≈ 20 s)' : 'Chargement du modèle en mémoire'; const el = st.engine.loadElapsed || 0; const es = st.engine.loadEstimate || 120; pct = Math.min(0.95, el / es); right = `${mmss(el)} / ≈ ${mmss(es)}${el > es ? ' · plus long que prévu, toujours en cours' : ''}`; }
  else if (S.busy && !paused) { label = 'Outil en cours…'; pct = 0; right = ''; }
  // Le chargement du modèle (état réel du moteur) prime sur tout le reste, y compris quand OpenCode vient d'envoyer une requête qui attend.
  const engLoading = !!st?.engine?.loading && !paused && !['pausing', 'paused', 'memory', 'interrupted', 'resuming'].includes(a?.state);
  if (engLoading) { label = st.engine.current?.phase === 'warm' ? 'Préchauffage du prompt (la 1re fois ≈ 20 s)' : 'Chargement du modèle en mémoire'; const el = st.engine.loadElapsed || 0; const es = st.engine.loadEstimate || 120; pct = Math.min(0.95, el / es); right = `${mmss(el)} / ≈ ${mmss(es)}${el > es ? ' · plus long que prévu, toujours en cours' : ''}${a ? ' · ta demande attend' : ''}`; cls = ''; }
  const total = S.busy ? `total ${mmss((Date.now() - S.execStart) / 1000)}` : '';
  $('#w-bar').innerHTML = (label || total) ? `<div class="w-barrow ${cls}"><span>${esc(label)}</span><span class="muted">${esc(right)}${right && total ? ' · ' : ''}${esc(total)}</span></div><div class="w-track"><div class="w-fill ${cls} ${a || paused || engLoading || st?.engine?.loading ? '' : 'ind'}" style="width:${Math.round(pct * 100)}%"></div></div>` : '';
}
// Au centre de la discussion, tant que le service (OpenCode…) n'est pas démarré : choix du service + gros bouton.
function renderStart() {
  const el = $('#w-start'); if (!el) return;
  const on = !!S.st?.oc?.running;
  el.classList.toggle('hidden', on);
  if (on) return;
  const lastName = S.st?.engine?.lastAssetName; const engOn = !!S.st?.engine?.running;
  const tprof = S.st?.tools?.profile || 'auto';
  const sig = `${S.starting}|${S.startErr}|${lastName}|${engOn}|${tprof}`;
  if (sig === S.startSig && el.innerHTML) return;
  S.startSig = sig;
  el.innerHTML = `<div class="w-start-box"><select class="input" id="w-svc" title="Service"><option value="opencode">OpenCode</option><option disabled>Claude Code (bientôt)</option><option disabled>OpenClaw (bientôt)</option></select>
    ${lastName && !engOn ? `<label class="check"><input type="checkbox" id="w-autoload" ${autoLoad() ? 'checked' : ''}> Charger aussi le dernier modèle<br><span class="muted small">${esc(lastName)}</span></label>` : ''}
    <div class="w-startprof"><div class="muted small">Que veux-tu faire ? <span title="Moins d'outils proposés au modèle = prompt plus court = réponse plus rapide au démarrage. Tu pourras changer à tout moment, même en pleine session (⚖ Outils).">(modifiable à tout moment)</span></div><div class="tb-profiles">${TPROFS.map(([v, l]) => `<button class="btn small ${v === tprof ? 'primary' : ''}" data-tsp="${v}">${l}</button>`).join('')}</div></div>
    <button class="btn primary big" id="w-startbtn" ${S.starting ? 'disabled' : ''}>${S.starting ? 'Démarrage…' : '▶ Démarrer le service'}</button>${S.startErr ? `<div class="w-err">${esc(S.startErr)}</div>` : ''}</div>`;
  $('#w-startbtn').onclick = startService;
  el.querySelectorAll('[data-tsp]').forEach((b) => { b.onclick = async () => { try { await chooseToolProfile(b.dataset.tsp); S.startSig = ''; await poll(); } catch (er) { say(er.message, 'error'); } }; });
  const al = $('#w-autoload'); if (al) al.onchange = () => { try { localStorage.setItem('paiz.autoload', al.checked ? '1' : '0'); } catch { /* ignore */ } };
}
const autoLoad = () => { try { return localStorage.getItem('paiz.autoload') !== '0'; } catch { return true; } };
async function startService() {
  S.starting = true; S.startErr = ''; renderStart();
  try {
    await call('/api/work/start', 'POST', {}); S.ready = true; openStream(); await refreshSessions();
    if (autoLoad() && S.st?.engine?.lastAssetName && !S.st?.engine?.running) { try { await call('/api/work/engine/load', 'POST', {}); } catch (e) { say(e.message, 'error'); } }
  }
  catch (e) { S.startErr = e.message; }
  S.starting = false; await poll(); S.startSig = ''; renderStart();
}
// ---- mode Test : discussion libre avec le modèle chargé quand aucune session n'est ouverte (ex-onglet « Tester » de WeightStream)
const testModelHtml = () => { const e = S.st?.engine; const n = e?.current?.path?.split(/[\\/]/).pop(); return n ? `<code>${esc(n)}</code>` : e?.loading || e?.running ? '<span class="muted">chargement du modèle…</span>' : '<span class="muted">aucun modèle chargé</span>'; };
const testOn = () => !S.cur && !S.folder && !!S.st?.oc?.running;
function openTest() { S.cur = null; S.folder = ''; S.msgs = []; S.rendered = []; const c = $('#w-chat'); if (c) c.innerHTML = ''; S.busy = false; renderAll(); $('#w-text')?.focus(); }
function renderTest() {
  const el = $('#w-test'); if (!el) return;
  const on = testOn(); el.classList.toggle('hidden', !on);
  if (!on) return;
  const eng = S.st?.engine; const T = S.test;
  const dirs = [...new Map([...S.projects, ...S.sessions.map((x) => x.location?.directory).filter(Boolean)].filter((d) => !inTrash(d)).map((d) => [normDir(d), d])).values()];
  const sig = `${T.chat.length}|${T.sending}|${eng?.responding}|${eng?.loading}|${dirs.join(';')}`;
  if (sig === T.sig && el.innerHTML) return;
  T.sig = sig;
  const keep = { max: $('#wt-max')?.value, temp: $('#wt-temp')?.value, proj: $('#wt-proj')?.value };
  el.innerHTML = `<div class="w-test-log" id="wt-log">${T.chat.map((m, i) => `<div class="w-msg ${m.role}"><div class="w-para"><p>${inline(m.content).replace(/\n/g, '<br>')}</p></div>${m.dur ? `<div class="w-mc"><span class="w-dur muted">⏱ ${m.dur.eye ? `œil ${mmss(m.dur.eye / 1000)} · ` : ''}lecture ${mmss(m.dur.read / 1000)} · écriture ${mmss(m.dur.write / 1000)} · total ${mmss(m.dur.total / 1000)}</span></div>` : ''}${m.meta ? `<div class="muted small">${esc(m.meta)}</div>` : ''}${m.role === 'assistant' ? `<div class="w-mc"><button class="btn small" data-wtcopy="${i}" title="Copier ce message">📋 Copier</button>${m.cut ? ` <span class="badge warn">✂ coupée : limite « Réponse max » atteinte</span> <button class="btn small" data-wtmore="${i}">Continuer ▸</button>` : ''}</div>` : ''}</div>`).join('') || '<p class="muted">Écris un message ci-dessous pour tester le modèle chargé. Rien n\'est gardé dans une session.</p>'}${T.sending ? `<div class="w-msg assistant live"><div class="w-para"><p id="wt-livetext">${inline(T.live || '').replace(/\n/g, '<br>')}</p></div><div class="muted small" id="wt-live">⏳ lecture du prompt · 0:00</div></div>` : ''}</div>
    <div class="w-test-foot"><button class="btn small" id="wt-clear" ${T.chat.length ? '' : 'disabled'}>Effacer</button><label class="muted small">Réponse max <input class="input" id="wt-max" type="number" min="16" max="4096" value="${esc(keep.max ?? T.max)}"></label>
      <label class="muted small">Température <input class="input" id="wt-temp" type="number" min="0" max="2" step="0.1" value="${esc(keep.temp ?? T.temp)}"></label><span class="grow"></span>
      <label class="muted small">Passer en session dans <select class="input" id="wt-proj">${dirs.map((d) => `<option value="${esc(d)}" ${keep.proj === d ? 'selected' : ''}>${esc(base(d))}</option>`).join('') || '<option value="">(crée d\'abord un projet)</option>'}</select></label>
      <button class="btn" id="wt-conv" ${T.chat.length && dirs.length ? '' : 'disabled'} title="Crée une vraie session dans ce projet avec cette conversation, pour que le modèle puisse travailler avec les outils">↗ En faire une session</button></div>`;
  const log = $('#wt-log'); if (log) log.scrollTop = log.scrollHeight;
  el.querySelectorAll('[data-wtcopy]').forEach((b) => { b.onclick = () => copyText(T.chat[Number(b.dataset.wtcopy)]?.content || ''); });
  el.querySelectorAll('[data-wtmore]').forEach((b) => { b.onclick = () => testSend('Continue exactement là où tu t’es arrêté, sans répéter ce qui précède.'); });
  $('#wt-clear').onclick = () => { T.chat = []; renderTest(); };
  $('#wt-conv').onclick = () => testToSession($('#wt-proj').value);
}
async function testSend(text, files = []) {
  const T = S.test; if (T.sending) return;
  const seen = T.chat.filter((m) => m.eye?.length); const recent = new Set(seen.slice(-2));
  const short = (d) => { const s = String(d).split(/(?<=[.!?])\s+/).slice(0, 2).join(' '); return s.length > 320 ? `${s.slice(0, 317)}…` : s; };
  const history = T.chat.map((m) => ({ role: m.role, content: m.eye?.length ? `${m.content}\n${m.eye.map((d) => `[Image vue par l'œil de PAIZ : ${recent.has(m) ? d : short(d)}]`).join('\n')}` : m.content }));
  history.push({ role: 'user', content: files.length ? [{ type: 'text', text }, ...files.map((f) => ({ type: 'image_url', image_url: { url: f.uri } }))] : text });
  T.chat.push({ role: 'user', content: files.length ? `${text}\n[${files.length} image(s) jointe(s)]` : text }); T.sending = true; T.live = ''; T.eyeMs = 0; T.t0 = Date.now(); T.ac = new AbortController(); $('#w-text').value = ''; renderTest(); renderControls();
  const tick = setInterval(() => { const el = $('#wt-live'); if (el) el.textContent = `⏳ ${T.live ? 'écriture' : files.length ? 'l’œil de PAIZ regarde l’image, puis lecture du prompt' : 'lecture du prompt'} · ${mmss((Date.now() - T.t0) / 1000)}`; }, 500);
  try {
    const r = await fetch('/api/engine/chat-stream', { method: 'POST', signal: T.ac.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history, maxTokens: Number($('#wt-max')?.value) || T.max, temperature: Number($('#wt-temp')?.value ?? T.temp) }) });
    if (!r.ok) throw new Error(`${r.status}`);
    const dec = new TextDecoder(); let buf = ''; let fin = null;
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true }); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        const o = JSON.parse(line);
        if (o.error) throw new Error(o.error);
        if (o.delta) { T.live += o.delta; blip(o.delta, S.per?.active); const lg = $('#wt-livetext'); if (lg) { lg.innerHTML = inline(T.live).replace(/\n/g, '<br>'); const box = $('#wt-log'); if (box) box.scrollTop = box.scrollHeight; } else renderTest(); }
        if (o.eyeMs != null) { T.eyeMs = o.eyeMs; if (o.eyeText?.length) { const u = [...T.chat].reverse().find((x) => x.role === 'user'); if (u) u.eye = o.eyeText; } }
        if (o.done) fin = o;
      }
    }
    if (!fin) throw new Error('réponse interrompue');
    T.chat.push({ role: 'assistant', content: fin.text || T.live || '(vide)', dur: { eye: T.eyeMs || 0, read: fin.readMs, write: fin.writeMs, total: fin.ms + (T.eyeMs || 0) }, meta: `${fin.tokens} jetons${fin.tps ? ` · ${fin.tps} jetons/s` : ''} · prompt ${fin.promptTokens} jetons`, cut: fin.truncated === true || Number(fin.tokens) >= (Number($('#wt-max')?.value) || T.max) - 1 });
    mood('souriant');
  } catch (e) { if (e.name === 'AbortError') T.chat.push({ role: 'assistant', content: `${T.live || ''}\n\n(réponse interrompue)`.trim() }); else { mood('mecontent'); T.chat.push({ role: 'assistant', content: `${T.live ? T.live + '\n\n' : ''}Erreur : ${e.message}` }); } }
  clearInterval(tick); T.sending = false; T.ac = null; T.live = ''; renderTest(); renderControls();
}
async function testToSession(dir) {
  const T = S.test; if (!dir || !T.chat.length) return;
  const hist = T.chat.map((m) => `${m.role === 'user' ? 'Moi' : 'Toi'} : ${m.content}`).join('\n\n');
  try {
    const sess = await call('/api/work/session', 'POST', { dir, title: `Test : ${T.chat[0].content.slice(0, 40)}` });
    T.chat = []; T.sig = '';
    if (!S.projects.some((x) => normDir(x) === normDir(dir))) { S.projects.unshift(dir); saveProjects(S.projects); }
    S.cur = sess.id; S.folder = ''; S.msgs = []; S.rendered = []; $('#w-chat').innerHTML = '';
    await refreshSessions(); renderAll();
    await sendNow(`Voici la conversation de test que nous venons d'avoir. Continue-la ici, dans le projet, avec tes outils.\n\n${hist}`, [], false);
  } catch (e) { say(e.message, 'error'); }
}

// ---- archive : tous les projets mémorisés, leurs conversations, où ils sont sur le disque
async function openArchive() {
  $('#w-arch').classList.remove('hidden');
  const body = $('#w-arch-body'); body.innerHTML = '<p class="muted">Lecture…</p>';
  let reg; try { reg = await call('/api/work/projects'); } catch (e) { body.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  const ex = new Map(reg.projects.map((p) => [normDir(p.dir), p]));
  const rows = new Map();
  const row = (d) => { const k = normDir(d); if (!rows.has(k)) rows.set(k, { dir: d, ss: [], at: ex.get(k)?.addedAt || '' }); return rows.get(k); };
  for (const p of reg.projects) row(p.dir);
  for (const x of S.sessions) if (x.location?.directory) row(x.location.directory).ss.push(x);
  const list = [...rows.values()].filter((r) => !inTrash(r.dir));
  const fmt = (t) => { const d = new Date(t); return Number.isNaN(+d) ? '' : d.toLocaleDateString('fr-FR'); };
  body.innerHTML = `<p class="muted small">Mémorisés dans la base de PAIZ (pas dans le navigateur) : ils restent même si l'interface est réinstallée. Les dossiers ne sont jamais supprimés d'ici.</p>
    <div class="w-arch-list">${list.map((r, i) => { const here = fs_exists(ex, r); return `<div class="w-arch-row ${here ? '' : 'gone'}"><div class="grow"><b>📁 ${esc(base(r.dir))}</b> ${here ? '' : '<span class="badge cf-bad">dossier introuvable</span>'}<div class="muted small" title="${esc(r.dir)}">${esc(r.dir)}</div>
      <div class="muted small">${r.ss.length} conversation(s)${r.at ? ` · mémorisé le ${esc(fmt(r.at))}` : ''} <span id="arch-sz-${i}"></span></div>
      ${r.ss.length ? `<details><summary class="muted small">Conversations</summary>${r.ss.map((x) => `<div class="small">💬 ${esc(x.title || 'Sans titre')}</div>`).join('')}</details>` : ''}</div>
      <div class="w-arch-btns"><button class="btn small" data-reveal="${i}" ${here ? '' : 'disabled'}>📂 Ouvrir</button><button class="btn small" data-size="${i}" ${here ? '' : 'disabled'}>⚖ Taille</button><button class="btn small danger" data-close="${i}">Fermer…</button></div></div>`; }).join('') || '<p class="muted">Aucun projet mémorisé.</p>'}</div>`;
  body.querySelectorAll('[data-reveal]').forEach((b) => { b.onclick = () => call('/api/work/projects/reveal', 'POST', { dir: list[Number(b.dataset.reveal)].dir }).catch((e) => say(e.message, 'error')); });
  body.querySelectorAll('[data-size]').forEach((b) => { b.onclick = async () => {
    const i = Number(b.dataset.size); const out = $(`#arch-sz-${i}`); b.disabled = true; out.textContent = '· calcul…';
    try { const z = await call(`/api/work/projects/size?dir=${encodeURIComponent(list[i].dir)}`); out.textContent = `· ${(z.bytes / 1048576).toFixed(z.bytes > 1e9 ? 0 : 1)} Mo, ${z.files} fichiers${z.partial ? ' (au moins)' : ''}`; } catch (e) { out.textContent = `· ${e.message}`; }
    b.disabled = false; }; });
  body.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { $('#w-arch').classList.add('hidden'); askRemove(list[Number(b.dataset.close)].dir); }; });
}
const fs_exists = (ex, r) => { const p = ex.get(normDir(r.dir)); return p ? p.exists !== false : true; };
async function loadServerProjects() {
  try {
    const srv = await call('/api/work/projects');
    const have = new Set(S.projects.map(normDir));
    for (const p of srv.projects) if (!have.has(normDir(p.dir))) { S.projects.push(p.dir); have.add(normDir(p.dir)); }
    const th = new Set(S.trash.map((t) => `${t.sid || ''}|${normDir(t.dir)}`));
    for (const t of srv.trash) if (!th.has(`${t.sid || ''}|${normDir(t.dir)}`)) S.trash.push(t);
    projLoaded = true; syncServer();
  } catch { /* serveur pas prêt : la copie du navigateur sert */ }
}
// tout dossier vu dans une session est mémorisé : un projet ne « disparaît » plus
function autoRegister() {
  if (!projLoaded) return;
  let ch = false;
  for (const x of S.sessions) { const d = x.location?.directory; if (d && !inTrash(d) && !S.projects.some((q) => normDir(q) === normDir(d))) { S.projects.push(d); ch = true; } }
  if (ch) saveProjects(S.projects);
}
function renderAll() { renderList(); renderHead(); renderChat(true); renderControls(); renderBar(); renderStart(); renderQueue(); renderTest(); }

// ------------------------------------------------------------------ actions
async function refreshSessions() {
  try { const r = await call('/oc/session?limit=200&order=desc'); S.sessions = r.data || []; autoRegister(); renderList(); renderHead(); renderTest(); } catch { /* serveur pas prêt */ }
  if (!S.purged) { S.purged = true; purgeTrash().catch(() => {}); }
}
async function openSession(id) {
  S.cur = id; S.folder = ''; S.stick = true; S.msgs = []; S.rendered = []; $('#w-chat').innerHTML = '';
  renderAll();
  try {
    const act = await call('/oc/session/active'); S.busy = !!(act.data && act.data[id]); if (S.busy) S.execStart = Date.now();
    await loadMessages();
  } catch (e) { say(e.message, 'error'); }
  renderAll();
}
async function startProject(dir) {
  if (!dir) return;
  try { localStorage.setItem('paiz.workdir', dir); } catch { /* ignore */ }
  if (!S.projects.some((x) => normDir(x) === normDir(dir))) { S.projects.unshift(dir); saveProjects(S.projects); }
  S.cur = null; S.folder = dir; S.msgs = []; S.rendered = []; $('#w-chat').innerHTML = ''; S.busy = false;
  $('#w-newbox').classList.add('hidden');
  renderAll(); $('#w-text').focus();
}
async function ensureSession(text) {
  if (S.cur) return S.cur;
  if (!S.folder) throw new Error('Choisis d\'abord un projet.');
  const s = await call('/api/work/session', 'POST', { dir: S.folder, title: text.slice(0, 48) });
  S.cur = s.id; S.folder = ''; await refreshSessions();
  return s.id;
}
// ---- file d'attente : les messages tapés pendant que le modèle travaille attendent ici (consultables, retirables), puis partent fusionnés en un seul
function renderQueue() {
  const box = $('#w-q'); if (!box) return;
  const q = S.queue[S.cur] || [];
  if (!q.length) { box.innerHTML = ''; return; }
  const items = q.map((it, i) => `<div class="w-qi"><span class="w-qn">${i + 1}</span><span class="w-qt" title="${esc(it.text)}">${esc(it.text.length > 140 ? it.text.slice(0, 140) + '…' : it.text)}${it.files?.length ? ` 🖼×${it.files.length}` : ''}</span><button class="w-x w-qx" data-qrm="${esc(it.id)}" title="Retirer de la file">✕</button></div>`).join('');
  const note = S.busy ? 'Ils partiront fusionnés en un seul message dès que le modèle aura fini.' : 'Le modèle est libre : tu peux les envoyer maintenant (fusionnés en un seul message).';
  box.innerHTML = `<button class="btn small ghost w-qh" id="w-qtog">⏳ File d'attente (${q.length}) ${S.qOpen ? '▾' : '▸'}</button>${S.qOpen ? `<div class="w-qbody">${items}<div class="muted small">${note}</div><div class="toolbar"><button class="btn small" id="w-qall">Tout vider</button><span class="grow"></span><button class="btn small primary" id="w-qnow" ${S.busy ? 'disabled' : ''}>Envoyer maintenant</button></div></div>` : ''}`;
  $('#w-qtog').onclick = () => { S.qOpen = !S.qOpen; renderQueue(); };
  box.querySelectorAll('[data-qrm]').forEach((b) => { b.onclick = () => { S.queue[S.cur] = (S.queue[S.cur] || []).filter((x) => x.id !== b.dataset.qrm); if (!S.queue[S.cur].length) delete S.queue[S.cur]; saveQueue(); renderQueue(); }; });
  const all = $('#w-qall'); if (all) all.onclick = () => { delete S.queue[S.cur]; saveQueue(); renderQueue(); };
  const now = $('#w-qnow'); if (now) now.onclick = flushQueue;
}
async function flushQueue() {
  const sid = S.cur; const q = S.queue[sid] || [];
  if (!sid || !q.length || S.busy) return;
  delete S.queue[sid]; saveQueue(); renderQueue();
  await sendNow(q.map((x) => x.text).join('\n\n'), q.flatMap((x) => x.files || []), false);
}
async function send(textArg) {
  const ta = $('#w-text'); const files = typeof textArg === 'string' ? [] : S.files.slice();
  const text = (typeof textArg === 'string' ? textArg : ta.value.trim()) || (files.length ? 'Voici une image.' : '');
  if (!text) return;
  if (testOn()) { if (typeof textArg !== 'string') { S.files = []; renderThumbs(); } await testSend(text, files); return; }
  if (typeof textArg !== 'string' && S.cur && S.busy) {  // le modèle travaille : on met en file
    (S.queue[S.cur] ||= []).push({ id: `q${Date.now()}${Math.random().toString(36).slice(2, 5)}`, text, files });
    saveQueue(); ta.value = ''; S.files = []; renderThumbs(); S.qOpen = true; renderQueue(); return;
  }
  await sendNow(text, files, typeof textArg !== 'string');
}
async function sendNow(text, files, fromComposer) {
  const ta = $('#w-text');
  try {
    const id = await ensureSession(text);
    S.stick = true;
    S.msgs.push({ id: `tmp-${Date.now()}`, role: 'user', parts: [{ k: 'text', text }], done: true, nfiles: files.length });
    renderChat(true);
    if (fromComposer) { ta.value = ''; S.files = []; renderThumbs(); }
    S.busy = true; S.execStart = Date.now();
    await call('/api/work/prompt', 'POST', { sessionID: id, text, files });
    renderAll();
  } catch (e) { S.busy = false; say(e.message, 'error'); renderControls(); }
}
// « Reprendre » après un plantage : recharge le moteur s'il est tombé, lève la pause, relance la session.
async function resume() {
  try {
    if (!S.st?.engine?.responding) {
      await call('/api/work/engine/load', 'POST', {});
      say('Chargement du modèle…');
      for (let i = 0; i < 600; i++) { await new Promise((r) => setTimeout(r, 1000)); await poll(); if (S.st?.engine?.responding) break; }
    }
    if (S.st?.relay?.paused) await call('/api/work/pause', 'POST', { paused: false });
    await send('Continue là où tu t\'étais arrêté.');
  } catch (e) { say(e.message, 'error'); }
}

async function poll() {
  try { S.st = await call('/api/work/state'); } catch { return; }
  if (!root.closest('.view.active')) return;
  renderControls(); renderBar(); renderStart(); renderHead(); renderTest();
  if (S.running.size) { // un programme lancé d'ici peut avoir été fermé à la main : le bouton « Arrêter » redevient « Lancer »
    try { const r = await call('/api/work/run/state'); const alive = new Set(r.running.map((x) => x.toLowerCase())); const before = S.running.size; S.running = new Set([...S.running].filter((k) => alive.has(k))); if (S.running.size !== before) { S.rendered = []; renderChat(true); } } catch { /* serveur pas prêt */ }
  }
}

// ---- Barre des tâches, plans, To-do : module séparé
const TB = initTasksBar({ root, call, say, esc, nf, copyText, getMsgs: () => S.msgs, getDir: () => sessionDir() });
const { renderTasks, pollTasks } = TB;
initMemory({ root, call, say, esc, getDir: () => sessionDir(), getMsgs: () => S.msgs });

let started = false; let timer = null; let opening = false;
async function open() {
  if (opening) return; opening = true;
  if (!started) { started = true; frame(); renderAll(); renderTasks(); pollTasks(); loadPersona(); loadServerProjects().then(() => { renderList(); autoRegister(); }); }
  try {
    await poll();
    if (S.st?.oc?.running && !S.ready) { S.ready = true; openStream(); await refreshSessions(); }
  } catch { /* état indisponible : on réessaiera */ }
  opening = false;
  if (!timer) timer = setInterval(() => { if (root.closest('.view.active')) poll(); }, 1000);
}
const obs = new MutationObserver(() => { if (root.closest('.view.active') && !S.ready) open(); });
obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
if (root.closest('.view.active')) open();
