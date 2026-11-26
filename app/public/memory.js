// Fenêtre « Mémoire » : ce que les assistants retiennent (notes du projet, notes globales, souvenirs de conversations), recherche, réglages.
// ctx : { root, call, say, esc, getDir, getMsgs }
export function initMemory(ctx) {
  const { root, call, say, esc } = ctx;
  const $ = (s, r = document) => r.querySelector(s);
  const CATS = { identite: 'identité', preference: 'préférence', projet: 'projet', decision: 'décision', personne: 'personne', promesse: 'promesse', idee: 'idée' };
  const ago = (t) => { const d = Math.round((Date.now() - t) / 86400000); return d <= 0 ? 'aujourd’hui' : d === 1 ? 'hier' : `il y a ${d} j`; };
  let tab = 'projet';

  function modal() { let m = $('#w-tmodal'); if (!m) { m = document.createElement('div'); m.id = 'w-tmodal'; m.className = 'care-modal hidden'; root.appendChild(m); } return m; }
  async function open() {
    const m = modal(); const dir = ctx.getDir();
    const draw = async (hits) => {
      let d; try { d = await call(`/api/memory?project=${encodeURIComponent(dir)}`); } catch (e) { say(e.message, 'error'); return; }
      const proj = d.notes.filter((n) => n.scope !== 'global'); const glob = d.notes.filter((n) => n.scope === 'global');
      const noteRow = (n) => `<div class="w-mn" data-id="${esc(n.id)}"><div class="w-mn-h"><span class="w-mn-c">${esc(CATS[n.cat] || n.cat)}</span><select class="w-mn-i" title="Importance (4-5 : toujours rappelée)">${[1, 2, 3, 4, 5].map((i) => `<option ${i === n.importance ? 'selected' : ''}>${i}</option>`).join('')}</select>${n.due ? `<span class="muted small">échéance ${esc(n.due)}</span>` : ''}<span class="grow"></span><button class="w-task-x" data-nsave="${esc(n.id)}" title="Enregistrer">✔</button><button class="w-task-x" data-ndel="${esc(n.id)}" title="Oublier">✕</button></div><textarea class="input w-mn-t" rows="2">${esc(n.text)}</textarea></div>`;
      const list = tab === 'projet' ? proj : tab === 'global' ? glob : [];
      m.innerHTML = `<div class="care-box w-tbox wide"><button class="w-x" id="w-me-x" title="Fermer">✕</button><h2>🧠 Mémoire</h2><p class="muted small">Ce que les assistants se rappellent. Tout est local et modifiable ; « ✕ » oublie pour de bon. Les conversations sont digérées après 10 min d’inactivité, par le modèle chargé.</p>`
        + `<div class="toolbar"><label><input type="checkbox" id="w-me-on" ${d.on ? 'checked' : ''}> Mémoire active</label>${dir ? `<label title="Rien de ce projet n’est lu, noté ni rappelé ; ce qui avait été retenu est effacé"><input type="checkbox" id="w-me-priv" ${d.private ? 'checked' : ''}> Projet privé</label>` : ''}</div>`
        + `<div class="toolbar" style="margin-top:6px"><input class="input" id="w-me-q" placeholder="Chercher dans la mémoire et les anciennes conversations…" style="flex:1"><button class="btn small" id="w-me-s">Chercher</button></div>`
        + (hits ? `<div class="w-mn-list">${hits.length ? hits.map((h) => `<div class="w-mn"><span class="w-mn-c">${h.kind === 'note' ? 'note' : h.kind === 'summ' ? 'souvenir' : 'extrait'}</span> ${esc(h.text.slice(0, 400))}</div>`).join('') : '<div class="muted small">Rien trouvé.</div>'}</div><div class="toolbar"><button class="btn small" id="w-me-back">← Retour</button></div>` : `<div class="w-mtabs"><button class="w-tab ${tab === 'projet' ? 'active' : ''}" data-mtab="projet">Ce projet (${proj.length})</button><button class="w-tab ${tab === 'global' ? 'active' : ''}" data-mtab="global">Global (${glob.length})</button><button class="w-tab ${tab === 'souv' ? 'active' : ''}" data-mtab="souv">Souvenirs (${d.summaries.length})</button></div>`
          + (tab === 'souv' ? `<div class="w-mn-list">${d.summaries.map((s) => `<div class="w-mn"><div class="w-mn-h"><span class="w-mn-c">${ago(s.created)}</span><span class="muted small">${esc(s.title || '')}</span><span class="grow"></span><button class="w-task-x" data-sdel="${esc(s.id)}" title="Oublier">✕</button></div>${esc(s.text)}</div>`).join('') || '<div class="muted small">Aucun souvenir pour l’instant.</div>'}</div>`
            : `<div class="w-mn-list">${list.map(noteRow).join('') || '<div class="muted small">Aucune note ici pour l’instant.</div>'}</div><div class="w-mn-add"><select id="w-ma-c">${Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select><input class="input" id="w-ma-t" placeholder="Retenir : …" style="flex:1"><button class="btn primary small" id="w-ma-ok">Ajouter</button></div>`)) + '</div>';
      m.classList.remove('hidden');
      $('#w-me-x').onclick = () => m.classList.add('hidden');
      $('#w-me-on').onchange = (e) => call('/api/memory/settings', 'POST', { on: e.target.checked }).catch((er) => say(er.message, 'error'));
      if ($('#w-me-priv')) $('#w-me-priv').onchange = async (e) => { if (e.target.checked && !confirm('Rendre ce projet privé efface ce que la mémoire en avait retenu. Continuer ?')) { e.target.checked = false; return; } await call('/api/memory/settings', 'POST', { project: dir, private: e.target.checked }).catch((er) => say(er.message, 'error')); draw(); };
      const go = async () => { const q = $('#w-me-q').value.trim(); if (!q) return; try { const r = await call(`/api/memory/search?q=${encodeURIComponent(q)}&project=${encodeURIComponent(dir)}`); draw(r.hits); } catch (er) { say(er.message, 'error'); } };
      $('#w-me-s').onclick = go; $('#w-me-q').onkeydown = (e) => { if (e.key === 'Enter') go(); };
      if ($('#w-me-back')) $('#w-me-back').onclick = () => draw();
      m.querySelectorAll('[data-mtab]').forEach((b) => { b.onclick = () => { tab = b.dataset.mtab; draw(); }; });
      m.querySelectorAll('[data-ndel]').forEach((b) => { b.onclick = async () => { await call(`/api/memory/notes/${b.dataset.ndel}`, 'DELETE').catch(() => {}); draw(); }; });
      m.querySelectorAll('[data-sdel]').forEach((b) => { b.onclick = async () => { await call(`/api/memory/summaries/${b.dataset.sdel}`, 'DELETE').catch(() => {}); draw(); }; });
      m.querySelectorAll('[data-nsave]').forEach((b) => { b.onclick = async () => { const r = b.closest('.w-mn'); try { await call(`/api/memory/notes/${b.dataset.nsave}`, 'PATCH', { text: r.querySelector('.w-mn-t').value, importance: Number(r.querySelector('.w-mn-i').value) }); say('Note enregistrée.'); } catch (er) { say(er.message, 'error'); } }; });
      if ($('#w-ma-ok')) $('#w-ma-ok').onclick = async () => { const text = $('#w-ma-t').value.trim(); if (!text) return; try { await call('/api/memory/notes', 'POST', { project: dir, global: tab === 'global', cat: $('#w-ma-c').value, text, importance: 4, source: 'manuel' }); draw(); } catch (er) { say(er.message, 'error'); } };
    };
    await draw();
  }

  root.addEventListener('click', async (e) => {
    if (e.target.closest('#w-mem')) { open(); return; }
    const t = e.target.closest('[data-tomem]');
    if (t) {
      const q = ctx.getMsgs().find((x) => x.id === t.closest('.w-msg')?.dataset.id); const txt = q?.parts.filter((p) => p.k === 'text').map((p) => p.text).join('\n\n') || '';
      if (!txt) return;
      const dir = ctx.getDir();
      try { await call('/api/memory/notes', 'POST', { project: dir, global: !dir, cat: 'idee', text: txt.replace(/\s+/g, ' ').slice(0, 300), importance: 4, source: 'chat' }); say('Retenu dans la mémoire du projet.'); } catch (er) { say(er.message, 'error'); }
    }
  });
  return { open };
}
