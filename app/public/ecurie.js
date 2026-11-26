// Sous-onglet « Écurie » du Model Dispenser : transformer un repo de stockage en écurie propre (classée par type / base, avec traces),
// et ranger l'existant d'après un plan que tu valides (rien ne bouge avant, tout s'annule).
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
const S = { status: null, plan: null, busy: false, lib: null, libJob: null };
const rel = (p, root) => String(p).slice(String(root).length).replace(/^[\\/]+/, '');

async function load() { try { S.status = await call('/api/ecurie'); S.lib = await call('/api/liberer'); } catch (e) { say(e.message, 'error'); } paint(); }

function paint() {
  const el = $('#ecurie-body'); if (!el) return;
  const roots = S.status?.roots || [];
  el.innerHTML = `<div class="panel"><div class="panel-head"><h3>Écurie propre</h3>
    <p class="muted small">Un repo de stockage rangé comme une vraie écurie : <code>LLM/&lt;famille&gt;/&lt;modèle&gt;/</code>, <code>LoRA/&lt;base&gt;/</code>, <code>Checkpoints/&lt;base&gt;/</code>, <code>VAE/</code>, <code>ControlNet/</code>… Un dossier <code>_PAIZ</code> garde la <b>trace</b> de chaque fichier (d'où il vient) et une copie des listes de configuration (sans les modèles).
    « Ranger » y met les modèles au bon endroit, « Invoquer » les remet à leur adresse exacte ; un fichier sans adresse connue retourne dans le dossier que ton install Stable Diffusion utilise déjà pour ce type.</p></div>
    ${roots.length ? roots.map((r) => `<div class="ec-root" data-id="${r.id}"><div class="ec-head"><b>${esc(r.name)}</b> <code class="small">${esc(r.path)}</code>
      ${r.clean ? '<span class="badge ok">écurie propre</span>' : '<span class="badge soft">repo ordinaire</span>'}${r.hasTrace ? ' <span class="badge soft" title="Dossier _PAIZ/trace.json présent">trace ✓</span>' : ''}</div>
      <div class="toolbar">${r.clean
        ? `<button class="btn primary" data-act="plan">Préparer le plan de rangement</button><button class="btn" data-act="trace" title="Réécrit _PAIZ/trace.json et la copie des configurations">Mettre à jour la trace</button><button class="btn" data-act="undo" title="Remet les fichiers où ils étaient avant le dernier rangement">↶ Annuler le dernier rangement</button><button class="btn ghost" data-act="off">Redevenir repo ordinaire</button>`
        : '<button class="btn primary" data-act="on">Faire de ce repo une écurie propre</button>'}</div>
      <div class="ec-plan" id="ec-plan-${r.id}"></div></div>`).join('') : '<div class="empty">Aucun repo de stockage. Crée-en un dans Disques (rôle « stock »).</div>'}</div>`;
  el.insertAdjacentHTML('beforeend', libHtml());
  if (S.plan) paintPlan(S.plan);
}

// ---- Libérer : copies actives déjà rangées en stockage
function libHtml() {
  const L = S.lib; const j = S.libJob;
  const head = '<div class="panel" id="lib-panel"><div class="panel-head"><h3>Libérer de la place sur les repos actifs</h3><p class="muted small">Ces modèles des repos actifs ont déjà une copie <b>identique</b> dans un repo de stockage : ils occupent la place deux fois. « Libérer » vérifie d\'abord que les deux fichiers sont strictement identiques (SHA-256 des deux), retient leur adresse exacte, puis retire la copie active. Un clic sur « Invoquer » les remet ensuite <b>pile au même endroit</b>. Au moindre doute, rien n\'est retiré.</p></div>';
  if (j && j.status === 'running') {
    const pr = j.progress || {}; const pct = pr.totalBytes ? Math.round((pr.bytes / pr.totalBytes) * 100) : 0;
    return `${head}<div class="ec-sum">⏳ ${pr.phase === 'remove' ? 'Retrait' : 'Vérification'} de <b>${esc(pr.current || '…')}</b> · ${pr.done || 0}/${pr.total || 0} · ${pct} %</div></div>`;
  }
  if (!L) return `${head}<p class="muted">Chargement…</p></div>`;
  if (!L.items.length) return `${head}<div class="empty">Rien à libérer : aucune copie en double entre tes repos actifs et ton stockage.</div></div>`;
  return `${head}<div class="ec-sum"><b>${L.items.length}</b> fichier(s) · jusqu'à <b>${bytes(L.bytes)}</b> récupérables</div>
    <div class="ec-tools"><button class="btn small" data-lsel="all">Tout cocher</button><button class="btn small" data-lsel="none">Tout décocher</button>
      <button class="btn" data-lib="bin" title="Corbeille Windows : récupérable, mais la place n'est rendue qu'en la vidant">Libérer → corbeille</button>
      <button class="btn danger" data-lib="erase" title="Effacement direct de la copie ACTIVE (la copie de stockage est vérifiée identique) : place rendue tout de suite">Libérer → effacer la copie active</button></div>
    <div class="table-scroll" style="max-height:380px"><table class="assets-table"><thead><tr><th></th><th>Modèle</th><th>Copie active (sera retirée)</th><th>Copie gardée en stockage</th><th class="num">Taille</th></tr></thead><tbody>${L.items.map((x) => `<tr><td><input type="checkbox" class="lib-ck" data-id="${x.id}"></td><td>${esc(x.name)}</td><td class="muted small"><code>${esc(x.path)}</code></td><td class="small"><b>${esc(x.store.root)}</b> <code>${esc(x.store.path)}</code></td><td class="num">${bytes(x.size)}</td></tr>`).join('')}</tbody></table></div></div>`;
}
async function liberate(permanent) {
  const ids = [...document.querySelectorAll('.lib-ck:checked')].map((c) => Number(c.dataset.id)); if (!ids.length) { say('Rien de coché.'); return; }
  const tot = (S.lib?.items || []).filter((x) => ids.includes(x.id)).reduce((n, x) => n + x.size, 0);
  const msg = permanent
    ? `Effacer ${ids.length} copie(s) ACTIVE(S) (${bytes(tot)}) ?\n\nChaque fichier n'est effacé qu'APRÈS vérification SHA-256 que la copie de stockage est strictement identique. L'effacement ne passe pas par la corbeille. Tu pourras « Invoquer » le modèle depuis le stockage, à son adresse exacte.`
    : `Mettre ${ids.length} copie(s) active(s) (${bytes(tot)}) à la corbeille Windows ?\n\nChaque fichier n'est retiré qu'APRÈS vérification SHA-256 que la copie de stockage est strictement identique. La place n'est rendue qu'en vidant la corbeille.`;
  if (!confirm(msg)) return;
  try {
    const job = await call('/api/jobs/liberate', 'POST', { ids, permanent }); S.libJob = { ...job, status: 'running', progress: job.progress || {} }; paint();
    const t = setInterval(async () => {
      try {
        const j = await call(`/api/jobs/${job.id}`); S.libJob = j;
        if (j.status === 'running') { paint(); return; }
        clearInterval(t); S.libJob = null;
        if (j.status === 'error') say(j.error || 'Échec.', 'error');
        else { const r = j.result || {}; say(`${r.freed || 0} fichier(s) libéré(s) (${bytes(r.bytes || 0)})${r.failed?.length ? ` · ${r.failed.length} refusé(s) : ${r.failed[0].file} — ${r.failed[0].error}` : ''}.`, r.failed?.length ? 'error' : ''); }
        await load(); document.dispatchEvent(new CustomEvent('paiz:refresh'));
      } catch { clearInterval(t); S.libJob = null; }
    }, 1200);
  } catch (e) { say(e.message, 'error'); }
}

function paintPlan(p) {
  const box = $(`#ec-plan-${p.root.id}`); if (!box) return;
  const root = p.root.path;
  const copy = (m) => (m.copyOf?.length ? `<span class="badge tw" title="${esc(m.copyOf.map((c) => c.path).join('\n'))}">copie de ${esc(m.copyOf[0].where)}${m.copyOf.length > 1 ? ` +${m.copyOf.length - 1}` : ''}</span>` : '');
  box.innerHTML = `<div class="ec-sum"><b>${p.moves.length}</b> fichier(s) à ranger (${bytes(p.bytes)}) · ${p.stay} déjà bien rangé(s) · <b>${p.dupes.length}</b> à trier à la main</div>
    <p class="muted small">Même disque : les déplacements sont des renommages instantanés (aucune copie, aucun risque pour les fichiers). Le journal permet d'annuler. <b>Rien n'est effacé.</b></p>
    ${p.moves.length ? `<div class="ec-tools"><button class="btn small" data-sel="all">Tout cocher</button><button class="btn small" data-sel="none">Tout décocher</button><button class="btn primary" data-act="apply">Ranger la sélection</button></div>
    <div class="table-scroll" style="max-height:420px"><table class="assets-table"><thead><tr><th></th><th>Fichier</th><th>Actuellement</th><th>Sera rangé dans</th><th class="num">Taille</th></tr></thead><tbody>${p.moves.map((m) => `<tr><td><input type="checkbox" class="ec-ck" data-id="${m.id}" checked></td><td>${esc(m.name)} ${copy(m)}</td><td class="muted small"><code>${esc(rel(m.from, root))}</code></td><td class="small"><code>${esc(m.rel)}</code></td><td class="num">${bytes(m.size)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Rien à ranger : tout est déjà à sa place.</div>'}
    ${p.dupes.length ? `<h4 style="margin-top:14px">À trier à la main (${p.dupes.length})</h4><p class="muted small">Deux fichiers identiques dans ce repo, ou un nom déjà pris à la destination : PAIZ n'en choisit aucun à ta place. Règle-les dans l'onglet <b>Doublons</b> (avec avertissement), puis refais un plan.</p>
    <div class="table-scroll" style="max-height:220px"><table class="assets-table"><tbody>${p.dupes.map((m) => `<tr><td>${esc(m.name)}</td><td class="muted small"><code>${esc(rel(m.from, root))}</code></td><td class="small muted">${m.conflict ? 'nom déjà pris à la destination' : `identique à ${m.twins.map((t) => esc(rel(t.path, root))).join(', ')}`}</td><td class="num">${bytes(m.size)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

async function act(rootId, what) {
  if (S.busy) return; S.busy = true;
  try {
    if (what === 'on') { await call('/api/ecurie/clean', 'POST', { rootId, on: true }); say('Repo marqué « écurie propre » : les prochains rangements y seront classés.'); await load(); }
    else if (what === 'off') { await call('/api/ecurie/clean', 'POST', { rootId, on: false }); S.plan = null; await load(); }
    else if (what === 'plan') { S.plan = await call(`/api/ecurie/plan?rootId=${rootId}`); paintPlan(S.plan); }
    else if (what === 'trace') { const r = await call('/api/ecurie/trace', 'POST', { rootId }); say(`Trace mise à jour (${r?.count ?? 0} fichier(s)).`); await load(); }
    else if (what === 'undo') {
      if (!confirm('Annuler le dernier rangement de cette écurie ?\n\nLes fichiers reviennent exactement où ils étaient avant (d\'après le journal).')) return;
      const r = await call('/api/ecurie/undo', 'POST', { rootId }); say(`${r.restored} fichier(s) remis en place${r.failed.length ? `, ${r.failed.length} impossible(s) : ${r.failed[0].error}` : ''}.`, r.failed.length ? 'error' : ''); S.plan = null; await load();
    } else if (what === 'apply') {
      const ids = [...document.querySelectorAll('.ec-ck:checked')].map((c) => Number(c.dataset.id)); if (!ids.length) { say('Rien de coché.'); return; }
      if (!confirm(`Ranger ${ids.length} fichier(s) dans l'arborescence propre ?\n\nRenommages instantanés sur le même disque, rien n'est effacé, un journal permet d'annuler.`)) return;
      const r = await call('/api/ecurie/apply', 'POST', { rootId, ids, confirm: true });
      say(`${r.moved} fichier(s) rangé(s)${r.failed.length ? `, ${r.failed.length} échec(s) : ${r.failed[0].file} (${r.failed[0].error})` : ''}.`, r.failed.length ? 'error' : '');
      S.plan = await call(`/api/ecurie/plan?rootId=${rootId}`); await load(); document.dispatchEvent(new CustomEvent('paiz:refresh'));
    }
  } catch (e) { say(e.message, 'error'); } finally { S.busy = false; }
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#tabs .tab[data-view="ecurie"]')) { load(); return; }
  const body = e.target.closest('#ecurie-body'); if (!body) return;
  const ls = e.target.closest('[data-lsel]'); if (ls) { body.querySelectorAll('.lib-ck').forEach((c) => { c.checked = ls.dataset.lsel === 'all'; }); return; }
  const lb = e.target.closest('[data-lib]'); if (lb) { liberate(lb.dataset.lib === 'erase'); return; }
  const sel = e.target.closest('[data-sel]');
  if (sel) { body.querySelectorAll('.ec-ck').forEach((c) => { c.checked = sel.dataset.sel === 'all'; }); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const rootId = Number(b.closest('.ec-root')?.dataset.id); act(rootId, b.dataset.act);
});
