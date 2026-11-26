// Onglet « WeightStream » : Moteur (invoquer / état), Réglages, Connexions (OpenCode et autres clients).
// Module autonome : ne dépend de app.js que par la barre d'onglets (data-view="engine").
import { famBadge } from '/fam.js';
import { modeControlsHtml, wireModeControls } from '/modes.js';
import { ROLE, reposDialog, pickRepo } from '/repos.js';
import { saveConfDialog, loadConfDialog } from '/confs.js';
import { groupsDialog } from '/groups.js';
import { moveFlow } from '/moveflow.js';
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
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts')?.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}
const copy = async (text) => { try { await navigator.clipboard.writeText(text); say('Copié.'); } catch (e) { say(e.message, 'error'); } };

let timer = null;
const ui = { sub: 'moteur', kind: 'all', small: false, profile: 'normal', shelve: false, chat: [], sending: false, scanSel: null, scanJob: null };
// Mode extra-light (avec perte) : avertissement permanent + fabrication du fichier Q3 à la demande.
function xlBox(eng) {
  if (!eng.lossy) return '';
  const x = eng.extralight || {};
  let act = '';
  if (x.running) act = `<p>⏳ ${esc(x.message)}</p>`;
  else if (x.error) act = `<p style="color:var(--danger)">${esc(x.error)}</p>`;
  else if (x.done) act = `<p>✔ ${esc(x.message)}</p>`;
  if (ui.xlAsset && !x.running && !x.done) act += `<p>La version extra-light de ce modèle n’existe pas encore.</p><button class="btn danger" id="xl-build">Fabriquer la version extra-light (≈ ${bytes(ui.xlEst || 0)}, quelques minutes)</button>`;
  return `<div class="xl-box"><b>⚠ Faster but unstable.</b> Ce mode utilise une version Q3 du modèle, <b>avec perte</b> : plus rapide et plus légère en VRAM, mais le texte s’écarte de la version normale et le code est nettement moins fiable. Plutôt pour discuter que pour coder.${act}</div>`;
}
const SUBS = [['moteur', '⚡ Moteur'], ['reglages', '🎛 Réglages'], ['connexions', '🔌 Connexions']];

function frame(inner) {
  return `<div class="subtabs">${SUBS.map(([k, l]) => `<button class="btn ${ui.sub === k ? 'primary' : ''}" data-sub="${k}">${l}</button>`).join('')}</div>${inner}`;
}
function bindSubs() {
  document.querySelectorAll('#engine-body [data-sub]').forEach((b) => { b.onclick = () => { ui.sub = b.dataset.sub; tick(); }; });
}

// ------------------------------------------------------------------ Moteur
async function viewMoteur() {
  const [eng, list, roots, shelf, scanT, jobsR] = await Promise.all([call('/api/engine'), call('/api/assets?limit=5000&sort=size'), call('/api/roots'), call('/api/shelf'), call('/api/scan/targets').catch(() => ({ targets: [] })), call('/api/jobs').catch(() => ({ jobs: [] }))]);
  if (eng.lossy) ui.profile = 'extralight'; else if (ui.profile === 'extralight') ui.profile = 'normal';
  const links = (await call('/api/engine/links').catch(() => ({ links: {} }))).links || {};
  const recent = (await call('/api/models/recent').catch(() => ({ recent: {} }))).recent || {}; // id -> date du dernier rangement / invocation / usage
  const moving = (jobsR.jobs || jobsR).filter((j) => (j.type === 'transfer' || j.type === 'bulk-transfer') && j.status === 'running');
  const targets = scanT.targets || [];
  let scanJob = null;
  if (ui.scanJob) { try { scanJob = await call(`/api/jobs/${ui.scanJob}`); } catch { ui.scanJob = null; } }
  const scanRunning = !!scanJob && !['done', 'error', 'cancelled'].includes(scanJob.status);
  const rootList = roots.roots || roots;
  // par défaut : seulement les disques qui portent déjà une racine du catalogue (pas les disques durs lents ni les clés USB)
  if (!ui.scanSel) { const vols = new Set(rootList.map((r) => String(r.volume || '').toLowerCase())); ui.scanSel = new Set(targets.filter((t) => t.kind === 'volume' && vols.has(t.path.slice(0, 2).toLowerCase())).map((t) => t.path)); }
  const hasActive = rootList.some((r) => r.role === 'active');
  const busy = eng.summon && !['idle', 'done', 'error'].includes(eng.summon.step);
  // un mmproj est le module d'image d'un modèle, pas un modèle à lancer ; LoRA, VAE, encodeurs… sont des fichiers d'accompagnement (masqués par défaut)
  const SMALL = new Set(['lora', 'controlnet', 'vae', 'embedding', 'upscaler', 'clip', 'ipadapter', 'faceid']);
  const isLlm = (a) => /\.gguf$/i.test(a.file_name) && !['checkpoint', 'clip'].includes(a.category);
  const everything = (list.items || []).filter((a) => !/mmproj/i.test(a.file_name));
  const nSmall = everything.filter((a) => SMALL.has(a.category)).length;
  const kindOk = (a) => ui.kind === 'llm' ? isLlm(a) : ui.kind === 'other' ? !isLlm(a) : true;
  const items = everything.filter((a) => (ui.small || !SMALL.has(a.category)) && kindOk(a));
  const byRecent = (x, y) => (Date.parse(recent[y.id] || 0) || 0) - (Date.parse(recent[x.id] || 0) || 0) || (y.size_bytes || 0) - (x.size_bytes || 0); // le plus récemment rangé / invoqué / utilisé en premier
  const lossy = (a) => (/\.gguf$/i.test(a.file_name) && (a.file_name.replace(/\.gguf$/i, '').match(/(?:^|[-_.])(I?Q[23](?:_[A-Z0-9]+)*)$/i) || [])[1]) || '';
  const kindBadge = (a) => (lossy(a) ? `<span class="badge xl" title="Version allégée AVEC PERTE (${lossy(a).toUpperCase()}) : plus rapide et légère, texte moins fiable. C'est elle qu'utilise le mode extra-light.">⚠ EXTRA-LIGHT · ${lossy(a).toUpperCase()}</span> ` : '') + (isLlm(a) ? '<span class="badge soft">LLM</span>' : SMALL.has(a.category) ? '<span class="badge soft">accompagnement</span>' : '<span class="badge soft">image · vidéo · autre</span>');
  ui.loading = !!eng.loading; ui.info = eng.profileInfo;
  if (!ui.profileSet && eng.defaultProfile) { ui.profile = eng.defaultProfile; ui.profileSet = true; } // le mode part du dernier choisi
  const state = eng.loading ? '<span class="badge soft">◌ chargement du modèle…</span>' : eng.responding ? '<span class="badge soft" style="color:var(--accent)">● en service</span>'
    : eng.running ? '<span class="badge soft">◌ démarrage…</span>' : '<span class="badge soft">○ arrêté</span>';
  const mmss = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const loadBar = eng.loading ? `<div style="margin:10px 0"><div class="w-barrow"><span>${eng.current?.phase === 'warm' ? 'Préchauffage du prompt (la 1re fois ≈ 20 s)' : 'Chargement du modèle en mémoire'}</span><span class="muted">${mmss(eng.loadElapsed)} / ≈ ${mmss(eng.loadEstimate)}${eng.loadElapsed > eng.loadEstimate ? ' · plus long que prévu, toujours en cours' : ''}</span></div><div class="w-track"><div class="w-fill" style="width:${Math.round(Math.min(0.95, eng.loadElapsed / Math.max(eng.loadEstimate, 1)) * 100)}%"></div></div></div>` : '';
  const cur = eng.current ? `<code>${esc(eng.current.path)}</code> · profil <b>${esc(eng.current.profile)}</b>` : '<span class="muted">aucun modèle chargé</span>';
  const stores = rootList.filter((r) => r.role === 'store');
  const shelfBusy = shelf.state && !['idle', 'done', 'error'].includes(shelf.state.step);
  const linkChips = (l, hot) => {
    if (!l) return '';
    const out = [];
    for (const n of l.needs || []) {
      const cls = n.where === 'missing' ? 'cf-bad' : n.where === 'apart' ? 'cf-warn' : 'cf-ok';
      const txt = n.where === 'missing' ? `a besoin de ${n.file_name} — INTROUVABLE` : n.where === 'apart' ? `a besoin de ${n.file_name} — rangé ailleurs (${n.location?.root || '?'})` : `avec son ${n.role}`;
      out.push(`<span class="badge ${cls}" title="${esc(`${n.role} : ${n.file_name}`)}">${n.where === 'together' ? '🔗' : '⚠'} ${esc(txt)}</span>`);
    }
    const o = l.origin;
    if (!hot && o && o.state !== 'none') {
      const cls = o.state === 'ok' ? 'cf-ok' : 'cf-bad';
      out.push(`<span class="badge ${cls}" title="${esc(o.path || '')}">${o.state === 'ok' ? '↩ vient de' : o.state === 'gone' ? '⚠ repo d\'origine disparu :' : '⚠ n\'est plus un repo actif :'} ${esc(o.rootName || '')}</span>`);
    }
    return out.length ? `<div class="mc-meta">${out.join(' ')}</div>` : '';
  };
  const dirOf = (a) => a.abs_path.slice(0, Math.max(0, a.abs_path.length - a.file_name.length)).replace(/[\\/]$/, '');
  const info = (a, hot) => `${famBadge(a.title || a.file_name)} <b>${esc(a.title || a.file_name)}</b>
      <div class="muted small">${esc(a.file_name)}</div>
      <div class="mc-meta"><b>${bytes(a.size_bytes)}</b> ${kindBadge(a)} <span class="badge ${hot ? '' : 'soft'}">${hot ? '🔥' : '❄'} ${esc(a.root_name || '?')}</span> ${a.volume ? `<span class="badge soft">${esc(a.volume)}</span>` : ''}</div>
      <div class="muted small mc-path" title="${esc(a.abs_path)}">${esc(dirOf(a))}</div>${linkChips(links[a.id], hot)}`;
  const activeItems = items.filter((a) => a.root_role === 'active').sort(byRecent);
  const stockItems = items.filter((a) => a.root_role !== 'active').sort(byRecent);
  const activeCards = activeItems.map((a) => {
    const isCur = eng.current && eng.current.assetId === a.id;
    return `<div class="mcard"><div class="mc-info">${info(a, true)}</div><div class="mc-act">
      ${isCur ? '<span class="muted small">chargé</span>' : `${isLlm(a) ? `<button class="btn primary" data-summon="${a.id}" data-hot="${a.root_id}" ${busy ? 'disabled' : ''}>Lancer</button>` : ''}
      <button class="btn" data-shelve="${a.id}" data-size="${a.size_bytes}" data-name="${esc(a.title || a.file_name)}" title="Envoie le modèle dans un repo de stockage (déplacement vérifié)">Ranger →</button>`}</div></div>`;
  }).join('');
  const stockCards = stockItems.map((a) => `<div class="mcard"><div class="mc-act mc-front"><button class="btn primary" data-invoke="${a.id}" data-size="${a.size_bytes}" data-name="${esc(a.title || a.file_name)}" title="Rapatrie le modèle dans un repo actif">← Invoquer</button></div><div class="mc-info">${info(a, false)}</div></div>`).join('');
  const stockBytes = stockItems.reduce((n, a) => n + (a.size_bytes || 0), 0);
  const repoCard = (role, id) => {
    const m = ROLE[role]; const list = rootList.filter((r) => r.role === role);
    const vols = new Map(list.map((r) => [r.volume || r.path, r.free])); // un disque compté une fois
    const free = [...vols.values()].reduce((s, f) => s + (f || 0), 0);
    const sub = list.length ? `${list.length} dossier${list.length > 1 ? 's' : ''} · ${bytes(free)} libres` : m.hint;
    return `<button class="repo-card ${list.length ? 'set' : ''}" id="${id}" title="Cliquer pour définir les dossiers"><span class="repo-ico">${m.ico}</span><span class="repo-title">${role === 'active' ? 'REPO ACTIF' : 'REPO DE STOCKAGE'}</span>
      <span class="repo-sub">${esc(sub)}</span>${list.length ? `<span class="repo-names">${list.slice(0, 3).map((r) => esc(r.name)).join(' · ')}${list.length > 3 ? ' …' : ''}</span>` : ''}</button>`;
  };
  // le rafraîchissement automatique reconstruit la page : on garde la position de défilement des deux listes et de la page
  const keepScroll = [...document.querySelectorAll('.mcol-body')].map((e) => e.scrollTop);
  const sp = []; for (let n = $('#engine-body'); n; n = n.parentElement) if (n.scrollTop) sp.push([n, n.scrollTop]);
  $('#engine-body').innerHTML = frame(`
    <div class="engine-top"><div class="panel"><div class="panel-head"><h2>Moteur WeightStream ${state}</h2>
      <p class="muted">API compatible OpenAI sur <code>${esc(eng.endpoint)}</code>. ${eng.exeFound ? '' : '<b style="color:var(--danger)">ws_npc_server introuvable : ' + esc(eng.exe) + ' (onglet Réglages)</b>'}</p></div>
      <p>${cur}</p>${loadBar}
      <div class="toolbar" style="margin-top:10px">
        ${modeControlsHtml(eng, ui.profile, { where: 'eng-where', how: 'eng-profile' })}
        <span class="muted small" id="eng-profile-help" style="flex-basis:100%">${esc([eng.profileInfo?.[ui.profile]?.desc, eng.profileInfo?.[ui.profile]?.conso].filter(Boolean).join(' · '))}</span>
        <span class="grow"></span><label class="w-sel" title="Au prochain démarrage de PAIZ, le dernier modèle utilisé se charge tout seul, dès le lancement"><input type="checkbox" id="eng-auto" ${eng.autoload ? 'checked' : ''}> Charger au démarrage</label><button class="btn" id="eng-stop" ${eng.running ? '' : 'disabled'}>■ Arrêter</button></div>
      ${xlBox(eng)}
      ${busy ? `<p class="muted" style="margin-top:8px">⏳ ${esc(eng.summon.message)}</p>` : ''}
      ${eng.summon?.step === 'error' ? `<p style="color:var(--danger);margin-top:8px">${esc(eng.summon.error)}</p>` : ''}</div>
      ${repoCard('active', 'repo-active')}${repoCard('store', 'repo-store')}</div>
    ${moving.length ? `<div class="panel mc-moving">${moving.map((j) => { const p = j.progress || {}; const pct = p.totalBytes ? Math.round(100 * p.bytes / p.totalBytes) : null; return `<div class="small">⏳ ${esc(j.label)}${pct != null ? ` — <b>${pct} %</b>` : ''}</div>`; }).join('')}</div>` : ''}
    ${hasActive ? '' : '<p style="color:var(--danger)"><b>Aucun repo actif :</b> clique sur la case REPO ACTIF pour définir ton SSD de travail.</p>'}
    <div class="toolbar" style="margin:4px 0 8px"><span class="muted small">Afficher :</span>${[['all', 'Tout'], ['llm', 'LLM (le moteur sait les lancer)'], ['other', 'Image · vidéo · autres']].map(([v, l]) => `<button class="btn small ${v === ui.kind ? 'primary' : ''}" data-kind="${v}">${l}</button>`).join('')}<label class="check" style="margin-left:10px"><input type="checkbox" id="show-small" ${ui.small ? 'checked' : ''}> LoRA, VAE, encodeurs… (${nSmall})</label><span class="muted small">Les plus récemment rangés ou invoqués sont en haut.</span></div>
    <div class="models-cols" id="models-cols">
      <div class="panel mcol"><div class="panel-head"><h2>🔥 Modèles actifs <span class="muted small">${activeItems.length} · sur le SSD de travail</span> <span class="mc-head-btns"><button class="btn small" id="conf-save" title="Sauvegarder la liste des modèles actifs">💾 Save conf</button><button class="btn small" id="conf-load" title="Recharger une configuration sauvegardée">📂 Load conf</button><button class="btn small" id="conf-groups" title="Ranger ou rappeler d'un coup tous les modèles d'un projet">📦 Groupes</button></span></h2></div>
        <div class="mcol-body">${activeCards || '<p class="muted">Aucun modèle dans un repo actif. Invoque-en un depuis le stock, ou lance un scan.</p>'}</div></div>
      <div class="panel mcol"><div class="panel-head"><h2>❄ Modèles en stock <span class="muted small">${stockItems.length} · ${bytes(stockBytes)}</span></h2></div>
        <div class="mcol-body">${stockCards || '<p class="muted">Aucun modèle en stock. « Ranger → » envoie un modèle actif dans un repo de stockage.</p>'}</div></div>
    </div>
    <div class="panel"><div class="panel-head"><h2>Scanner les disques</h2></div>
      <div class="toolbar" style="flex-wrap:wrap;gap:10px">${targets.map((t) => `<label class="check"><input type="checkbox" data-scan-t="${esc(t.path)}" ${ui.scanSel.has(t.path) ? 'checked' : ''} ${scanRunning ? 'disabled' : ''}> ${esc(t.path)}${t.kind === 'cache' ? ' <span class="muted small">(cache)</span>' : ''}</label>`).join('') || '<span class="muted">Aucun disque détecté.</span>'}
        <span class="grow"></span><button class="btn primary" id="scan-go" ${scanRunning || !ui.scanSel.size ? 'disabled' : ''}>🔍 Scanner la sélection</button>${scanRunning ? '<button class="btn" id="scan-stop">■ Arrêter</button>' : ''}</div>
      ${scanJob ? `<p class="muted small" style="margin-top:8px">${scanRunning ? '⏳ ' : scanJob.status === 'error' ? '⚠ ' : '✔ '}${esc(scanJob.label || "Scan")} — ${esc(scanJob.progress?.volume || '')} ${scanJob.progress?.found != null ? `· ${scanJob.progress.found} modèle(s) trouvé(s)` : ''} ${scanJob.status === 'error' ? esc(scanJob.error || '') : ''}</p>` : ''}</div>
    `);
  document.querySelectorAll('.mcol-body').forEach((e, i) => { e.scrollTop = keepScroll[i] || 0; });
  sp.forEach(([n, t]) => { n.scrollTop = t; });
  bindSubs();
  wireModeControls(eng, ui.profile, { where: 'eng-where', how: 'eng-profile' }, (p) => { ui.profile = p; const h = $('#eng-profile-help'); if (h) h.textContent = [ui.info?.[p]?.desc, ui.info?.[p]?.conso].filter(Boolean).join(' · '); });
  document.querySelectorAll('[data-scan-t]').forEach((c) => { c.onchange = () => { if (c.checked) ui.scanSel.add(c.dataset.scanT); else ui.scanSel.delete(c.dataset.scanT); const go = $('#scan-go'); if (go) go.disabled = !ui.scanSel.size; }; });
  if ($('#scan-go')) $('#scan-go').onclick = async () => {
    try { const j = await call('/api/scan/disks', 'POST', { only: [...ui.scanSel] }); ui.scanJob = j.id; } catch (e) { say(e.message, 'error'); }
    tick();
  };
  if ($('#scan-stop')) $('#scan-stop').onclick = async () => { try { await call(`/api/jobs/${ui.scanJob}/cancel`, 'POST'); } catch (e) { say(e.message, 'error'); } tick(); };
  $('#eng-stop').onclick = async () => { await call('/api/engine/stop', 'POST'); tick(); };
  if ($('#xl-build')) $('#xl-build').onclick = async () => {
    try { await call('/api/engine/extralight/build', 'POST', { assetId: ui.xlAsset, confirm: true }); ui.xlAsset = null; } catch (e) { say(e.message, 'error'); }
    tick();
  };
  if ($('#eng-auto')) $('#eng-auto').onchange = async (e) => { try { await call('/api/engine/settings', 'POST', { autoload: e.target.checked }); say(e.target.checked ? 'Le dernier modèle se chargera au démarrage de PAIZ.' : 'Chargement automatique désactivé.'); } catch (er) { say(er.message, 'error'); } tick(); };
  document.querySelectorAll('[data-kind]').forEach((b) => { b.onclick = () => { ui.kind = b.dataset.kind; tick(); }; });
  if ($('#show-small')) $('#show-small').onchange = (e) => { ui.small = e.target.checked; tick(); };
  document.querySelectorAll('[data-invoke]').forEach((b) => { b.onclick = () => moveFlow({ id: Number(b.dataset.invoke), name: b.dataset.name, size: Number(b.dataset.size), role: 'active', onDone: tick }); });
  $('#conf-save').onclick = () => saveConfDialog(activeItems.filter(isLlm), tick);
  $('#conf-load').onclick = () => loadConfDialog(tick);
  $('#conf-groups').onclick = () => groupsDialog(tick);
  $('#repo-active').onclick = () => reposDialog('active', tick);
  $('#repo-store').onclick = () => reposDialog('store', tick);
  document.querySelectorAll('[data-shelve]').forEach((b) => { b.onclick = () => moveFlow({ id: Number(b.dataset.shelve), name: b.dataset.name, size: Number(b.dataset.size), role: 'store', onDone: tick }); });
  document.querySelectorAll('[data-summon]').forEach((b) => {
    b.onclick = async () => {
      const a = items.find((x) => x.id === Number(b.dataset.summon));
      let activeRoot = b.dataset.hot ? Number(b.dataset.hot) : null; // déjà sur un SSD de travail : on lance depuis son repo, sans le déplacer
      if (activeRoot == null) {
        activeRoot = await pickRepo({ role: 'active', title: `Invoquer « ${a?.title || a?.file_name || 'le modèle'} »`, size: a?.size_bytes || 0, confirmLabel: 'Invoquer ici',
          intro: `Le modèle (${bytes(a?.size_bytes || 0)}) est copié (copie vérifiée) dans le repo actif choisi, puis le moteur démarre avec le profil « ${esc(ui.profile)} ».` });
        if (activeRoot == null) return;
      }
      try { await call('/api/engine/summon', 'POST', { assetId: Number(b.dataset.summon), profile: lossy(a) ? 'extralight' : ui.profile, activeRoot }); } catch (e) { say(e.message, 'error'); }
      tick();
    };
  });
}

// ------------------------------------------------------------------ Réglages
async function viewReglages() {
  const s = await call('/api/engine/settings'); const eng = await call('/api/engine');
  $('#engine-body').innerHTML = frame(`
    <div class="panel"><div class="panel-head"><h2>Réglages du moteur</h2>
      <p class="muted">Pris en compte au prochain lancement d'un modèle${eng.running ? ' (le moteur actuel garde ses réglages jusqu\'à son redémarrage)' : ''}.</p></div>
      <div class="form-grid">
        <label>Profil par défaut<select id="s-profile" class="input">${eng.profiles.map((p) => `<option ${p === s.profile ? 'selected' : ''}>${p}</option>`).join('')}</select>
          <span class="muted small">eco : le moins de RAM/VRAM, le plus lent · dialogue : sobre (Gemma ≈ 13 tok/s, ≈ 7,4 Go de VRAM) · vif : ≈ 22 tok/s · rapide : ≈ 43 tok/s (≈ 10 Go de VRAM) · confort : plus rapide · tâche de fond : géants en arrière-plan · cpu : aucun expert en VRAM · partage / fond : caches calculés d'après la RAM et la VRAM réellement libres, puis régulés pendant la génération (partage laisse de la place aux autres programmes) · paliers : taille du cache choisie au début de chaque message d'après la RAM libre, puis fixe pendant la génération</span></label>
        <label>Outils des agents de code (OpenCode…)<select id="s-tools" class="input">${[['auto', 'Auto : seulement les outils que la tâche réclame'], ['focus', 'Focus code : lire / modifier / chercher dans les fichiers'], ['all', 'Tous les outils : plus lent à chaque tour, à n\'activer que si besoin']].map(([v, l]) => `<option value="${v}" ${v === s.toolMode ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <span class="muted small">Chaque outil exposé au modèle est relu à chaque conversation : sur un gros modèle lent, cela se compte en minutes.</span></label>
        <label>Contexte (jetons)<input id="s-ctx" type="number" class="input" value="${s.ctx}" min="512" step="1024">
          <span class="muted small">16384 ou plus pour un agent de code ; chaque 1000 jetons coûte du cache KV.</span></label>
        <label>Conversations en mémoire (slots)<input id="s-slots" type="number" class="input" value="${s.slots}" min="1" max="16">
          <span class="muted small">1 recommandé : chaque conversation en plus garde ~2 Go de VRAM. Une tâche de fond en ouvre une seconde toute seule, le temps qu'elle tourne.</span></label>
        <label>Précision du cache KV<select id="s-kv" class="input">${[['', 'défaut (f16)'], ['q8_0', 'q8_0 (−47 %)'], ['q4_0', 'q4_0 (−72 %, le texte change)']].map(([v, l]) => `<option value="${v}" ${v === s.kvType ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="chk"><span><input id="s-auto" type="checkbox" ${s.autoload ? 'checked' : ''}> Charger automatiquement le dernier modèle utilisé au démarrage de PAIZ</span>
          <span class="muted small">Le moteur se lance dès l'ouverture de PAIZ (si la mémoire libre le permet) : le modèle est prêt quand tu arrives. Même réglage que sur l'écran Travail.</span></label>
        <label>Port de l'API<input id="s-port" type="number" class="input" value="${s.port}" min="1024" max="65535">
          <span class="muted small">8770 est aussi utilisé par d'autres applis : mets un autre port pour utiliser les deux.</span></label>
        <label>Options supplémentaires<input id="s-extra" class="input" value="${esc(s.extraArgs)}" placeholder="ex. --ubatch 512"></label>
        <label>Exécutable ws_npc_server<input id="s-exe" class="input" value="${esc(s.exe)}"></label>
        <label>Dossier WeightStream<input id="s-dir" class="input" value="${esc(s.dir)}"></label></div>
      <div class="toolbar" style="margin-top:12px"><button class="btn primary" id="s-save">Enregistrer</button></div></div>`);
  bindSubs();
  $('#s-save').onclick = async () => {
    try {
      await call('/api/engine/settings', 'POST', { profile: $('#s-profile').value, ctx: $('#s-ctx').value, slots: $('#s-slots').value, kvType: $('#s-kv').value, toolMode: $('#s-tools').value, port: $('#s-port').value, extraArgs: $('#s-extra').value, exe: $('#s-exe').value, dir: $('#s-dir').value, autoload: $('#s-auto').checked });
      say('Réglages enregistrés.'); ui.profile = $('#s-profile').value;
    } catch (e) { say(e.message, 'error'); }
  };
}

// ------------------------------------------------------------------ Connexions
function snippets(url, model) {
  return [
    ['Client OpenAI quelconque', 'Mets ces trois valeurs dans « fournisseur compatible OpenAI / personnalisé » (la clé API est ignorée mais souvent obligatoire).',
      `URL de base : ${url}\nClé API     : sk-local\nModèle      : ${model}`],
    ['curl', 'Test rapide en ligne de commande.',
      `curl ${url}/chat/completions -H "Content-Type: application/json" -d '{"model":"${model}","messages":[{"role":"user","content":"Bonjour"}]}'`],
    ['Python (openai)', 'Fonctionne avec la bibliothèque officielle, y compris les appels d\'outils.',
      `from openai import OpenAI\nclient = OpenAI(base_url="${url}", api_key="sk-local")\nr = client.chat.completions.create(model="${model}", messages=[{"role": "user", "content": "Bonjour"}])\nprint(r.choices[0].message.content)`],
    ['Continue (VS Code / JetBrains)', 'À ajouter dans config.yaml.',
      `models:\n  - name: WeightStream\n    provider: openai\n    model: ${model}\n    apiBase: ${url}\n    apiKey: sk-local`],
    ['Open WebUI', 'Réglages admin → Connexions → OpenAI → « + ».', `URL : ${url}\nClé : sk-local`],
    ['Cline / Roo Code', 'Fournisseur « OpenAI Compatible ».', `Base URL : ${url}\nAPI Key  : sk-local\nModel ID : ${model}`],
  ];
}
async function viewConnexions() {
  const [eng, oc] = await Promise.all([call('/api/engine'), call('/api/engine/opencode/status')]);
  const model = eng.current ? eng.current.path.split(/[\\/]/).pop().replace(/\.gguf$/i, '') : 'local';
  const cards = snippets(eng.endpoint, model).map(([t, d, code], i) => `<div class="panel"><div class="panel-head"><h2>${esc(t)}</h2><p class="muted">${esc(d)}</p></div>
    <pre class="small" style="white-space:pre-wrap">${esc(code)}</pre><button class="btn" data-copy="${i}">Copier</button></div>`).join('');
  $('#engine-body').innerHTML = frame(`
    <div class="panel"><div class="panel-head"><h2>OpenCode</h2>
      <p class="muted">Ajoute WeightStream comme fournisseur dans <code>${esc(oc.file)}</code> (sauvegarde automatique, tes autres fournisseurs ne sont pas touchés). Relance OpenCode ensuite.</p></div>
      <p>${oc.connected ? '<span class="badge soft" style="color:var(--accent)">✔ branché</span>' : '<span class="badge soft">pas encore branché</span>'} ${oc.error ? `<span style="color:var(--danger)">${esc(oc.error)}</span>` : ''}
        <span class="muted small"> · modèle déclaré : <code>${esc(model)}</code> ${eng.responding ? '' : '(moteur arrêté : relance « connecter » une fois un modèle lancé)'}</span></p>
      <div class="toolbar" style="margin-top:10px"><button class="btn primary" id="oc-connect">${oc.connected ? 'Mettre à jour le fournisseur' : 'Brancher OpenCode'}</button>
        <button class="btn" id="oc-copy">Copier la config JSON</button></div></div>
    <div class="panel"><div class="panel-head"><h2>Coder avec OpenCode, branché sur PAIZ</h2>
      <p class="muted">Ouvre OpenCode dans une console, sur le dossier de ton choix, déjà réglé sur WeightStream (config isolée : ta config OpenCode n'est pas modifiée). Il lit et modifie les fichiers de ce dossier. Le moteur doit être lancé.</p></div>
      <div class="toolbar"><input id="oc-dir" class="input grow" placeholder="Dossier du projet, ex. D:/005-GIT/mon-projet" value="${esc(localStorage.getItem('paiz.ocdir') || '')}"><button class="btn primary" id="oc-launch">Ouvrir OpenCode</button></div></div>
    <p class="muted small" style="margin:6px 2px">Tous ces services parlent à la même adresse : <code>${esc(eng.endpoint)}</code>${eng.responding ? '' : ' — le moteur doit être lancé.'}</p>${cards}`);
  bindSubs();
  const snips = snippets(eng.endpoint, model);
  document.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => copy(snips[Number(b.dataset.copy)][2]); });
  $('#oc-connect').onclick = async () => {
    try { const r = await call('/api/engine/opencode/connect', 'POST'); say(`OpenCode branché (${r.model}). Relance OpenCode.${r.commentsLost ? ' Commentaires du fichier perdus (sauvegarde gardée).' : ''}`); } catch (e) { say(e.message, 'error'); }
    tick();
  };
  $('#oc-launch').onclick = async () => {
    const dir = $('#oc-dir').value.trim(); try { localStorage.setItem('paiz.ocdir', dir); } catch { /* ignore */ }
    try { const r = await call('/api/engine/opencode/launch', 'POST', { dir }); say(`OpenCode ouvert dans ${r.folder}`); } catch (e) { say(e.message, 'error'); }
  };
  $('#oc-copy').onclick = async () => { try { copy(JSON.stringify(await call('/api/engine/opencode'), null, 2)); } catch (e) { say(e.message, 'error'); } };
}

// ------------------------------------------------------------------ boucle
async function render() {
  const root = $('#view-engine');
  if (!root || !root.classList.contains('active')) return false;
  try {
    if (ui.sub === 'moteur') await viewMoteur();
    else if (ui.sub === 'reglages') await viewReglages();
    else await viewConnexions();
  } catch (e) { $('#engine-body').innerHTML = frame(`<p class="muted">Erreur : ${esc(e.message)}</p>`); bindSubs(); }
  return true;
}
// Seul l'écran « Moteur » se rafraîchit seul (les autres contiennent des champs de saisie).
function tick() {
  clearTimeout(timer);
  render().then((on) => { if (on && ui.sub === 'moteur') timer = setTimeout(tick, ui.loading ? 1000 : 3000); });
}
window.addEventListener('paiz:repos', () => { if (document.querySelector('#repo-active')) tick(); });
document.addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (t && t.dataset.view === 'engine') setTimeout(tick, 0);
  else if (t) clearTimeout(timer);
});
