// Barre des tâches de l'écran Travail : file du gros modèle local (brouillons, ordre par glisser-déposer, cases à cocher, ▶ ⏸ ■),
// « Faire un plan » (un modèle rédige le plan après la discussion, il arrive en brouillon), bloc-notes du projet (« To-do »).
// ctx : { root, call, say, esc, nf, copyText, getMsgs(), getDir() }
export function initTasksBar(ctx) {
  const { root, call, say, esc, nf, copyText } = ctx;
  const $ = (s, r = document) => r.querySelector(s);
  const T = { list: [], queueOn: true, sel: new Set(), view: null, viewTimer: null, prev: new Map(), drag: '', ideas: [] };
  const ST = { draft: 'brouillon', queued: 'en attente', running: 'en cours', paused: 'en pause', done: 'terminée', failed: 'échec', cancelled: 'annulée' };
  const live = (t) => ['queued', 'running', 'paused'].includes(t.status);
  const editable = (t) => ['draft', 'queued'].includes(t.status);
  const shortModel = (t) => String(t.modelName || '').replace(/\.gguf$/i, '').slice(0, 18);
  const eta = (t) => { if (t.status !== 'running' || !t.tps || !t.maxTokens) return ''; const left = Math.max(0, t.maxTokens - t.outTok) / t.tps; return ` · ≤ ${left >= 90 ? Math.round(left / 60) + ' min' : Math.round(left) + ' s'}`; };
  const pctOf = (t) => (t.status === 'done' ? 100 : (t.status === 'running' || t.status === 'paused') ? (t.maxTokens ? Math.min(97, Math.round((t.outTok / t.maxTokens) * 100)) : 0) : 0);

  // ------------------------------------------------------------ liste
  function renderTasks() {
    const el = $('#w-tasks'); if (!el) return;
    const act = T.list.filter(live).length; const drafts = T.list.filter((t) => t.status === 'draft').length;
    const rows = T.list.map((t) => {
      const cls = t.status === 'failed' ? 'warn' : (t.status === 'cancelled' || t.status === 'paused') ? 'pause' : '';
      const sub = t.status === 'running' ? `${nf(t.outTok)} jetons${t.tps ? ` · ${t.tps} tok/s` : ''}${eta(t)}` : t.status === 'queued' || t.status === 'paused' ? (t.note || 'dans la file')
        : t.status === 'draft' ? (t.fromPlan ? 'plan à relire avant de lancer' : 'à relire avant de lancer') : t.status === 'failed' ? t.error : `${nf(t.chars)} caractères${t.truncated ? ' · ⚠ coupée (limite ou contexte plein)' : ''}${t.draftId ? ' · plan prêt' : ''}`;
      const ed = editable(t);
      return `<div class="w-task ${t.status}${T.sel.has(t.id) ? ' sel' : ''}" data-task="${esc(t.id)}" ${ed ? 'draggable="true"' : ''} title="${ed ? 'Ouvrir pour lire, modifier, choisir le modèle' : 'Voir le texte'}">`
        + `<div class="w-task-h">${ed ? `<input type="checkbox" class="w-task-cb" data-sel="${esc(t.id)}" ${T.sel.has(t.id) ? 'checked' : ''} title="Sélectionner">` : ''}`
        + `<span class="w-task-t" title="${esc(t.modelName || 'Modèle de la discussion')}">${t.kind === 'plan' ? '🗺 ' : ''}${esc(t.title)}${t.modelName ? ` <span class="muted small">· ${esc(shortModel(t))}</span>` : ''}</span>`
        + `<span class="muted small">${ST[t.status] || t.status}</span>${t.status !== 'running' ? `<button class="w-task-x" data-del="${esc(t.id)}" title="Retirer">✕</button>` : ''}</div>`
        + `<div class="w-track"><div class="w-fill ${cls}${t.status === 'running' && (!t.outTok || !t.maxTokens) ? ' ind' : ''}" style="width:${pctOf(t)}%"></div></div><div class="muted small w-task-s">${esc(sub)}</div></div>`;
    }).join('');
    const nsel = [...T.sel].filter((id) => T.list.some((t) => t.id === id && editable(t))).length;
    el.innerHTML = `<div class="w-tasks-h"><b>📋 Tâches${act ? ` (${act})` : ''}${drafts ? ` · ${drafts} brouillon${drafts > 1 ? 's' : ''}` : ''}</b><span style="flex:1;min-width:0"></span>`
      + `${T.list.some((t) => !live(t) && t.status !== 'draft') ? '<button class="btn small ghost" id="w-tclear" title="Retirer les tâches terminées">Vider</button>' : ''}`
      + `<button class="btn small" id="w-tnew" title="Ajouter une tâche">＋</button></div>`
      + (rows || '<div class="muted small" style="padding:4px">Aucune tâche. Les grosses demandes passent ici ; « 🗺 Plan » fait rédiger un plan par un modèle, qui arrive ici en brouillon.</div>')
      + `<div class="w-tasks-f"><button class="btn small ${T.queueOn ? '' : 'primary'}" id="w-qplay" title="${nsel ? 'Lancer les tâches cochées' : 'Lancer / reprendre la file'}">▶${nsel ? ` ${nsel}` : ''}</button>`
      + `<button class="btn small" id="w-qpause" title="Pause exacte de la tâche en cours">⏸</button><button class="btn small danger" id="w-qstop" title="Arrêter la tâche en cours (annulée)">■</button>`
      + `<span class="muted small" style="flex:1;text-align:right">${T.queueOn ? 'file active' : 'file en pause'}</span></div>`;
  }
  async function pollTasks() {
    if (!root.closest('.view.active')) return;
    try {
      const r = await call('/api/tasks'); T.queueOn = r.queueOn !== false;
      const s = JSON.stringify([r.tasks, r.queueOn]);
      if (s !== T.sig) {
        T.sig = s; T.list = r.tasks;
        for (const t of r.tasks) { // un plan qui vient de se terminer : notification
          const was = T.prev.get(t.id); if (t.kind === 'notes' && t.status === 'done' && was && was !== 'done') { say(t.note || 'To-do mise à jour.'); loadIdeas(); }
          if (t.kind === 'plan' && t.status === 'done' && t.draftId && was && was !== 'done') say(`Plan prêt : « ${t.title.replace(/^Plan : /, '')} ». Brouillon ajouté à la barre des tâches.`);
          T.prev.set(t.id, t.status);
        }
        renderTasks(); renderPlanBar();
      }
    } catch { /* serveur pas prêt */ }
  }
  setInterval(pollTasks, 2000);

  // bandeau de progression au pied de la discussion : un plan est en cours de rédaction
  function renderPlanBar() {
    const el = $('#w-planbar'); if (!el) return;
    const t = T.list.find((x) => (x.kind === 'plan' || x.kind === 'notes') && live(x)); // la mise en mémoire reste discrète : seulement dans la liste des tâches
    if (!t) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    const who = t.modelName ? shortModel(t) : 'Le modèle';
    const pct = t.status === 'running' ? Math.max(3, Math.min(95, Math.round((t.outTok / 1500) * 100))) : 0;
    const txt = t.status === 'running' ? `${nf(t.outTok)} jetons${t.tps ? ` · ${t.tps} tok/s` : ''}` : t.status === 'paused' ? (t.note || 'en pause') : (t.note || 'en attente');
    el.classList.remove('hidden');
    el.innerHTML = `<div class="w-planbar-t">🗺 ${esc(who)} ${t.kind === 'notes' ? 'met à jour la To-do' : t.kind === 'memo' ? 'range en mémoire la conversation' : 'prépare le plan de la tâche'} « ${esc(t.planTitle || t.title.replace(/^Plan : /, ''))} » <span class="muted small">· ${esc(txt)}${t.status === 'running' ? ` · ≈ ${pct} %` : ''}</span></div><div class="w-track"><div class="w-fill${t.status === 'running' ? '' : ' ind'}" style="width:${pct}%"></div></div>`;
  }

  // ------------------------------------------------------------ fenêtres
  function modal() { let m = $('#w-tmodal'); if (!m) { m = document.createElement('div'); m.id = 'w-tmodal'; m.className = 'care-modal hidden'; root.appendChild(m); } return m; }
  const closeModal = () => { clearInterval(T.viewTimer); T.viewTimer = null; T.view = null; $('#w-tmodal')?.classList.add('hidden'); };
  // liste des modèles locaux proposables (disques actifs, sans modules d'image)
  async function fillModels(sel, current = 'chat', key = '') {
    if (!sel) return;
    const mem = () => { try { return localStorage.getItem('paiz.taskModel.' + key) || ''; } catch { return ''; } };
    if (key && (current == null || current === 'chat')) current = mem() || 'chat';
    if (key) sel.addEventListener('change', () => { try { localStorage.setItem('paiz.taskModel.' + key, sel.value); } catch { /* ok */ } });
    try {
      const [l, r] = await Promise.all([call('/api/assets?q=.gguf&limit=500&sort=size'), call('/api/roots')]);
      const act = new Set((r.roots || r).filter((x) => x.role === 'active').map((x) => x.id));
      for (const a of (l.items || []).filter((x) => /\.gguf$/i.test(x.file_name) && !/mmproj/i.test(x.file_name) && act.has(x.root_id))) {
        const o = document.createElement('option'); o.value = String(a.id); o.textContent = (a.title || a.file_name).replace(/\.gguf$/i, '') + ' · ' + (a.size_bytes / 1e9).toFixed(1).replace('.', ',') + ' Go'; sel.appendChild(o);
      }
      // modèles cloud gratuits d'OpenCode : la tâche part chez le fournisseur (aucune charge sur la machine)
      try {
        const free = (await call('/api/work/models')).free || [];
        if (free.length) {
          const g = document.createElement('optgroup'); g.label = '☁ OpenCode Free Cloud Models (text is sent over the Internet)';
          const LV = { bad: '🔴', warn: '🟡', ok: '🟢', unk: '⚪' };
          for (const f of free) { const o = document.createElement('option'); o.value = 'cloud:' + f.id; o.textContent = `${LV[f.level] || '⚪'} ${f.name}`; o.title = f.note || ''; g.appendChild(o); }
          sel.appendChild(g);
        }
      } catch { /* OpenCode pas lancé : pas de modèles cloud */ }
      sel.value = String(current ?? 'chat'); if (sel.value !== String(current ?? 'chat')) sel.value = 'chat';
    } catch { /* liste indisponible : on garde le modèle de la discussion */ }
  }
  const MAXOPT = '<option value="0">Jusqu’à la fin (recommandé)</option><option value="1500">≈ 1 500 jetons (court)</option><option value="4000">≈ 4 000 jetons</option><option value="8000">≈ 8 000 jetons</option><option value="16000">≈ 16 000 jetons</option>';
  const MODELOPT = '<option value="chat">Celui de la discussion (déjà chargé)</option>';

  function openNewTask(prefill = '') {
    const m = modal(); T.view = null;
    const W = 'width:100%;max-width:none;box-sizing:border-box';
    const st = { project: ctx.getDir?.() || '', files: [] };
    m.innerHTML = `<div class="care-box w-tbox wide"><button class="w-x" id="w-tm-x" title="Fermer">✕</button><h2>📋 Nouvelle tâche</h2><p class="muted small">Elle part dans la file, ou reste en brouillon si tu veux la relire avant. Un autre modèle que celui de la discussion se lance à côté, le temps de la file.</p>`
      + `<input class="input" id="w-tnew-title" placeholder="Titre (facultatif)" style="${W}"><label class="w-sel" style="display:flex;margin:6px 0">Modèle <select id="w-tnew-model" style="flex:1">${MODELOPT}</select></label>`
      + `<div class="w-te-opts"><div class="w-te-row"><span class="w-te-k">Dossier de travail</span><span class="w-te-v" id="w-tn-dir"></span><button class="btn small" id="w-tn-dirpick">Changer…</button><button class="btn small ghost" id="w-tn-dirnone" title="Sans dossier : la tâche rend seulement un texte">Aucun</button></div>`
      + `<div class="w-te-row"><span class="w-te-k">Fichiers à reprendre</span><span class="w-te-v" id="w-tn-files"></span><button class="btn small" id="w-tn-fileadd">＋ Ajouter…</button></div>`
      + `<div class="w-te-row" id="w-tn-speedrow"><span class="w-te-k">Vitesse du modèle de tâche</span><select id="w-tn-speed"><option value="auto">Auto (selon la VRAM libre)</option><option value="discret">Discret : GPU libre</option><option value="leger">Léger</option><option value="normal">Normal</option><option value="vif">Vif</option><option value="rapide">Rapide : cache VRAM large</option></select></div></div>`
      + `<textarea class="input" id="w-tnew-spec" rows="14" style="${W};min-height:38vh" placeholder="Cahier des charges : ce que le modèle doit produire, contraintes, format de la réponse…">${esc(prefill)}</textarea>`
      + `<div class="toolbar" style="margin-top:10px"><label class="w-sel">Réponse maximale <select id="w-tnew-max">${MAXOPT}</select></label><span class="grow"></span><button class="btn" id="w-tm-draft">En brouillon</button><button class="btn primary" id="w-tm-ok">Mettre en file</button></div></div>`;
    m.classList.remove('hidden'); fillModels($('#w-tnew-model'), 'chat', 'new');
    const base = (f) => String(f).split(/[\\/]/).pop();
    const paint = () => {
      $('#w-tn-dir').textContent = st.project || 'aucun : la tâche rend un texte, à lire dans la tâche';
      $('#w-tn-files').innerHTML = st.files.length ? st.files.map((f, i) => `<span class="v2-chip" title="${esc(f)}">${esc(base(f))} <button class="w-te-fx" data-fx="${i}" title="Retirer">✕</button></span>`).join(' ') : '<span class="muted">aucun (le modèle part de zéro)</span>';
      $('#w-tn-files').querySelectorAll('[data-fx]').forEach((x) => { x.onclick = () => { st.files.splice(Number(x.dataset.fx), 1); paint(); }; });
      const v = $('#w-tnew-model').value; $('#w-tn-speedrow').style.display = v && v !== 'chat' && !v.startsWith('cloud:') ? '' : 'none';
    };
    $('#w-tnew-model').addEventListener('change', paint); setTimeout(paint, 400); paint();
    $('#w-tn-dirpick').onclick = async () => { try { const r = await call('/api/pick-folder', 'POST', { start: st.project }); if (r.path) { st.project = r.path; paint(); } } catch (e) { say(e.message, 'error'); } };
    $('#w-tn-dirnone').onclick = () => { st.project = ''; paint(); };
    $('#w-tn-fileadd').onclick = async () => { try { const r = await call('/api/pick-files', 'POST', { start: st.project }); if (r.paths?.length) { st.files = [...new Set([...st.files, ...r.paths])]; paint(); } } catch (e) { say(e.message, 'error'); } };
    $('#w-tm-x').onclick = closeModal;
    const add = (draft) => async () => {
      const spec = $('#w-tnew-spec').value.trim(); if (!spec) return;
      try { const t = await call('/api/tasks', 'POST', { spec, title: $('#w-tnew-title').value.trim(), source: 'manuel', project: st.project, files: st.files, speed: $('#w-tn-speed').value, maxTokens: Number($('#w-tnew-max').value), model: $('#w-tnew-model').value, draft }); say(`${draft ? 'Brouillon ajouté' : 'Tâche ajoutée'} : ${t.title}`); closeModal(); await pollTasks(); } catch (e) { say(e.message, 'error'); }
    };
    $('#w-tm-ok').onclick = add(false); $('#w-tm-draft').onclick = add(true);
    setTimeout(() => $('#w-tnew-spec')?.focus(), 30);
  }

  // lecture d'une tâche en cours / terminée
  async function openTaskView(id) {
    const m = modal(); T.view = id;
    m.innerHTML = `<div class="care-box w-tbox wide"><button class="w-x" id="w-tv-x" title="Fermer">✕</button><h2 id="w-tv-h"></h2><div class="muted small" id="w-tv-s"></div><div class="w-track" style="margin:8px 0"><div class="w-fill" id="w-tv-f" style="width:0"></div></div><pre class="w-tv-pre" id="w-tv-pre"></pre><div class="toolbar" style="margin-top:10px"><button class="btn small" id="w-tv-copy">Copier</button><span class="grow"></span><button class="btn small" id="w-tv-retry">Relancer</button><button class="btn small danger" id="w-tv-stop">Annuler</button><button class="btn small" id="w-tv-del">Retirer</button></div></div>`;
    m.classList.remove('hidden'); $('#w-tv-x').onclick = closeModal;
    const draw = async () => {
      if (T.view !== id) return;
      let t; try { t = await call(`/api/tasks/${id}`); } catch { closeModal(); return; }
      if (editable(t)) { openEditor(t); return; } // passée de brouillon à lancée entre-temps ou inversement
      const pre = $('#w-tv-pre'); if (!pre) return;
      const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
      $('#w-tv-h').textContent = t.title;
      const dur = t.startedAt ? Math.max(0, ((t.endedAt || Date.now()) - t.startedAt) / 1000) : 0;
      const durTxt = dur ? (dur >= 3600 ? `${Math.floor(dur / 3600)} h ${Math.round((dur % 3600) / 60)} min` : dur >= 60 ? `${Math.floor(dur / 60)} min ${Math.round(dur % 60)} s` : `${Math.round(dur)} s`) : '';
      $('#w-tv-s').textContent = `${ST[t.status] || t.status}${durTxt ? ` · ${t.endedAt ? 'durée' : 'depuis'} ${durTxt}` : ''} · ${nf(t.outTok)} jetons${t.tps ? ` · ${t.tps} tok/s` : ''}${eta(t)}${t.workDir ? ` · 📁 ${t.workDir}` : ' · résultat en texte seulement (aucun fichier écrit)'}${t.error ? ' · ' + t.error : ''}`;
      $('#w-tv-f').style.width = pctOf(t) + '%';
      if (pre.dataset.n !== String(t.text.length)) { pre.textContent = t.text || ''; pre.dataset.n = String(t.text.length); if (stick) pre.scrollTop = pre.scrollHeight; }
      $('#w-tv-stop').style.display = live(t) ? '' : 'none'; $('#w-tv-retry').style.display = live(t) ? 'none' : '';
    };
    $('#w-tv-copy').onclick = () => copyText($('#w-tv-pre').textContent);
    $('#w-tv-stop').onclick = async () => { await call(`/api/tasks/${id}/cancel`, 'POST').catch((e) => say(e.message, 'error')); draw(); pollTasks(); };
    $('#w-tv-retry').onclick = async () => { await call(`/api/tasks/${id}/retry`, 'POST').catch((e) => say(e.message, 'error')); draw(); pollTasks(); };
    $('#w-tv-del').onclick = async () => { await call(`/api/tasks/${id}`, 'DELETE').catch(() => {}); closeModal(); pollTasks(); };
    await draw(); clearInterval(T.viewTimer); T.viewTimer = setInterval(draw, 1500);
  }
  // édition d'un brouillon / d'une tâche en attente : texte, modèle, limite ; Lancer
  function openEditor(t) {
    clearInterval(T.viewTimer); T.viewTimer = null; T.view = null;
    const m = modal();
    m.innerHTML = `<div class="care-box w-tbox wide"><button class="w-x" id="w-te-x" title="Fermer">✕</button><h2>${t.status === 'draft' ? '📝 Brouillon' : '📋 Tâche en attente'}${t.fromPlan ? ' · plan' : ''}</h2><p class="muted small">${t.status === 'draft' ? 'Relis, modifie, choisis le modèle qui fera le travail, puis lance.' : 'Elle n’est pas encore partie : tu peux encore la modifier.'}</p><input class="input" id="w-te-title" value="${esc(t.title)}" style="width:100%;max-width:none;box-sizing:border-box"><label class="w-sel" style="display:flex;margin:6px 0">Modèle <select id="w-te-model" style="flex:1">${MODELOPT}</select></label><div class="w-te-opts"><div class="w-te-row"><span class="w-te-k">Dossier de travail</span><span class="w-te-v" id="w-te-dir"></span><button class="btn small" id="w-te-dirpick">Changer…</button><button class="btn small ghost" id="w-te-dirnone" title="Sans dossier : la tâche rend seulement un texte">Aucun</button></div><div class="w-te-row"><span class="w-te-k">Fichiers à reprendre</span><span class="w-te-v" id="w-te-files"></span><button class="btn small" id="w-te-fileadd">＋ Ajouter…</button></div><div class="w-te-row" id="w-te-speedrow"><span class="w-te-k">Vitesse du modèle de tâche</span><select id="w-te-speed"><option value="auto">Auto (selon la VRAM libre)</option><option value="discret">Discret : GPU libre</option><option value="leger">Léger</option><option value="normal">Normal</option><option value="vif">Vif</option><option value="rapide">Rapide : cache VRAM large</option></select></div></div><div class="muted small" id="w-te-where" style="margin:2px 0 4px"></div><textarea class="input" id="w-te-spec" rows="20" style="width:100%;max-width:none;box-sizing:border-box;min-height:45vh"></textarea><div class="toolbar" style="margin-top:10px"><label class="w-sel">Réponse maximale <select id="w-te-max">${MAXOPT}</select></label><span class="grow"></span><button class="btn small" id="w-te-del">Retirer</button><button class="btn" id="w-te-save">Enregistrer</button>${t.status === 'draft' ? '<button class="btn primary" id="w-te-go">Lancer</button>' : ''}</div></div>`;
    $('#w-te-spec').value = t.spec || ''; $('#w-te-max').value = String(t.maxTokens || 0); if ($('#w-te-max').value !== String(t.maxTokens || 0)) $('#w-te-max').value = '0';
    m.classList.remove('hidden'); fillModels($('#w-te-model'), t.model);
    // où et comment le travail se fera : dans un dossier (session avec outils, quel que soit le modèle) ou en simple texte
    const st = { project: t.project || '', files: [...(t.files || [])] };
    const patch = (o) => call(`/api/tasks/${t.id}`, 'PATCH', o).catch((e) => say(e.message, 'error'));
    const base = (f) => String(f).split(/[\\/]/).pop();
    const paintOpts = () => {
      $('#w-te-dir').textContent = st.project || 'aucun : la tâche rend un texte, à lire dans la tâche';
      $('#w-te-files').innerHTML = st.files.length ? st.files.map((f, i) => `<span class="v2-chip" title="${esc(f)}">${esc(base(f))} <button class="w-te-fx" data-fx="${i}" title="Retirer">✕</button></span>`).join(' ') : '<span class="muted">aucun (le modèle part de zéro)</span>';
      $('#w-te-files').querySelectorAll('[data-fx]').forEach((x) => { x.onclick = () => { st.files.splice(Number(x.dataset.fx), 1); patch({ files: st.files }); paintOpts(); }; });
      const v = $('#w-te-model').value; $('#w-te-speedrow').style.display = v && v !== 'chat' && !v.startsWith('cloud:') ? '' : 'none';
      $('#w-te-where').textContent = st.project ? (st.files.length ? '📁 Le modèle travaille directement dans ce dossier : il lit les fichiers donnés, les améliore sur place, puis résume.' : '📁 Le modèle travaille directement dans ce dossier : il crée et modifie les fichiers, puis résume.') : 'Sans dossier : le résultat est un texte.';
    };
    const where = paintOpts;
    $('#w-te-speed').value = t.speed || 'auto';
    $('#w-te-speed').onchange = (e) => patch({ speed: e.target.value });
    $('#w-te-dirpick').onclick = async () => { try { const r = await call('/api/pick-folder', 'POST', { start: st.project }); if (r.path) { st.project = r.path; patch({ project: st.project }); paintOpts(); } } catch (e) { say(e.message, 'error'); } };
    $('#w-te-dirnone').onclick = () => { st.project = ''; patch({ project: '' }); paintOpts(); };
    $('#w-te-fileadd').onclick = async () => { try { const r = await call('/api/pick-files', 'POST', { start: st.project }); if (r.paths?.length) { st.files = [...new Set([...st.files, ...r.paths])]; patch({ files: st.files }); paintOpts(); } } catch (e) { say(e.message, 'error'); } };
    $('#w-te-model').addEventListener('change', where); setTimeout(where, 400); where();
    $('#w-te-model').addEventListener('change', () => { call(`/api/tasks/${t.id}`, 'PATCH', { model: $('#w-te-model').value }).catch(() => {}); }); // le choix reste même si on ferme sans enregistrer
    $('#w-te-x').onclick = closeModal;
    const save = async () => call(`/api/tasks/${t.id}`, 'PATCH', { title: $('#w-te-title').value, spec: $('#w-te-spec').value, model: $('#w-te-model').value, maxTokens: Number($('#w-te-max').value) });
    $('#w-te-save').onclick = async () => { try { await save(); say('Enregistré.'); closeModal(); pollTasks(); } catch (e) { say(e.message, 'error'); } };
    if (t.status === 'draft') $('#w-te-go').onclick = async () => { try { await save(); await call('/api/tasks/launch', 'POST', { ids: [t.id] }); say('Tâche lancée.'); closeModal(); pollTasks(); } catch (e) { say(e.message, 'error'); } };
    $('#w-te-del').onclick = async () => { await call(`/api/tasks/${t.id}`, 'DELETE').catch(() => {}); closeModal(); pollTasks(); };
  }

  // « Faire un plan » : le modèle choisi rédige le plan à partir de la discussion récente et des idées cochées
  async function openPlan() {
    const m = modal(); T.view = null; const msgs = ctx.getMsgs(); const dir = ctx.getDir();
    let ideas = []; try { ideas = (await call(`/api/ideas?project=${encodeURIComponent(dir)}`)).ideas || []; } catch { /* pas d'idées */ }
    m.innerHTML = `<div class="care-box w-tbox"><button class="w-x" id="w-tp-x" title="Fermer">✕</button><h2>🗺 Faire un plan</h2><p class="muted small">Un modèle rédige le plan de la tâche à partir de la discussion. Il arrive dans la barre des tâches en brouillon : tu le relis avant de lancer quoi que ce soit.</p><input class="input" id="w-tp-title" placeholder="Sujet du plan (ex. un jeu de pong)"><label class="w-sel" style="display:flex;margin:6px 0">Rédigé par <select id="w-tp-model" style="flex:1">${MODELOPT}</select></label><label class="w-sel" style="display:flex;margin:6px 0">Discussion transmise <select id="w-tp-n" style="flex:1"><option value="6">les 6 derniers messages</option><option value="12" selected>les 12 derniers messages</option><option value="30">les 30 derniers messages</option><option value="9999">toute la discussion</option><option value="0">aucune</option></select></label>${ideas.length ? `<div class="muted small" style="margin-top:6px">Idées du projet à prendre en compte :</div><div class="w-tp-ideas">${ideas.map((i) => `<label class="w-tp-idea"><input type="checkbox" data-idea="${esc(i.id)}" checked> <b>${esc(i.title)}</b>${i.body ? ` <span class="muted small">${esc(i.body.slice(0, 90))}</span>` : ''}</label>`).join('')}</div>` : ''}<textarea class="input" id="w-tp-notes" rows="4" placeholder="Précisions pour le plan (facultatif)…"></textarea><div class="toolbar" style="margin-top:10px"><span class="grow"></span><button class="btn primary" id="w-tp-ok">Rédiger le plan</button></div></div>`;
    m.classList.remove('hidden'); fillModels($('#w-tp-model'), 'chat', 'plan');
    $('#w-tp-x').onclick = closeModal;
    $('#w-tp-ok').onclick = async () => {
      const n = Number($('#w-tp-n').value); const flat = msgs.map((q) => ({ role: q.role, text: (q.parts || []).filter((p) => p.k === 'text').map((p) => p.text).join('\n\n') })).filter((q) => q.text.trim());
      const picked = new Set([...m.querySelectorAll('[data-idea]:checked')].map((c) => c.dataset.idea));
      try {
        await call('/api/plans', 'POST', { title: $('#w-tp-title').value.trim(), model: $('#w-tp-model').value, messages: n ? flat.slice(-n) : [], ideas: ideas.filter((i) => picked.has(i.id)), notes: $('#w-tp-notes').value });
        closeModal(); say('Rédaction du plan lancée : tu peux continuer à discuter.'); await pollTasks();
      } catch (e) { say(e.message, 'error'); }
    };
    setTimeout(() => $('#w-tp-title')?.focus(), 30);
  }

  // ------------------------------------------------------------ bloc-notes du projet
  async function loadIdeas() { try { T.ideas = (await call(`/api/ideas?project=${encodeURIComponent(ctx.getDir())}`)).ideas || []; } catch { T.ideas = []; } refreshTodo(); }
  function refreshTodo() { const b = $('#w-todo'); if (b) b.textContent = `📝 To-do${T.ideas.length ? ` (${T.ideas.length})` : ''}`; }
  async function openTodo(prefill = '') {
    const m = modal(); T.view = null; await loadIdeas(); const dir = ctx.getDir();
    const draw = () => {
      m.innerHTML = `<div class="care-box w-tbox wide"><button class="w-x" id="w-ti-x" title="Fermer">✕</button><h2>📝 To-do du projet</h2><p class="muted small">${dir ? esc(dir) : 'Aucun projet ouvert : les idées sont rangées sans projet.'} · les idées à ne pas oublier ; elles peuvent nourrir un plan.</p><div class="w-ti-ask"><textarea class="input" id="w-ti-ask" rows="2" placeholder="Dis-le au modèle : « résume les idées qu’on a eues » · « note cette idée : … » · « tire de la discussion un cahier des charges et note-le »"></textarea><div class="toolbar"><label class="w-sel">Modèle <select id="w-ti-model"><option value="chat">Celui de la discussion</option></select></label><span class="grow"></span><button class="btn primary" id="w-ti-go">Demander</button></div></div><details class="w-ti-man"><summary class="muted small">Ajouter à la main</summary><div class="w-ti-add"><input class="input" id="w-ti-title" placeholder="Nouvelle idée (titre)"><textarea class="input" id="w-ti-body" rows="2" placeholder="Petite fiche explicative (facultatif)"></textarea><button class="btn primary" id="w-ti-ok">Ajouter</button></div></details><div class="w-ti-list">${T.ideas.length ? T.ideas.map((i) => `<details class="w-ti" data-id="${esc(i.id)}"><summary>${esc(i.title)}</summary><input class="input w-ti-t" value="${esc(i.title)}"><textarea class="input w-ti-b" rows="3">${esc(i.body)}</textarea><div class="toolbar"><span class="grow"></span><button class="btn small" data-isave="${esc(i.id)}">Enregistrer</button><button class="btn small danger" data-idel="${esc(i.id)}">Supprimer</button></div></details>`).join('') : '<div class="muted small">Rien pour l’instant. Note une idée ici, avec « 📝 Noter » sous un message, ou demande-le au modèle.</div>'}</div></div>`;
      $('#w-ti-x').onclick = closeModal;
      fillModels($('#w-ti-model'), 'chat', 'notes'); if (prefill) $('#w-ti-ask').value = prefill;
      $('#w-ti-go').onclick = async () => {
        const instruction = $('#w-ti-ask').value.trim(); if (!instruction) return;
        const flat = ctx.getMsgs().map((q) => ({ role: q.role, text: (q.parts || []).filter((p) => p.k === 'text').map((p) => p.text).join('\n\n') })).filter((q) => q.text.trim()).slice(-30);
        try { await call('/api/notes/ask', 'POST', { project: dir, instruction, messages: flat, model: $('#w-ti-model').value }); say('Demande envoyée : les éléments arriveront dans la To-do.'); closeModal(); await pollTasks(); } catch (e) { say(e.message, 'error'); }
      };
      $('#w-ti-ok').onclick = async () => { const title = $('#w-ti-title').value.trim(); const body = $('#w-ti-body').value.trim(); if (!title && !body) return; try { await call('/api/ideas', 'POST', { project: dir, title, body, source: 'manuel' }); await loadIdeas(); draw(); } catch (e) { say(e.message, 'error'); } };
      m.querySelectorAll('[data-isave]').forEach((b) => { b.onclick = async () => { const d = b.closest('.w-ti'); try { await call(`/api/ideas/${b.dataset.isave}`, 'PATCH', { title: d.querySelector('.w-ti-t').value, body: d.querySelector('.w-ti-b').value }); await loadIdeas(); draw(); say('Idée enregistrée.'); } catch (e) { say(e.message, 'error'); } }; });
      m.querySelectorAll('[data-idel]').forEach((b) => { b.onclick = async () => { await call(`/api/ideas/${b.dataset.idel}`, 'DELETE').catch(() => {}); await loadIdeas(); draw(); }; });
    };
    m.classList.remove('hidden'); draw();
  }

  // ------------------------------------------------------------ clics et glisser-déposer
  root.addEventListener('click', async (e) => {
    const cb = e.target.closest('[data-sel]'); if (cb) { e.stopPropagation(); if (cb.checked) T.sel.add(cb.dataset.sel); else T.sel.delete(cb.dataset.sel); renderTasks(); return; }
    const del = e.target.closest('[data-del]'); if (del) { e.stopPropagation(); await call(`/api/tasks/${del.dataset.del}`, 'DELETE').catch((er) => say(er.message, 'error')); T.sel.delete(del.dataset.del); pollTasks(); return; }
    if (e.target.closest('#w-tnew')) { openNewTask(); return; }
    if (e.target.closest('#w-tclear')) { await call('/api/tasks/clear', 'POST').catch(() => {}); T.sig = ''; pollTasks(); return; }
    if (e.target.closest('#w-qplay')) { try { const ids = [...T.sel].filter((id) => T.list.some((t) => t.id === id && t.status === 'draft')); if (ids.length) await call('/api/tasks/launch', 'POST', { ids }); T.sel.clear(); await call('/api/tasks/queue', 'POST', { action: 'play' }); T.sig = ''; pollTasks(); } catch (er) { say(er.message, 'error'); } return; }
    if (e.target.closest('#w-qpause')) { await call('/api/tasks/queue', 'POST', { action: 'pause' }).catch((er) => say(er.message, 'error')); T.sig = ''; pollTasks(); return; }
    if (e.target.closest('#w-qstop')) { if (confirm('Arrêter la tâche en cours ? Elle sera annulée.')) await call('/api/tasks/queue', 'POST', { action: 'stop' }).catch((er) => say(er.message, 'error')); T.sig = ''; pollTasks(); return; }
    const tk = e.target.closest('[data-task]'); if (tk) { const t = T.list.find((x) => x.id === tk.dataset.task); openTaskView(tk.dataset.task); return; } // la vue charge la tâche COMPLÈTE (la liste n'a pas le texte) puis ouvre l'éditeur si c'est un brouillon
    if (e.target.closest('#w-qtask')) { const ta = $('#w-text'); const v = ta.value.trim(); if (!v) { openNewTask(); return; } openNewTask(v); ta.value = ''; return; }
    if (e.target.closest('#w-qplan')) { openPlan(); return; }
    if (e.target.closest('#w-todo')) { openTodo(); return; }
    const tt = e.target.closest('[data-totask]');
    const msgText = (b) => { const q = ctx.getMsgs().find((x) => x.id === b.closest('.w-msg')?.dataset.id); return q?.parts.filter((p) => p.k === 'text').map((p) => p.text).join('\n\n') || ''; };
    if (tt) { const txt = msgText(tt); if (txt) openNewTask(txt); return; }
    const tn = e.target.closest('[data-tonote]');
    if (tn) { const txt = msgText(tn); if (txt) openTodo('Note cette idée dans la To-do : ' + txt.slice(0, 600)); return; }
    if (false) { const txt = msgText(tn); if (txt) { try { await call('/api/ideas', 'POST', { project: ctx.getDir(), title: txt.split('\n')[0].slice(0, 80), body: txt, source: 'chat' }); say('Noté dans la To-do du projet.'); loadIdeas(); } catch (er) { say(er.message, 'error'); } } }
  });
  root.addEventListener('dragstart', (e) => { const r = e.target.closest?.('.w-task[draggable]'); if (!r) return; T.drag = r.dataset.task; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', T.drag); } catch { /* ok */ } r.classList.add('drag'); });
  root.addEventListener('dragend', (e) => { T.drag = ''; e.target.closest?.('.w-task')?.classList.remove('drag'); root.querySelectorAll('.w-task.over').forEach((x) => x.classList.remove('over')); });
  root.addEventListener('dragover', (e) => { const r = e.target.closest?.('.w-task[draggable]'); if (!r || !T.drag || r.dataset.task === T.drag) return; e.preventDefault(); root.querySelectorAll('.w-task.over').forEach((x) => x.classList.remove('over')); r.classList.add('over'); });
  root.addEventListener('drop', async (e) => {
    const r = e.target.closest?.('.w-task[draggable]'); if (!r || !T.drag || r.dataset.task === T.drag) return; e.preventDefault();
    const ids = T.list.filter(editable).map((t) => t.id); const from = ids.indexOf(T.drag); const to = ids.indexOf(r.dataset.task); if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]); T.drag = '';
    try { await call('/api/tasks/reorder', 'POST', { ids }); } catch (er) { say(er.message, 'error'); } T.sig = ''; pollTasks();
  });

  return { renderTasks, pollTasks, refreshTodo, loadIdeas, openNewTask };
}
