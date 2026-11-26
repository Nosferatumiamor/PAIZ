// Assistant de premier lancement : dossier des modèles prêts à lancer (sur un SSD), écurie / réserve (n'importe quel disque
// avec de la place), OpenCode Desktop, et premiers modèles (Gemma 4 conseillé, Qwen3-Coder-Next 48 Go en option).
// S'ouvre seul tant qu'aucun dossier n'est suivi ; sinon depuis Modèles › Dossiers (« Assistant de démarrage »).
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gb = (n) => `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1).replace('.', ',')} Go`;
async function call(p, method = 'GET', body) {
  const r = await fetch(p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `${r.status}`); return d;
}
function say(msg, kind = '') { const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg; $('#toasts')?.appendChild(el); setTimeout(() => el.remove(), 6000); }

const KIND = { ssd: '⚡ SSD', hdd: '🐢 disque dur', unknown: '? type inconnu' };
const W = { st: null, ready: null, reserve: null, models: new Set(), busy: false };

function driveOpt(d, forReady) {
  const warn = forReady && d.kind !== 'ssd' ? ' — trop lent pour lancer des modèles' : '';
  return `<option value="${esc(d.path)}">${esc(d.path)} · ${KIND[d.kind]}${d.nvme ? ' NVMe' : ''}${d.usb ? ' (USB)' : ''} · ${gb(d.free)} libres${warn}</option>`;
}
function paint() {
  const m = $('#v2-setup'); const st = W.st; if (!m || !st) return;
  const activeRoot = st.roots.find((r) => r.role === 'active'); const storeRoot = st.roots.find((r) => r.role === 'store');
  const ssd = st.drives.filter((d) => d.kind === 'ssd').sort((a, b) => b.nvme - a.nvme || b.free - a.free);
  const readyList = [...ssd, ...st.drives.filter((d) => d.kind !== 'ssd')];
  const reserveList = [...st.drives].sort((a, b) => b.free - a.free);
  W.ready ??= activeRoot ? { root: activeRoot } : readyList[0] ? { drive: readyList[0].path } : null;
  W.reserve ??= storeRoot ? { root: storeRoot } : reserveList.find((d) => !W.ready?.drive || d.path !== W.ready.drive) ? { drive: reserveList.find((d) => !W.ready?.drive || d.path !== W.ready.drive).path } : null;
  const where = (sel) => (sel?.root ? `<b>${esc(sel.root.path)}</b> (déjà suivi)` : sel?.custom ? `<b>${esc(sel.custom)}</b>` : sel?.drive ? `<b>${esc(sel.drive)}\\PAIZ\\${sel === W.ready ? 'Ready' : 'Reserve'}</b>` : '<i>à choisir</i>');
  const readyDrive = st.drives.find((d) => d.path === (W.ready?.drive || (W.ready?.root?.path || W.ready?.custom || '').slice(0, 2).toUpperCase()));
  const need = st.models.filter((x) => W.models.has(x.key) && !x.present).reduce((s, x) => s + x.size, 0);
  const tooSmall = readyDrive && need > readyDrive.free - 2e9;
  m.innerHTML = `<div class="v2-modal-box v2-setup">
    <h2>Bienvenue dans PAIZ</h2>
    <p class="v2-muted">Trois choses à mettre en place. Tout se change plus tard dans Modèles › Dossiers.</p>
    <section><h3>1. Dossier des modèles prêts à lancer — sur un SSD</h3>
      <p class="v2-muted">PAIZ lit les modèles pendant qu'il écrit : ils doivent être sur un SSD (NVMe de préférence). Un disque dur est bien trop lent ici.</p>
      <div class="v2-root-a">${activeRoot ? '' : `<select id="su-ready" class="v2-sel">${readyList.map((d) => driveOpt(d, true)).join('')}</select>`}<button class="v2-btn s" id="su-ready-pick">Choisir un dossier…</button></div>
      <p>→ ${where(W.ready)}</p></section>
    <section><h3>2. Écurie (réserve) — n'importe quel disque avec de la place</h3>
      <p class="v2-muted">Les modèles que tu ne lances pas sont rangés ici, classés proprement avec un catalogue. Un grand disque dur ou externe convient très bien.</p>
      <div class="v2-root-a">${storeRoot ? '' : `<select id="su-res" class="v2-sel">${reserveList.map((d) => driveOpt(d, false)).join('')}</select>`}<button class="v2-btn s" id="su-res-pick">Choisir un dossier…</button></div>
      <p>→ ${where(W.reserve)}</p></section>
    <section><h3>3. OpenCode — pour la discussion et les tâches</h3>
      ${st.opencode.installed ? '<p>✔ OpenCode est installé.</p>' : `<p class="v2-muted">PAIZ pilote ses conversations et ses tâches avec OpenCode Desktop (gratuit). Son installeur officiel s'ouvrira : valide-le, puis reviens ici.</p><div class="v2-root-a"><button class="v2-btn" id="su-oc">Télécharger et installer OpenCode</button><span class="v2-muted" id="su-oc-st"></span></div>`}</section>
    <section><h3>4. Premiers modèles</h3>
      ${st.models.map((x) => `<label class="v2-check su-model"><input type="checkbox" data-mk="${x.key}" ${W.models.has(x.key) ? 'checked' : ''} ${x.present ? 'disabled' : ''}> <b>${esc(x.label)}</b> · ${gb(x.size)}${x.present ? ' · ✔ déjà là' : ''}${x.key === 'qwen' && st.machine.ramGb < 30 ? ' · ⚠ ta machine a ' + st.machine.ramGb + ' Go de RAM' : ''}<br><span class="v2-muted">${esc(x.note)}</span></label>`).join('')}
      <p class="v2-muted">Téléchargés depuis Hugging Face dans le dossier prêt à lancer. La progression s'affiche dans Modèles.${need ? ` Total : ${gb(need)}.` : ''}</p>
      ${tooSmall ? `<p class="v2-root-w">Pas assez de place sur ${esc(readyDrive.path)} (${gb(readyDrive.free)} libres) : décoche un modèle ou choisis un autre SSD.</p>` : ''}</section>
    <div class="v2-root-a" style="margin-top:14px"><button class="v2-btn p" id="su-go" ${W.busy || !W.ready || !W.reserve || tooSmall ? 'disabled' : ''}>${W.busy ? 'Mise en place…' : 'Tout mettre en place'}</button><button class="v2-btn ghost" id="su-later">Plus tard</button></div>
  </div>`;
  bind(m);
}
function bind(m) {
  $('#su-ready', m) && ($('#su-ready', m).value = W.ready?.drive || $('#su-ready', m).value);
  $('#su-res', m) && ($('#su-res', m).value = W.reserve?.drive || $('#su-res', m).value);
  $('#su-ready', m)?.addEventListener('change', (e) => { W.ready = { drive: e.target.value }; paint(); });
  $('#su-res', m)?.addEventListener('change', (e) => { W.reserve = { drive: e.target.value }; paint(); });
  const pick = (key) => async () => { try { const r = await call('/api/pick-folder', 'POST', {}); if (r.path) { W[key] = { custom: r.path }; paint(); } } catch (e) { say(e.message, 'error'); } };
  $('#su-ready-pick', m).onclick = pick('ready'); $('#su-res-pick', m).onclick = pick('reserve');
  m.querySelectorAll('[data-mk]').forEach((c) => { c.onchange = () => { if (c.checked) W.models.add(c.dataset.mk); else W.models.delete(c.dataset.mk); paint(); }; });
  $('#su-oc', m)?.addEventListener('click', installOc);
  $('#su-later', m).onclick = () => { m.hidden = true; };
  $('#su-go', m).onclick = apply;
}
async function installOc() {
  try { await call('/api/setup/opencode', 'POST'); } catch (e) { say(e.message, 'error'); return; }
  const t = setInterval(async () => {
    const j = await call('/api/setup/opencode').catch(() => null); const el = $('#su-oc-st'); if (!j) return;
    if (el) el.textContent = j.state === 'download' ? `téléchargement… ${j.total ? Math.round((j.bytes / j.total) * 100) + ' %' : gb(j.bytes)}` : j.state === 'installer' ? 'installeur ouvert : valide-le' : j.state === 'error' ? `échec : ${j.error}` : '';
    if (j.installed || j.state === 'error') { clearInterval(t); if (j.installed) { W.st = await call('/api/setup'); paint(); say('OpenCode est installé.'); } }
  }, 1500);
}
async function makeRoot(sel, role) {
  if (sel.root) return sel.root;
  if (sel.drive) return call('/api/roots/standard', 'POST', { drive: sel.drive, role });
  const base = sel.custom.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || sel.custom;
  return call('/api/roots', 'POST', { name: base, path: sel.custom, role });
}
async function apply() {
  W.busy = true; paint();
  try {
    const ready = await makeRoot(W.ready, 'active'); await makeRoot(W.reserve, 'store');
    const readyId = ready.id ?? ready.root?.id;
    for (const x of W.st.models.filter((mm) => W.models.has(mm.key) && !mm.present)) {
      await call('/api/hub/download', 'POST', { id: x.id, files: [{ path: x.file, size: x.size }], toRoot: readyId });
    }
    await call('/api/setup/done', 'POST');
    $('#v2-setup').hidden = true;
    say(W.models.size ? 'C\'est en place. Les modèles se téléchargent : suis-les dans Modèles.' : 'C\'est en place.');
    window.paizV2?.setGroup('models', 'collection');
  } catch (e) { say(e.message, 'error'); }
  W.busy = false; if (!$('#v2-setup')?.hidden) paint();
}
export async function openSetup() {
  try { W.st = await call('/api/setup'); } catch (e) { say(e.message, 'error'); return; }
  W.ready = null; W.reserve = null; W.models = new Set(W.st.models.filter((x) => x.recommended && !x.present).map((x) => x.key));
  let m = $('#v2-setup'); if (!m) { m = document.createElement('div'); m.id = 'v2-setup'; m.className = 'v2-modal'; document.body.appendChild(m); }
  m.hidden = false; paint();
}
window.paizSetup = { open: openSetup };
// ouverture automatique : tant que rien n'est en place (aucun dossier suivi, assistant jamais terminé)
call('/api/setup').then((st) => { if (!st.done && !st.roots.length) openSetup(); }).catch(() => {});
