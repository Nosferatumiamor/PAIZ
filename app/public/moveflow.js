// Ranger / Invoquer : le MÊME parcours partout (onglet WeightStream, Model Dispenser, détails d'un modèle).
// Le modèle quitte un repo actif pour un repo de stockage (ranger) ou y revient (invoquer) : repo d'origine proposé d'office,
// fichiers associés (mmproj, VAE…) cochés par défaut, avertissements (repo disparu, fichier nécessaire introuvable).
import { pickRepo } from '/repos.js';

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
  document.querySelector('#toasts')?.appendChild(el); setTimeout(() => el.remove(), 5000);
}

// role : 'active' = invoquer (vers un repo actif), 'store' = ranger (vers un repo de stockage). onDone(réponse du serveur) est appelé une fois le déplacement lancé.
export async function moveFlow({ id, name, size, role, onDone = null }) {
  let info; try { info = await call(`/api/engine/move-info?assetId=${id}`); } catch (e) { say(e.message, 'error'); return; }
  const inv = role === 'active'; const o = info.origin || { state: 'none' };
  const near = (info.needs || []).filter((n) => n.assetId && n.where !== 'missing' && !n.sameSide);
  const warn = [];
  if (inv && o.state === 'gone') warn.push(`⚠ Le repo d'origine « ${esc(o.rootName)} » (${esc(o.rootPath)}) n'existe plus : choisis un autre repo actif.`);
  if (inv && o.state === 'not-active') warn.push(`⚠ « ${esc(o.rootName)} » n'est plus un repo actif : choisis-en un autre (ou redéfinis-le).`);
  for (const n of info.needs || []) if (n.where === 'missing') warn.push(`⚠ Ce modèle a besoin de <b>${esc(n.file_name)}</b> (${esc(n.role)}) — introuvable.`);
  const comp = near.length ? `<div class="hub-opts"><p class="small"><b>Fichiers associés</b> — ce modèle a besoin de :</p>${near.map((n) => `<label class="check"><input type="checkbox" class="pk-comp" value="${n.assetId}" checked> ${esc(n.role)} · ${esc(n.file_name)} <span class="muted small">(${bytes(n.size_bytes)}, ${esc(n.location?.root || '')})</span></label>`).join('')}<p class="muted small">Décocher les sépare : PAIZ retiendra que ce modèle a besoin d'eux pour fonctionner.</p></div>` : '';
  const total = Number(size) + near.reduce((n, x) => n + (x.size_bytes || 0), 0);
  const to = await pickRepo({ role, title: `${inv ? 'Invoquer' : 'Ranger'} « ${name} »`, size: total, confirmLabel: 'Déplacer ici',
    preferred: inv && o.state === 'ok' ? o.rootId : null,
    intro: `${inv ? `Le modèle (${bytes(Number(size))}) est déplacé (vérifié) du stock vers un repo actif${o.state === 'ok' ? `, <b>à l'endroit précis d'où il était parti</b> (${esc(o.path)})` : ''}. Il n'est pas lancé : utilise « Lancer ».`
      : `Le modèle (${bytes(Number(size))}) quitte le SSD pour le repo de stockage choisi. PAIZ retient d'où il vient pour le remettre exactement là avec « Invoquer ».`}${warn.length ? `<br>${warn.join('<br>')}` : ''}`,
    extra: comp, collect: (el) => [...el.querySelectorAll('.pk-comp:checked')].map((c) => Number(c.value)) });
  if (to == null) return;
  try { const r = await call('/api/engine/move', 'POST', { assetId: Number(id), toRoot: to, companionIds: pickRepo.last || [] }); say(`Déplacement lancé (${r.files} fichier(s)).`); if (onDone) onDone(r); } catch (e) { say(e.message, 'error'); }
}
