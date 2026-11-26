// Repos de modèles : « repos actifs » (SSD de travail, où les modèles tournent) et « repos de stockage » (disques spacieux, même lents).
// Un repo = un dossier d'un disque ; on peut en définir plusieurs de chaque sorte. Deux fenêtres : gérer les repos d'un rôle, et choisir un repo pour une action (Invoquer / Ranger).
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

export const ROLE = {
  active: { title: 'Repos actifs', one: 'repo actif', ico: '🔥', hint: 'Sélectionnez un SSD', desc: 'Les dossiers du SSD de travail où les modèles sont chargés (rapide). Tu peux en définir plusieurs : par exemple C:\\llm-models et un autre dossier.', other: 'stockage' },
  store: { title: 'Repos de stockage', one: 'repo de stockage', ico: '🗄', hint: 'Choisir des disques spacieux, pas besoin de SSD', desc: 'Les dossiers où ranger les modèles que tu n\'utilises pas en ce moment : disque dur, disque externe… la vitesse importe peu.', other: 'actif' },
};
const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
const margin = (size) => Math.max(256 * 1048576, size * 0.01);
const rootLine = (r) => `<b>${esc(r.name)}</b> <span class="badge soft">${esc(r.volume || '')}</span> <span class="muted small">${esc(r.path)}</span>`;
const spaceTxt = (r) => (!r.exists ? '<span style="color:var(--danger)">hors ligne</span>' : r.free != null ? `${bytes(r.free)} libres / ${bytes(r.total)}` : '');
const rootsOf = async () => (await call('/api/roots')).roots;

function open(html) { const root = $('#modal-root'); root.innerHTML = `<div class="modal-backdrop" id="rp-bd"><div class="modal">${html}</div></div>`; return root; }
export const closeRepoDialog = () => { $('#modal-root').innerHTML = ''; };

// ---- gérer les repos d'un rôle (ajouter, retirer, reprendre un dossier déjà connu)
export async function reposDialog(role, onChange = () => {}) {
  const meta = ROLE[role];
  const paint = async () => {
    let roots; try { roots = await rootsOf(); } catch (e) { say(e.message, 'error'); return; }
    const mine = roots.filter((r) => r.role === role);
    const others = roots.filter((r) => r.role !== role);
    const el = open(`<div class="modal-head"><h3>${meta.ico} ${esc(meta.title)}</h3><button class="modal-close" id="rp-x" title="Fermer">×</button></div>
      <div class="modal-body"><p class="muted small">${esc(meta.desc)}</p>
        <h4 class="hub-h">Dossiers définis (${mine.length})</h4>
        ${mine.length ? mine.map((r) => `<div class="hub-opt"><span class="grow">${rootLine(r)}<div class="muted small">${spaceTxt(r)}</div></span><button class="btn ghost small" data-rm="${r.id}" data-name="${esc(r.name)}">Retirer</button></div>`).join('') : `<p class="muted">Aucun pour l'instant : ajoute un dossier ci-dessous.</p>`}
        <h4 class="hub-h">Ajouter un dossier</h4>
        <div class="toolbar"><input id="rp-path" class="input grow" placeholder="Dossier (ex. C:\\llm-models)"><button class="btn" id="rp-browse">Parcourir…</button></div>
        <div class="toolbar" style="margin-top:6px"><input id="rp-name" class="input" placeholder="Nom (facultatif)" style="max-width:260px"><button class="btn primary" id="rp-add">Ajouter comme ${esc(meta.one)}</button></div>
        <p class="muted small">Le dossier est créé s'il n'existe pas. Rien n'est déplacé ni supprimé : PAIZ le surveille et y range les modèles quand tu le demandes. Un modèle déjà présent dans ce dossier apparaît après un scan.</p>
        ${others.length ? `<h4 class="hub-h">Dossiers déjà connus (${esc(meta.other)})</h4>${others.map((r) => `<div class="hub-opt"><span class="grow">${rootLine(r)} <span class="badge soft">${esc(r.role)}</span></span><button class="btn small" data-use="${r.id}">Passer en ${esc(meta.one)}</button></div>`).join('')}` : ''}
      </div><div class="modal-foot"><button class="btn primary" id="rp-done">Terminé</button></div>`);
    $('#rp-x').onclick = $('#rp-done').onclick = closeRepoDialog;
    $('#rp-bd').onmousedown = (e) => { if (e.target.id === 'rp-bd') closeRepoDialog(); };
    $('#rp-browse').onclick = async () => { try { const r = await call('/api/pick-folder', 'POST', { start: $('#rp-path').value }); if (r.path) { $('#rp-path').value = r.path; if (!$('#rp-name').value) $('#rp-name').value = baseName(r.path); } } catch (e) { say(e.message, 'error'); } };
    $('#rp-add').onclick = async () => {
      const path = $('#rp-path').value.trim(); if (!path) { say('Indique un dossier.', 'error'); return; }
      const name = $('#rp-name').value.trim() || baseName(path) || path;
      try { await call('/api/roots', 'POST', { name, path, role }); say(`« ${name} » ajouté.`); onChange(); await paint(); } catch (e) { say(e.message, 'error'); }
    };
    el.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = async () => {
      if (!confirm(`Retirer « ${b.dataset.name} » des repos ?\n\nLes fichiers ne sont pas supprimés ; PAIZ cesse seulement de surveiller ce dossier (les modèles qu'il contient ne seront plus gérés).`)) return;
      try { await call(`/api/roots/${b.dataset.rm}`, 'DELETE'); onChange(); await paint(); } catch (e) { say(e.message, 'error'); } }; });
    el.querySelectorAll('[data-use]').forEach((b) => { b.onclick = async () => { try { await call(`/api/roots/${b.dataset.use}`, 'PATCH', { role }); onChange(); await paint(); } catch (e) { say(e.message, 'error'); } }; });
  };
  await paint();
}

// ---- choisir UN repo pour une action ; renvoie l'id du repo, ou null si annulé. `size` : octets à placer (contrôle de place)
export async function pickRepo({ role, title, intro, size = 0, confirmLabel, current = null, extra = '', preferred = null, collect = null }) {
  pickRepo.last = null;
  const meta = ROLE[role];
  let roots; try { roots = (await rootsOf()).filter((r) => r.role === role && r.enabled !== 0); } catch (e) { say(e.message, 'error'); return null; }
  return new Promise((resolve) => {
    let chosen = null;
    const done = (v) => { closeRepoDialog(); resolve(v); };
    const fits = (r) => r.exists && (r.free == null || r.id === current || r.free >= size + margin(size));
    const firstOk = roots.find((r) => r.id === preferred && fits(r)) || roots.find(fits);
    chosen = firstOk ? firstOk.id : null;
    const el = open(`<div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" id="pk-x" title="Annuler">×</button></div>
      <div class="modal-body"><p class="muted small">${intro}</p>
        ${roots.length ? roots.map((r) => `<label class="hub-opt ${fits(r) ? '' : 'off'} ${r.id === chosen ? 'on' : ''}"><input type="radio" name="pk" value="${r.id}" ${r.id === chosen ? 'checked' : ''} ${fits(r) ? '' : 'disabled'}>
          <span class="grow">${rootLine(r)}<div class="muted small">${spaceTxt(r)}${r.id === current ? ' · le modèle est déjà là' : ''}${r.id === preferred ? ' · <b style="color:var(--accent)">↩ endroit d\'origine</b>' : ''}${!fits(r) && r.exists ? ' · <span style="color:var(--danger)">pas assez de place</span>' : ''}</div></span></label>`).join('')
          : `<p>Aucun ${esc(meta.one)} défini. <button class="btn small" id="pk-define">Définir des repos</button></p>`}
        ${extra}</div>
      <div class="modal-foot"><button class="btn ghost" id="pk-manage">Gérer les repos…</button><span class="grow"></span><button class="btn" id="pk-cancel">Annuler</button><button class="btn primary" id="pk-ok" ${chosen == null ? 'disabled' : ''}>${esc(confirmLabel)}</button></div>`);
    $('#pk-x').onclick = $('#pk-cancel').onclick = () => done(null);
    $('#rp-bd').onmousedown = (e) => { if (e.target.id === 'rp-bd') done(null); };
    el.querySelectorAll('[name="pk"]').forEach((r) => { r.onchange = () => { chosen = Number(r.value); $('#pk-ok').disabled = false; el.querySelectorAll('.hub-opt').forEach((o) => o.classList.toggle('on', o.contains(r))); }; });
    $('#pk-ok').onclick = () => { pickRepo.last = collect ? collect(el) : null; done(chosen); };
    const manage = () => { resolve(null); reposDialog(role, () => window.dispatchEvent(new Event('paiz:repos'))); };
    $('#pk-manage').onclick = manage; if ($('#pk-define')) $('#pk-define').onclick = manage;
  });
}
