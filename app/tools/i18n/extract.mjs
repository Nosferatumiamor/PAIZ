// Inventaire des textes français de l'interface (fichiers du navigateur) : littéraux de chaînes et gabarits, découpés
// sur les balises HTML et les ${…}. Sortie : un JSON { texte: [fichiers] } trié par fréquence.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[3] || new URL('../../public', import.meta.url).pathname.replace(/^/([A-Za-z]:)/, '$1');
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|html)$/.test(e.name)) files.push(p); } };
walk(ROOT);

const FR = /[àâçéèêëîïôûùüÿœæÀÂÇÉÈÊËÎÏÔÛÙÜŒ]|\b(le|la|les|un|une|des|du|de|et|ou|pour|avec|sans|dans|sur|est|pas|ce|cette|ces|qui|que|son|sa|ses|tu|te|ton|ta|tes|vous|nous|au|aux|modèle|modèles|fichier|dossier|disque)\b/i;
const out = new Map();
const add = (t, f, html = false) => {
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length < 2 || !/[a-zA-ZÀ-ÿ]/.test(t)) return;
  if (!FR.test(t) && !(html && /^[A-ZÀ-Ý]/.test(t) && !/^[A-Z0-9_]+$/.test(t))) return;
  if (/^[\w.-]+\.(js|css|html|json|gguf|png|webp)$/i.test(t)) return;
  if (/^(https?:|\/api\/|#|\.|data:)/.test(t)) return;
  if (/[{}();=]|=>|\bconst\b|\bfunction\b|querySelector|addEventListener/.test(t) && !/[àâçéèêîôûù]/.test(t)) return;
  if (/=>|\$\(|\bconst |\bawait |\breturn |\blet |\}\)|;\s*\}|\.onclick|\.innerHTML|classList|\|\||&&/.test(t)) return; // du code, pas du texte
  const e = out.get(t) || new Set(); e.add(path.basename(f)); out.set(t, e);
};
for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  s = s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''); // commentaires
  if (f.endsWith('.html')) s = s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ');
  const lits = f.endsWith('.html') ? [s] : [...s.matchAll(/`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g)].map((m) => m[0].slice(1, -1));
  for (const lit of lits) {
    // attributs title/placeholder/aria-label
    for (const m of lit.matchAll(/\b(?:title|placeholder|aria-label|alt|data-tip)="([^"$]*)"/g)) add(m[1], f);
    const plain = lit.replace(/\b(?:title|placeholder|aria-label|alt|data-tip|class|id|style|href|src|data-[\w-]+)="[^"]*"/g, ' ');
    const html = /<[a-z]/i.test(lit);
    for (const seg of plain.split(/<[^>]*>|\$\{(?:[^{}]|\{[^{}]*\})*\}/)) add(seg.replace(/\\n/g, ' ').replace(/\\'/g, "'"), f, html);
  }
}
const arr = [...out.entries()].map(([t, fs]) => ({ t, f: [...fs] })).sort((a, b) => a.t.localeCompare(b.t, 'fr'));
fs.writeFileSync(process.argv[2], JSON.stringify(arr, null, 0));
const chars = arr.reduce((n, x) => n + x.t.length, 0);
console.log(arr.length, 'textes ·', chars, 'caractères');
const by = {}; for (const x of arr) for (const f of x.f) by[f] = (by[f] || 0) + 1; console.log(by);
