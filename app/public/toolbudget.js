// Budget d'outils de l'agent (profils d'usage, cases, pastilles, mode manuel / auto) : partagé par l'écran Travail (fenêtre ⚖ Outils)
// et la barre de contrôle. Les réglages vivent côté serveur (/api/tools/budget) ; ici on ne fait qu'afficher et envoyer les choix.
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function call(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status}`);
  return d;
}
function say(msg, kind = '') {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg;
  $('#toasts')?.appendChild(el); setTimeout(() => el.remove(), 7000);
}
// ---- Budget d'outils de l'agent : profils d'usage, cases, pastilles, mode manuel / auto
const tb = { d: null, open: true, el: null };
const BUBBLE = { green: ['#22c55e', 'important : appelé récemment (ou outil de base)'], orange: ['#f59e0b', 'discutable : peu ou plus utilisé, ou pas encore assez de recul'], red: ['#ef4444', 'inutile : jamais appelé depuis le début de cette conversation'], black: ['#111827', 'désactivé : le modèle ne le voit pas'] };
export async function loadToolBudget() { return loadBudget(); }
async function loadBudget() { try { tb.d = await call('/api/tools/budget'); paintBudget(); } catch { /* serveur pas prêt */ } }
async function setBudgetOpt(patch) { try { tb.d = await call('/api/tools/budget', 'POST', patch); paintBudget(); } catch (e) { say(e.message, 'error'); } }
function paintBudget() {
  const el = tb.el; const d = tb.d; if (!el || !d) return;
  const cfg = d.cfg; const v = d.view; const cost = d.changeCostS;
  const prof = d.profiles.find((p) => p.id === cfg.profile) || d.profiles[0];
  const rows = v ? v.rows : [];
  const offeredTok = rows.filter((r) => r.on).reduce((s, r) => s + r.tokens, 0); const allTok = rows.reduce((s, r) => s + r.tokens, 0);
  const sug = d.suggest;
  const costTxt = cost ? `≈ ${cost} s` : 'quelques secondes';
  const lockTitle = (r) => (r.locked ? 'Verrouillé : jamais éteint automatiquement' : 'Verrouiller : ne jamais l’éteindre automatiquement');
  el.innerHTML = `<div class="panel-head"><h2>⚖ Outils de l'agent — alléger le prompt</h2>
    <p class="muted">Chaque outil proposé au modèle est du texte qu'il doit relire à chaque nouvelle session (≈ 3 s par millier de tokens). Moins d'outils inutiles = réponse plus rapide au démarrage, avec la même qualité tant que le modèle n'a pas besoin de ce qu'on retire. <b>Choisis un profil selon ce que tu veux faire</b> ; tu peux en changer à tout moment, même en pleine session : le changement fait relire le prompt une fois (${costTxt} au maximum sur la conversation vue ci-dessous).</p></div>
    <div class="tb-profiles">${d.profiles.map((p) => `<button class="btn ${p.id === cfg.profile ? 'primary' : ''}" data-tbp="${esc(p.id)}" title="${esc(p.desc)}">${p.icon} ${esc(p.label)}</button>`).join('')}</div>
    <div class="muted small" style="margin:6px 0 10px"><b>${esc(prof.label)}</b> : ${esc(prof.desc)}</div>
    <div class="toolbar"><span class="muted small">Gestion :</span>
      <label class="check"><input type="radio" name="tb-mode" value="manual" ${cfg.mode === 'manual' ? 'checked' : ''}> Manuelle <span class="muted small">— je te signale, tu décides</span></label>
      <label class="check"><input type="radio" name="tb-mode" value="auto" ${cfg.mode === 'auto' ? 'checked' : ''}> Automatique <span class="muted small">— un outil resté rouge ${d.thresholds.autoStreak} requêtes de suite est éteint (🔒 = jamais)</span></label></div>
    ${cfg.mode === 'manual' && sug && sug.tokens > 0 ? `<div class="tb-tip">💡 Allègement possible : <b>≈ ${sug.tokens} tokens</b> d'outils jamais appelés (${sug.names.map(esc).join(', ')}). <button class="btn small" id="tb-apply">Éteindre ces outils</button></div>` : ''}
    ${mcpHtml(d.mcp)}
    <details ${tb.open ? 'open' : ''} id="tb-det"><summary>${v ? `Dernière requête vue : ${v.turns} message(s) · prompt ≈ ${v.promptTok} tokens · outils proposés ≈ ${offeredTok} sur ${allTok} tokens (${rows.filter((r) => r.on).length}/${rows.length})` : 'Aucune requête vue pour l’instant'}</summary>
    ${v ? `<table class="tb-table"><thead><tr><th></th><th></th><th>Outil</th><th>Poids</th><th>Usage</th><th>🔒</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr class="${r.on ? '' : 'tb-off'}">
        <td><input type="checkbox" data-tbt="${esc(r.name)}" ${r.on ? 'checked' : ''} title="${r.on ? 'Proposé au modèle : décoche pour le retirer' : 'Retiré : coche pour le proposer'}"></td>
        <td><span class="tb-dot" style="background:${BUBBLE[r.state][0]}" title="${esc(BUBBLE[r.state][1])}"></span></td>
        <td><b>${esc(r.name)}</b>${r.core ? ' <span class="badge">base</span>' : ''}</td>
        <td>≈ ${r.tokens} tok ${r.tokens >= d.thresholds.heavyTokens ? '<span class="badge tw" title="Outil lourd">⚠ lourd</span>' : ''}</td>
        <td class="muted small">${r.calls ? `${r.calls} appel(s), il y a ${r.turnsSince} message(s)` : 'jamais appelé'}</td>
        <td><button class="btn small ghost" data-tbl="${esc(r.name)}" title="${esc(lockTitle(r))}">${r.locked ? '🔒' : '🔓'}</button></td>
        <td class="muted small">${esc(r.why)}</td></tr>`).join('')}</tbody></table>
      <div class="muted small" style="margin-top:6px">Pastilles : <span class="tb-dot" style="background:#22c55e"></span> important · <span class="tb-dot" style="background:#f59e0b"></span> discutable · <span class="tb-dot" style="background:#ef4444"></span> inutile · <span class="tb-dot" style="background:#111827"></span> désactivé. Le modèle ne peut pas appeler un outil retiré ; recoche-le et il revient à la requête suivante.</div>` : '<p class="muted small" style="margin-top:8px">Lance une conversation (écran Travail ou OpenCode) : la liste des outils réellement envoyés au modèle apparaît ici.</p>'}</details>`;
  $('#tb-det').ontoggle = (e) => { tb.open = e.target.open; };
  el.querySelectorAll('input[name="tb-mcp"]').forEach((r) => { r.onchange = () => setBudgetOpt({ mcpSelect: r.value }); });
  el.querySelectorAll('[data-tbp]').forEach((b) => { b.onclick = () => setBudgetOpt({ profile: b.dataset.tbp }); });
  el.querySelectorAll('input[name="tb-mode"]').forEach((r) => { r.onchange = () => setBudgetOpt({ mode: r.value }); });
  el.querySelectorAll('[data-tbt]').forEach((c) => { c.onchange = () => setBudgetOpt({ toggle: { name: c.dataset.tbt, on: c.checked } }); });
  el.querySelectorAll('[data-tbl]').forEach((b) => { const r = rows.find((x) => x.name === b.dataset.tbl); b.onclick = () => setBudgetOpt({ lock: { name: b.dataset.tbl, locked: !r.locked } }); });
  const ap = $('#tb-apply'); if (ap) ap.onclick = async () => { for (const n of sug.names) tb.d = await call('/api/tools/budget', 'POST', { toggle: { name: n, on: false } }); paintBudget(); };
}
// serveurs MCP choisis selon la question (idée d'AnythingLLM) : ceux dont la conversation ne parle pas sont retirés du prompt
function mcpHtml(m) {
  if (!m) return '';
  const kept = m.kept || []; const dropped = m.dropped || [];
  const last = kept.length || dropped.length ? `<div class="muted small" style="margin-top:4px">Dernière requête : ${kept.length ? `gardés ${kept.map((k) => `<b>${esc(k.ns)}</b> (${esc(k.why)})`).join(', ')}` : 'aucun serveur gardé'}${dropped.length ? ` · écartés ${dropped.map((x) => esc(x.ns)).join(', ')}` : ''}${m.savedTok ? ` · <b>≈ ${m.savedTok} jetons retirés du prompt, ≈ ${m.savedS} s de lecture évitées</b>` : ''}.</div>` : '';
  return `<div class="tb-tip" style="margin-bottom:10px"><b>Serveurs MCP</b> : <label class="check"><input type="radio" name="tb-mcp" value="smart" ${m.mode !== 'all' ? 'checked' : ''}> choisis selon la question</label>
    <label class="check"><input type="radio" name="tb-mcp" value="all" ${m.mode === 'all' ? 'checked' : ''}> tous ceux activés</label>
    <div class="muted small">Un serveur dont la conversation ne parle pas (ni son nom, ni ce qu'il fait) n'est pas présenté au modèle : prompt plus court, premier mot plus rapide. Il revient dès que tu en parles.</div>${last}</div>`;
}
export function mountToolBudget(el) { tb.el = el; loadBudget(); return loadBudget; }
// changement de profil depuis la barre de contrôle ou l'écran de démarrage ; onDone = rafraîchir l'état affiché
export async function chooseToolProfile(profile) { tb.d = await call('/api/tools/budget', 'POST', { profile }); paintBudget(); return tb.d; }
setInterval(() => { if (tb.el?.offsetParent) loadBudget(); }, 4000);

