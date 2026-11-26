// Onglet « Entretien » : santé des disques, chasse d'eau des caches d'applications LLM, sauvegarde des dossiers de modèles.
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
  $('#toasts')?.appendChild(el); setTimeout(() => el.remove(), 6000);
}

// Confirmation maison (pas de confirm() natif : pas fiable dans toutes les webviews)
function confirmBox({ title, html, okLabel }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = `<div class="care-modal"><div class="care-box"><h2>${esc(title)}</h2><div class="care-body">${html}</div>
      <div class="toolbar" style="justify-content:flex-end;margin-top:14px"><button class="btn" id="cb-no">Annuler</button><button class="btn danger" id="cb-yes">${esc(okLabel)}</button></div></div></div>`;
    const done = (v) => { root.innerHTML = ''; resolve(v); };
    $('#cb-no').onclick = () => done(false); $('#cb-yes').onclick = () => done(true);
    root.querySelector('.care-modal').onclick = (e) => { if (e.target.classList.contains('care-modal')) done(false); };
  });
}

let data = { health: null, caches: null, left: null, strays: null, roots: [], backup: null };
let timer = null;
let loading = { health: false, caches: false, left: false };
const KIND = { partial: ['⏸ téléchargement interrompu', 'soft'], stale: ['🗄 ancienne sauvegarde ?', 'soft'], unknown: ['❓ cache inconnu', 'soft'], dupe: ['⧉ doublon dans l\'appli', ''] };

function straysHtml() {
  const L = data.strays; if (!L) return '<p class="muted">Recherche…</p>';
  if (!L.length) return '<p class="muted">Aucun moteur égaré. 🎉</p>';
  const age = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 90 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} j`; };
  return `<table class="assets-table"><thead><tr><th>Programme</th><th>Depuis</th><th class="num">RAM</th><th></th></tr></thead><tbody>${L.map((x) => `<tr>
    <td><b>${esc(x.name)}</b> <span class="muted small">#${x.pid}</span>${x.parentAlive ? '' : ' <span class="badge soft">lanceur disparu</span>'}<div class="muted small"><code>${esc(x.command)}</code></div></td>
    <td class="small">${age(x.startedAt)}</td><td class="num">${x.mb} Mo</td><td><button class="btn danger small" data-stray="${x.pid}">Arrêter</button></td></tr>`).join('')}</tbody></table>`;
}

function leftHtml() {
  if (loading.left && !data.left) return '<p class="muted">Recherche des restes oubliés…</p>';
  const L = data.left; if (!L) return '';
  if (!L.length) return '<p class="muted">Aucun reste oublié. 🎉</p>';
  const tot = L.reduce((n, x) => n + x.size, 0);
  return `<div class="flush-bar"><div><b>${L.length}</b> élément(s) · <b>${bytes(tot)}</b> peuvent être récupérés. Rien n'est coché d'avance.</div>
    <div class="toolbar"><button class="btn small" data-lsel="all">Tout cocher</button><button class="btn small" data-lsel="none">Tout décocher</button>
    <button class="btn" data-lrm="bin" title="Corbeille Windows : récupérable, la place revient en la vidant">→ corbeille</button>
    <button class="btn danger" data-lrm="erase" title="Effacement direct, place rendue tout de suite">Effacer</button></div></div>
    <div class="table-scroll" style="max-height:420px"><table class="assets-table"><thead><tr><th></th><th>Élément</th><th>Type</th><th>Dernière modification</th><th class="num">Taille</th></tr></thead><tbody>${L.map((x) => `<tr><td><input type="checkbox" class="left-ck" data-id="${esc(x.id)}"></td>
      <td><b>${esc(x.label)}</b><div class="muted small"><code>${esc(x.path)}</code></div><div class="muted small">${esc(x.note)}</div></td>
      <td><span class="badge ${KIND[x.kind]?.[1] || ''}">${KIND[x.kind]?.[0] || esc(x.kind)}</span></td><td class="small">${x.mtime ? new Date(x.mtime).toLocaleDateString('fr-FR') : '—'}</td><td class="num">${bytes(x.size)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---- Suivi des modèles : usage, origine, ce qui est vieux ou jamais utilisé
const ST = { star: ['⭐ étoile', '#fbbf24'], actif: ['● actif', 'var(--accent)'], ancien: ['◌ ancien', '#fb923c'], jamais: ['○ jamais utilisé', '#f87171'], nouveau: ['✦ nouveau', 'var(--muted)'] };
const UF = [['all', 'Tous'], ['star', '⭐ Étoiles'], ['actif', 'Actifs'], ['ancien', 'Anciens'], ['jamais', 'Jamais utilisés'], ['nouveau', 'Nouveaux']];
const ago = (iso) => { if (!iso) return '—'; const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000); return d <= 0 ? 'aujourd’hui' : d === 1 ? 'hier' : d < 60 ? `il y a ${d} j` : `il y a ${Math.round(d / 30)} mois`; };
function usageHtml() {
  const U = data.usage; if (!U) return '<p class="muted">Lecture du catalogue…</p>';
  const sm = U.summary; const f = data.ufilter || 'all';
  if (!sm.total) return '<p class="muted">Aucun modèle .gguf dans le catalogue. Ajoute une racine dans « Model Dispenser » puis scanne-la.</p>';
  const rows = U.rows.filter((r) => f === 'all' || r.status === f).sort((a, b) => b.size_bytes - a.size_bytes);
  const gb = (n) => bytes(n);
  return `<div class="muted small" style="margin-bottom:8px">Suivi depuis le <b>${new Date(U.trackingSince).toLocaleDateString('fr-FR')}</b> · ${sm.total} modèle(s) : ⭐ ${sm.star} · actifs ${sm.actif} · anciens ${sm.ancien} · jamais utilisés ${sm.jamais} · nouveaux ${sm.nouveau}.
      ${sm.reclaimCount ? `<br><b>${sm.reclaimCount}</b> modèle(s) inutilisés sur tes disques actifs occupent <b>${gb(sm.reclaimBytes)}</b> : candidats à ranger à l’écurie (« Model Dispenser » → déplacer).` : ''}</div>
    <div class="toolbar" style="margin-bottom:8px">${UF.map(([v, l]) => `<button class="btn small ${v === f ? 'primary' : ''}" data-uf="${v}">${l}</button>`).join('')}</div>
    <div class="table-scroll" style="max-height:460px"><table class="assets-table"><thead><tr><th>Modèle</th><th class="num">Taille</th><th>Où</th><th>Dernier usage</th><th class="num">Fois</th><th>Programmes</th><th>Origine</th><th>Statut</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><b>${esc(r.title)}</b>${r.title !== r.file_name ? `<div class="muted small"><code>${esc(r.file_name)}</code></div>` : ''}</td>
      <td class="num">${gb(r.size_bytes)}</td><td class="small">${esc(r.root || '—')} <span class="muted">${esc({ active: 'prêts à lancer', store: 'réserve', external: 'externe' }[r.role] || r.role || '')}</span></td>
      <td class="small">${r.lastUse ? `${ago(r.lastUse)}<div class="muted">${new Date(r.lastUse).toLocaleDateString('fr-FR')}</div>` : '<span class="muted">jamais</span>'}</td>
      <td class="num">${r.uses}</td>
      <td class="small">${r.programs.length ? r.programs.map((p) => `${esc(p.name)} ×${p.n}`).join('<br>') : '<span class="muted">—</span>'}</td>
      <td class="small">${r.source ? `${esc(r.source.repo)}<div class="muted">${r.source.downloadedAt ? `le ${new Date(r.source.downloadedAt).toLocaleDateString('fr-FR')}` : esc(r.source.how)}</div>` : '<span class="muted">inconnue</span>'}</td>
      <td class="small" style="color:${ST[r.status][1]};white-space:nowrap">${ST[r.status][0]}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">Aucun modèle dans cette catégorie.</td></tr>'}
    </tbody></table></div>
    <p class="muted small" style="margin-top:6px">PAIZ ne voit que ce qui passe par lui (son moteur et son relais /v1) : un modèle « jamais utilisé » l’est peut-être depuis un autre programme. Un modèle est « ancien » après ${U.thresholds.oldDays} jours sans usage, « jamais utilisé » après ${U.thresholds.graceDays} jours de suivi, « étoile » à ${U.thresholds.starMin} usages ou plus récents.</p>`;
}
async function loadUsage() {
  try { data.usage = await call('/api/usage/models'); } catch (e) { data.usage = null; say(e.message, 'error'); }
  paint();
}

const LEVEL = { ok: ['✔ en bonne santé', 'var(--accent)'], warn: ['⚠ à surveiller', '#fbbf24'], danger: ['✖ en danger', 'var(--danger)'] };

function healthHtml() {
  if (loading.health && !data.health) return '<p class="muted">Lecture des disques…</p>';
  const h = data.health;
  if (!h) return '';
  if (!h.supported) return '<p class="muted">Bilan de santé disponible sous Windows uniquement.</p>';
  if (h.error) return `<p style="color:var(--danger)">${esc(h.error)}</p>`;
  return h.disks.map((d) => {
    const [lab, col] = LEVEL[d.level] || LEVEL.ok;
    const mine = data.roots.filter((r) => d.letters.some((l) => (r.volume || '').toUpperCase().startsWith(l.toUpperCase())));
    const alert = d.level !== 'ok' && mine.length ? `<p style="color:${col};margin-top:6px">Attention : ${mine.map((r) => '« ' + esc(r.name) + ' »').join(', ')} (PAIZ) ${mine.length > 1 ? 'sont' : 'est'} stocké${mine.length > 1 ? 's' : ''} sur ce disque.</p>` : '';
    const stat = (k, v) => (v == null ? '' : `<span class="badge soft">${k} ${esc(v)}</span> `);
    return `<div class="disk-card"><div><b>${esc(d.name)}</b> <span class="muted small">${esc(d.media)} · ${esc(d.bus)} · ${bytes(d.size)}</span>
      <div class="muted small">Lecteurs : ${d.letters.length ? d.letters.map((l) => l + ':').join(' ') : '—'}${mine.length ? ' · racines PAIZ : ' + mine.map((r) => esc(r.name)).join(', ') : ''}</div>
      <div style="margin-top:6px">${stat('Temp.', d.temp != null ? d.temp + ' °C' : null)}${stat('Usure', d.wear != null ? d.wear + ' %' : null)}${stat('Heures', d.hours)}${stat('Erreurs', (d.readErr || d.writeErr) ? (d.readErr || 0) + '/' + (d.writeErr || 0) : null)}</div>
      ${d.notes.map((n) => `<div class="muted small">• ${esc(n)}</div>`).join('')}${alert}</div>
      <div style="color:${col};font-weight:700;white-space:nowrap">${lab}</div></div>`;
  }).join('') || '<p class="muted">Aucun disque détecté.</p>';
}

function cachesHtml() {
  if (loading.caches && !data.caches) return '<p class="muted">Recherche des caches (peut prendre un moment sur de gros dossiers)…</p>';
  const cs = data.caches;
  if (!cs) return '';
  if (!cs.length) return '<p class="muted">Aucun cache d\'application LLM trouvé. 🎉</p>';
  const cacheTotal = cs.filter((c) => c.kind === 'cache').reduce((s, c) => s + c.size, 0);
  const libTotal = cs.filter((c) => c.kind === 'library').reduce((s, c) => s + c.size, 0);
  const rows = cs.map((c) => `<div class="cache-card"><div class="cache-head"><div><b>${esc(c.label)}</b>
      <span class="badge ${c.kind === 'cache' ? 'soft' : ''}">${c.kind === 'cache' ? 'cache' : 'bibliothèque d\'appli'}</span>
      <div class="muted small"><code>${esc(c.path)}</code></div><div class="muted small">${esc(c.note)}</div></div>
      <div style="text-align:right"><div style="font-size:18px;font-weight:700">${bytes(c.size)}</div><button class="btn" data-flush="${esc(c.id)}">Vider</button></div></div>
      <details><summary class="muted small">${c.entries.length} élément(s)</summary>${c.entries.slice(0, 40).map((e) => `<div class="cache-entry"><span>${esc(e.name)}</span><span class="muted small">${bytes(e.size)} · modifié ${new Date(e.mtime).toLocaleDateString('fr-FR')}</span>
        <button class="btn ghost" data-flush="${esc(c.id)}" data-entry="${esc(e.name)}" title="Supprimer cet élément">🗑</button></div>`).join('')}${c.entries.length > 40 ? `<div class="muted small">… et ${c.entries.length - 40} autres</div>` : ''}</details></div>`).join('');
  return `<div class="flush-bar"><div><b>${bytes(cacheTotal)}</b> de caches récupérables${libTotal ? ` · <span class="muted">${bytes(libTotal)} de bibliothèques d'applis (non inclus dans la chasse d'eau)</span>` : ''}</div>
      <button class="btn danger big" id="flush-all" ${cacheTotal ? '' : 'disabled'}>🚽 Tirer la chasse</button></div>${rows}`;
}

function backupHtml() {
  const b = data.backup;
  const opts = data.roots.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.path)}</option>`).join('');
  const state = b?.running ? '<p>⏳ Sauvegarde en cours…</p>' : b?.endedAt ? `<p>${b.code != null && b.code < 8 ? '✔ Terminée' : '✖ Échec (code ' + b.code + ')'} → <code>${esc(b.dest)}</code></p>` : '';
  return `<p class="muted small">Copie incrémentale (robocopy) d'une racine de modèles vers un autre disque : seuls les fichiers nouveaux ou modifiés sont copiés, rien n'est supprimé à destination.</p>
    <div class="toolbar"><select id="bk-root" class="input">${opts}</select><input id="bk-dest" class="input grow" placeholder="Dossier de destination, ex. F:\\Sauvegardes"><button class="btn primary" id="bk-go" ${b?.running ? 'disabled' : ''}>Sauvegarder</button></div>
    ${state}${b?.lines?.length ? `<pre class="small" style="max-height:140px;overflow:auto">${esc(b.lines.slice(-12).join('\n'))}</pre>` : ''}`;
}

function paint() {
  const body = $('#care-body'); if (!body) return;
  // ne pas écraser un champ en cours de saisie : on ne repeint que les blocs, pas les champs de sauvegarde
  const bk = { root: $('#bk-root')?.value, dest: $('#bk-dest')?.value };
  // chaque chargement asynchrone repeint tout : on garde le défilement des tableaux et de la page
  const keep = [...body.querySelectorAll('.table-scroll')].map((e) => e.scrollTop);
  const sp = []; for (let n = body; n; n = n.parentElement) if (n.scrollTop) sp.push([n, n.scrollTop]);
  body.innerHTML = `
    <div class="panel"><div class="panel-head"><h2>📊 Suivi des modèles</h2><p class="muted">Quel modèle sert, quand, par quel programme, d’où il vient, et ce qui dort sur tes disques depuis trop longtemps.</p></div><div id="care-usage">${usageHtml()}</div><div class="toolbar" style="margin-top:8px"><button class="btn" id="care-reusage">↻ Relire</button></div></div>
    <div class="panel"><div class="panel-head"><h2>🩺 Santé des disques</h2><p class="muted">État relevé par Windows (SMART / compteurs de fiabilité). Ne stocke rien d'important sur un disque « à surveiller ».</p></div>
      <div id="care-health">${healthHtml()}</div><div class="toolbar" style="margin-top:8px"><button class="btn" id="care-rehealth">↻ Relire</button></div></div>
    <div class="panel"><div class="panel-head"><h2>🚽 Chasse d'eau — caches des applications LLM</h2>
      <p class="muted">Hugging Face, PyTorch, Whisper, Coqui TTS, llama.cpp… Les applications re-téléchargent ce dont elles ont encore besoin ; Ollama, LM Studio, GPT4All et Jan sont listés à part (ce sont de vrais modèles).</p></div>
      <div id="care-caches">${cachesHtml()}</div><div class="toolbar" style="margin-top:8px"><button class="btn" id="care-recache">↻ Rescanner</button></div></div>
    <div class="panel"><div class="panel-head"><h2>🧹 Restes oubliés</h2>
      <p class="muted">Ce que les caches connus ne couvrent pas : téléchargements interrompus (<code>.tmp</code>, <code>.part</code>…) dans tes repos et dans <code>~/.cache</code>, dossiers de vieilles sauvegardes ou de caches inconnus, et fichiers <b>strictement identiques</b> dans un même repo actif. PAIZ ne choisit rien à ta place : tu coches, tu choisis corbeille ou effacement.</p></div>
      <div id="care-left">${leftHtml()}</div><div class="toolbar" style="margin-top:8px"><button class="btn" id="care-releft">↻ Rescanner</button></div></div>
    <div class="panel"><div class="panel-head"><h2>🛑 Moteurs égarés</h2>
      <p class="muted">Programmes du moteur (<code>llama-server</code>, <code>ws_npc_server</code>…) en marche mais <b>pas lancés par cette session de PAIZ</b>, par exemple un test oublié. Ils occupent de la RAM et de la VRAM. PAIZ ne les arrête jamais seul (ce peut être autre chose qui en dépend) : tu choisis.</p></div>
      <div id="care-strays">${straysHtml()}</div><div class="toolbar" style="margin-top:8px"><button class="btn" id="care-restrays">↻ Rescanner</button></div></div>
    <div class="panel"><div class="panel-head"><h2>💾 Sauvegarde des dossiers de modèles</h2></div><div id="care-backup">${backupHtml()}</div></div>`;
  if (bk.root) $('#bk-root').value = bk.root; if (bk.dest) $('#bk-dest').value = bk.dest;
  bind();
  body.querySelectorAll('.table-scroll').forEach((e, i) => { e.scrollTop = keep[i] || 0; });
  sp.forEach(([n, t]) => { n.scrollTop = t; });
}

function bind() {
  $('#care-reusage')?.addEventListener('click', loadUsage);
  document.querySelectorAll('[data-uf]').forEach((b) => { b.onclick = () => { data.ufilter = b.dataset.uf; paint(); }; });
  $('#care-rehealth').onclick = () => loadHealth(true);
  $('#care-recache').onclick = () => loadCaches(true);
  $('#care-releft').onclick = () => loadLeft(true);
  $('#care-restrays').onclick = () => loadStrays();
  document.querySelectorAll('[data-stray]').forEach((b) => {
    b.onclick = async () => {
      const x = (data.strays || []).find((y) => String(y.pid) === b.dataset.stray); if (!x) return;
      const ok = await confirmBox({ title: 'Arrêter ce moteur ?', okLabel: 'Arrêter', html: `<p><b>${esc(x.name)}</b> #${x.pid} (${x.mb} Mo)</p><p class="muted small"><code>${esc(x.command)}</code></p><p class="muted small">Le programme est stoppé immédiatement ; ce qu'il avait en mémoire est perdu.</p>` });
      if (!ok) return;
      try { await call('/api/maintenance/strays/stop', 'POST', { pid: x.pid, confirm: true }); say('Moteur arrêté.'); } catch (e) { say(e.message, 'error'); }
      loadStrays();
    };
  });
  document.querySelectorAll('[data-lsel]').forEach((b) => { b.onclick = () => document.querySelectorAll('.left-ck').forEach((c) => { c.checked = b.dataset.lsel === 'all'; }); });
  document.querySelectorAll('[data-lrm]').forEach((b) => {
    b.onclick = async () => {
      const permanent = b.dataset.lrm === 'erase';
      const sel = (data.left || []).filter((x) => [...document.querySelectorAll('.left-ck:checked')].some((c) => c.dataset.id === x.id));
      if (!sel.length) { say('Rien de coché.'); return; }
      const ok = await confirmBox({ title: permanent ? 'Effacer définitivement ?' : 'Mettre à la corbeille ?', okLabel: `${permanent ? 'Effacer' : 'Corbeille'} ${bytes(sel.reduce((n, x) => n + x.size, 0))}`,
        html: `<ul>${sel.slice(0, 14).map((x) => `<li>${esc(x.label)} <span class="muted">(${bytes(x.size)})</span><div class="muted small"><code>${esc(x.path)}</code></div></li>`).join('')}${sel.length > 14 ? `<li class="muted">… et ${sel.length - 14} autres</li>` : ''}</ul>
          <p class="muted small">${permanent ? 'Suppression définitive, sans corbeille.' : 'La place n\'est rendue qu\'en vidant la corbeille.'} Chaque suppression est notée dans le journal du ménage.</p>` });
      if (!ok) return;
      try { const r = await call('/api/maintenance/leftovers/remove', 'POST', { ids: sel.map((x) => x.id), permanent, confirm: true });
        say(`${r.freed} élément(s) retiré(s) (${bytes(r.bytes)})${r.failed?.length ? ` · ${r.failed.length} refusé(s) : ${r.failed[0].file} — ${r.failed[0].error}` : ''}.`, r.failed?.length ? 'error' : ''); } catch (e) { say(e.message, 'error'); }
      loadLeft(true);
    };
  });
  $('#bk-go').onclick = async () => {
    try { data.backup = await call('/api/maintenance/backup', 'POST', { rootId: Number($('#bk-root').value), dest: $('#bk-dest').value.trim() }); say('Sauvegarde lancée.'); watchBackup(); paint(); } catch (e) { say(e.message, 'error'); }
  };
  const flush = async (targetId, entry) => {
    const t = data.caches.find((c) => c.id === targetId);
    const items = entry ? t.entries.filter((e) => e.name === entry) : t.entries;
    const total = items.reduce((s, e) => s + e.size, 0);
    const ok = await confirmBox({ title: entry ? 'Supprimer cet élément ?' : `Vider « ${t.label} » ?`, okLabel: `Supprimer ${bytes(total)}`,
      html: `<p>${t.kind === 'library' ? '<b style="color:var(--danger)">Ce sont de vrais modèles téléchargés par l\'application : il faudra les retélécharger pour les retrouver.</b>' : 'Ces fichiers seront supprimés définitivement. Les applications les retélécharge­ront si elles en ont encore besoin.'}</p>
        <ul>${items.slice(0, 12).map((e) => `<li>${esc(e.name)} <span class="muted">(${bytes(e.size)})</span></li>`).join('')}${items.length > 12 ? `<li class="muted">… et ${items.length - 12} autres</li>` : ''}</ul><p class="muted small">Suppression définitive (pas de corbeille).</p>` });
    if (!ok) return;
    try { const r = await call('/api/maintenance/caches/flush', 'POST', { targetId, entries: entry ? [entry] : undefined, confirm: true }); say(`${bytes(r.freed)} libérés${r.failed?.length ? ` (${r.failed.length} élément(s) verrouillé(s))` : ''}.`); } catch (e) { say(e.message, 'error'); }
    loadCaches(true);
  };
  document.querySelectorAll('[data-flush]').forEach((b) => { b.onclick = () => flush(b.dataset.flush, b.dataset.entry); });
  const all = $('#flush-all');
  if (all) all.onclick = async () => {
    const targets = data.caches.filter((c) => c.kind === 'cache');
    const total = targets.reduce((s, c) => s + c.size, 0);
    const ok = await confirmBox({ title: '🚽 Tirer la chasse ?', okLabel: `Tout supprimer (${bytes(total)})`,
      html: `<p>Tous les <b>caches</b> ci-dessous seront supprimés définitivement. Les bibliothèques d'applis (Ollama, LM Studio…) ne sont pas touchées.</p>
        <ul>${targets.map((c) => `<li><b>${esc(c.label)}</b> — ${bytes(c.size)}<div class="muted small">${esc(c.entries.slice(0, 4).map((e) => e.name).join(', '))}${c.entries.length > 4 ? '…' : ''}</div></li>`).join('')}</ul>
        <p class="muted small">Ce qui est utilisé par tes outils (voix, génération d'images…) sera retéléchargé au prochain lancement.</p>` });
    if (!ok) return;
    let freed = 0;
    for (const c of targets) { try { freed += (await call('/api/maintenance/caches/flush', 'POST', { targetId: c.id, confirm: true })).freed; } catch (e) { say(`${c.label} : ${e.message}`, 'error'); } }
    say(`Chasse tirée : ${bytes(freed)} libérés.`); loadCaches(true);
  };
}

async function loadHealth(force) {
  if (loading.health || (data.health && !force)) return;
  loading.health = true; if (force) data.health = null; paint();
  try { data.health = await call('/api/maintenance/health'); } catch (e) { data.health = { supported: true, error: e.message, disks: [] }; }
  loading.health = false; paint();
}
async function loadCaches(force) {
  if (loading.caches || (data.caches && !force)) return;
  loading.caches = true; if (force) data.caches = null; paint();
  try { data.caches = (await call('/api/maintenance/caches')).caches; } catch (e) { data.caches = []; say(e.message, 'error'); }
  loading.caches = false; paint();
}
async function loadStrays() {
  try { data.strays = (await call('/api/maintenance/strays')).items; } catch (e) { data.strays = []; say(e.message, 'error'); }
  paint();
}
async function loadLeft(force) {
  if (loading.left || (data.left && !force)) return;
  loading.left = true; if (force) data.left = null; paint();
  try { data.left = (await call('/api/maintenance/leftovers')).items; } catch (e) { data.left = []; say(e.message, 'error'); }
  loading.left = false; paint();
}
function watchBackup() {
  clearTimeout(timer);
  call('/api/maintenance/backup').then((b) => { data.backup = b; paint(); if (b.running) timer = setTimeout(watchBackup, 2000); }).catch(() => {});
}

async function enter() {
  try { const r = await call('/api/roots'); data.roots = r.roots || r; } catch { /* ignore */ }
  paint(); loadUsage(); loadHealth(false); loadCaches(false); loadLeft(false); loadStrays(); watchBackup();
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (t && t.dataset.view === 'care') setTimeout(enter, 0);
  else if (t) clearTimeout(timer);
});
