// Langue de l'interface (anglais / français). L'interface est écrite en français ; l'anglais vient d'un dictionnaire
// français -> anglais (i18n-en.js). Un traducteur parcourt la page et traduit au vol les textes, les infobulles et les
// champs, puis tout ce qui s'ajoute ensuite. Une traduction manquante laisse simplement le texte français : rien ne casse.
// Jamais traduit : les messages de la discussion (ceux du modèle et les tiens), les zones de saisie, le code, les chemins.
import { PAIRS, RULES } from '/i18n-en.js';

const KEY = 'paiz.lang';
export function getLang() { try { const l = localStorage.getItem(KEY); return l === 'fr' || l === 'en' ? l : 'en'; } catch { return 'en'; } }
export function setLang(l) { try { localStorage.setItem(KEY, l); } catch { /* stockage indisponible */ } location.reload(); }

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const EXACT_CS = new Map(PAIRS.map(([fr, en]) => [norm(fr), en])); // la casse d'abord (« Modèles » ≠ « MODÈLES »)
const EXACT = new Map(PAIRS.map(([fr, en]) => [norm(fr).toLowerCase(), en]));
const FRENCH = /[àâçéèêëîïôûùüœ]|(^|[^\p{L}])(le|la|les|des|du|une|et|est|pour|avec|dans|sur|pas|que|qui|tu|ton|ta|tes|ce|cette|aux|au|il|elle|sont|ou|un|aussi|dernier|travail|reprendre|lancement|selon)(?=$|[^\p{L}])/iu;
// morceaux (phrases entourant une valeur : « ${n} modèle(s) ») : remplacés à l'intérieur d'un texte plus long, du plus long au plus court
const PARTS = PAIRS.map(([fr, en]) => [norm(fr), en]).filter(([fr]) => fr.length >= 5).sort((a, b) => b[0].length - a[0].length);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PART_RE = PARTS.map(([fr, en]) => [new RegExp(`(^|[^\\p{L}])${esc(fr)}(?=$|[^\\p{L}])`, 'gu'), en]);

const words = (t) => t.toLowerCase().match(/[\p{L}]{3,}/gu) || [];
const PART_WORDS = new Set(PARTS.flatMap(([fr]) => words(fr))); // un texte sans aucun de ces mots (nom de modèle, chemin) n'est pas fouillé

/** Traduit un texte (français -> anglais) ; renvoie le texte tel quel s'il n'y a rien à traduire. */
export function tr(text) {
  if (getLang() === 'fr' || !text || !/[\p{L}]/u.test(text)) return text;
  const lead = text.match(/^\s*/)[0]; const trail = text.match(/\s*$/)[0]; const core = norm(text);
  const hit = EXACT_CS.get(core) ?? EXACT.get(core.toLowerCase());
  if (hit != null) return lead + hit + trail;
  let out = core;
  for (const [re, en] of RULES) out = out.replace(re, en);
  if (out !== core && EXACT.has(out.toLowerCase())) return lead + EXACT.get(out.toLowerCase()) + trail;
  if (words(out).some((w) => PART_WORDS.has(w))) for (const [re, en] of PART_RE) { re.lastIndex = 0; if (re.test(out)) { re.lastIndex = 0; out = out.replace(re, (m, pre) => pre + en); } }
  if (out === core || FRENCH.test(out.replace(/Léa|Léo/g, ''))) return text; // à moitié traduit : mieux vaut le français que du franglais
  return lead + out + trail;
}

const SKIP = 'script, style, textarea, code, pre, kbd, .w-msg .w-para, .w-test-log .w-para, #wt-livetext, .bubble.me, [data-noi18n], .v2-path, .loc-sub, .name-sub, .w-th, .path';
const ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip'];
const done = new WeakSet();
function walk(root) {
  if (getLang() === 'fr' || !root) return;
  if (root.nodeType === 3) { tText(root); return; }
  if (root.nodeType !== 1) return;
  // les champs de saisie : on traduit leurs infobulles et leur texte d'aide (placeholder), jamais ce qu'on y tape
  if (root.matches?.('input, textarea, select')) { tAttrs(root); return; }
  root.querySelectorAll?.('input, textarea').forEach(tAttrs);
  if (root.closest?.(SKIP)) return;
  tAttrs(root);
  const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: (n) => (n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  for (let n = it.nextNode(); n; n = it.nextNode()) { if (n.nodeType === 3) tText(n); else tAttrs(n); }
}
function tText(n) {
  if (done.has(n) || !n.nodeValue || !/[\p{L}]/u.test(n.nodeValue)) return;
  if (n.parentElement?.closest(SKIP)) return;
  const t = tr(n.nodeValue); done.add(n); if (t !== n.nodeValue) n.nodeValue = t;
}
function tAttrs(el) {
  for (const a of ATTRS) { const v = el.getAttribute?.(a); if (v && !el.dataset?.[`i18n_${a.replace(/-/g, '_')}`]) { const t = tr(v); if (t !== v) el.setAttribute(a, t); if (el.dataset) el.dataset[`i18n_${a.replace(/-/g, '_')}`] = '1'; } }
  if (el.tagName === 'OPTION' && el.firstChild?.nodeType === 3) tText(el.firstChild);
}

let queue = new Set(); let scheduled = false;
function flush() { scheduled = false; const q = queue; queue = new Set(); for (const n of q) walk(n); }
export function startI18n() {
  document.documentElement.lang = getLang();
  if (getLang() === 'fr') return;
  walk(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') { done.delete(m.target); queue.add(m.target); }
      else if (m.type === 'attributes') { if (m.target.dataset) delete m.target.dataset[`i18n_${m.attributeName.replace(/-/g, '_')}`]; queue.add(m.target); }
      else for (const n of m.addedNodes) queue.add(n);
    }
    if (!scheduled && queue.size) { scheduled = true; queueMicrotask(flush); }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  // fenêtres de confirmation du navigateur
  const wrap = (f) => (msg, ...rest) => f.call(window, tr(String(msg ?? '')), ...rest);
  window.confirm = wrap(window.confirm); window.alert = wrap(window.alert); window.prompt = wrap(window.prompt);
  const t = document.title; if (t) document.title = tr(t);
}
startI18n();
