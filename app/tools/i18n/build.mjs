// Assemble public/i18n-en.js : paires [français, anglais] (inventaire + traductions + ajouts à la main) et règles (unités, mois).
import fs from 'node:fs';
const dir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const todo = new Map(fs.readFileSync(dir + 'todo.txt', 'utf8').split('\n').map((l) => { const i = l.indexOf('\t'); return [l.slice(0, i), l.slice(i + 1)]; }));
const pairs = new Map();
for (const f of fs.readdirSync(dir).filter((n) => /^en-\d+\.txt$/.test(n)).sort()) {
  for (const l of fs.readFileSync(dir + f, 'utf8').split('\n')) {
    const i = l.indexOf('\t'); if (i < 0) continue;
    const id = l.slice(0, i).trim(); const en = l.slice(i + 1).replace(/\r$/, '');
    const fr = todo.get(id); if (fr == null || en.trim() === '-' || !en.trim()) continue;
    pairs.set(fr.trim(), en.trim());
  }
}
const extra = JSON.parse(fs.readFileSync(dir + 'extra.json', 'utf8'));
for (const [fr, en] of extra) pairs.set(fr, en);
const arr = [...pairs.entries()];
const RULES = `[
  // phrases qui contiennent des valeurs (avant les unités, pour reconnaître la phrase entière)
  [/^(\\d+) fichier\\(s\\) GGUF : de ([\\d,]+) à ([\\d,]+) Go selon la quantification$/, (m, n, a, b) => n + ' GGUF file(s): ' + a.replace(',', '.') + ' to ' + b.replace(',', '.') + ' GB depending on quantisation'],
  [/^([\\d.,]+)(\\s|\\u00a0)?(o|Ko|Mo|Go|To) · modifié (\\S+)$/, '$1 $3 · modified $4'],
  [/^(\\d+)\\s?% utilisé$/, '$1% used'],
  [/^(\\d+) affiché\\(s\\) sur (\\d+)$/, '$1 shown of $2'],
  [/^Modèle à experts \\(MoE\\) : (\\d+|\\?) experts sur (\\d+|\\?) par mot\\. PAIZ le streame : il tourne avec bien moins de mémoire\\.$/, 'Mixture-of-experts (MoE) model: $1 of $2 experts per word. PAIZ streams it: it runs with much less memory.'],
  [/^oui : MoE, (\\d+|\\?) experts sur (\\d+|\\?) par mot$/, 'yes: MoE, $1 of $2 experts per word'],
  [/^([\\d.,]+ ?(?:Go|Mo|Ko)) de bibliothèques d'applis \\(non inclus dans la chasse d'eau\\)$/, "$1 of app libraries (not included in the flush)"],
  [/^(\\d+) fois$/, '$1 times'], [/^Dernière fois (.+)\\.$/, 'Last time $1.'],
  [/^(\\d+) modèle\\(s\\) sur les disques rapides, sans usage récent$/, '$1 model(s) on the fast disks, not used recently'],
  [/^(\\d+) fichier\\(s\\) en plusieurs copies · fusion sans rien casser$/, '$1 file(s) in several copies · merge without breaking anything'],
  [/^(\\d+) élément\\(s\\) : fichiers temporaires, téléchargements interrompus, dossiers vides$/, '$1 item(s): temporary files, interrupted downloads, empty folders'],
  [/^(\\d+) disque\\(s\\) · aucun signe de fatigue$/, '$1 disk(s) · no sign of wear'], [/^(\\d+) disque\\(s\\) · (.+)$/, '$1 disk(s) · $2'],
  [/^(\\d+) à surveiller$/, '$1 to watch'], [/^(\\d+) en danger$/, '$1 at risk'], [/^(\\d+) à lier$/, '$1 to link'], [/^(\\d+) appli\\(s\\)$/, '$1 app(s)'],
  [/^Version légère de (.+) \\((.+)\\) en préparation$/, 'Light version of $1 ($2) being prepared'],
  [/^(\\d+) % · elle apparaîtra ici en orange$/, '$1 % · it will appear here in orange'],
  [/^Afficher les (\\d+) autres$/, 'Show the other $1'],
  [/^(.+) à récupérer sans rien casser$/, '$1 to reclaim without breaking anything'], [/^✨ Tout fusionner \\((\\d+)\\)$/, '✨ Merge all ($1)'],
  [/^(\\d+) copies · (.+) chacune · (.+) récupérables$/, '$1 copies · $2 each · $3 reclaimable'], [/^(\\d+) copies · (.+) chacune · (.+)$/, '$1 copies · $2 each · $3'],
  [/^dans « (.+) » \\(prêts à lancer\\)(.*)$/, 'in “$1” (ready to launch)$2'], [/^dans « (.+) » \\(réserve\\)(.*)$/, 'in “$1” (reserve)$2'],
  [/^autre disque : sert de sauvegarde \\((.+)\\)$/, 'other disk: serves as a backup ($1)'], [/^autre disque, et (.+) l’attend à cet endroit$/, 'other disk, and $1 expects it there'],
  [/^copie en trop sur un autre disque \\((.+)\\) : corbeille Windows, récupérable$/, 'extra copy on another disk ($1): Windows recycle bin, recoverable'],
  [/^mettre aussi à la corbeille les copies en trop sur un autre disque \\((.+), récupérables\\)$/, 'also send extra copies on another disk to the recycle bin ($1, recoverable)'],
  [/^(\\d+) modèle\\(s\\) · (.+)$/, '$1 model(s) · $2'], [/^(.+) libres$/, '$1 free'],
  [/^(\\d+) dossier\\(s\\) retrouvé\\(s\\) à leur nouvelle place, (\\d+) ajouté\\(s\\)\\.$/, '$1 folder(s) found at their new place, $2 added.'],
  [/^(\\d+) dossier\\(s\\) toujours introuvable\\(s\\) : disque débranché \\?$/, '$1 folder(s) still not found: disk unplugged?'],
  [/^Dossier (.+) prêt\\.$/, 'Folder $1 ready.'],
  [/^(.+) se lance\\.$/, '$1 is starting.'], [/^Lancer (.+)$/, 'Launch $1'],
  [/^≈ (.+) · (.+)$/, '≈ $1 · $2'],
  [/(\\d)(\\s|\\u00a0)?o\\b/g, '$1 B'],
  [/Cache d’experts : /g, 'Expert cache: '], [/ · Total estimé \\(mesuré sur Gemma 4 26B\\) : /g, ' · Estimated total (measured on Gemma 4 26B): '],
  // unités et nombres à la française
  [/(\\d+),(\\d+)(\\s|\\u00a0)?(Go|Mo|Ko|To)\\b/g, '$1.$2 $4'],
  [/(\\d)(\\s|\\u00a0)?Go\\b/g, '$1 GB'], [/(\\d)(\\s|\\u00a0)?Mo\\b/g, '$1 MB'], [/(\\d)(\\s|\\u00a0)?Ko\\b/g, '$1 KB'], [/(\\d)(\\s|\\u00a0)?To\\b/g, '$1 TB'],
  [/(\\d+),(\\d+)(\\s|\\u00a0)?(tok\\/s|mots\\/s|%)/g, '$1.$2 $4'], [/mots\\/s/g, 'words/s'], [/(\\d)(\\s|\\u00a0)?jetons\\b/g, '$1 tokens'], [/\\bjetons\\b/g, 'tokens'],
  [/(\\d) h (\\d\\d)\\b/g, '$1:$2'], [/\\baujourd’hui\\b|\\baujourd'hui\\b/g, 'today'], [/\\bhier\\b/g, 'yesterday'],
  // mois (dates affichées par le navigateur en français)
  [/\\bjanv\\.?/g, 'Jan'], [/\\bfévr\\.?/g, 'Feb'], [/\\bmars\\b/g, 'Mar'], [/\\bavr\\.?/g, 'Apr'], [/\\bmai\\b/g, 'May'], [/\\bjuin\\b/g, 'Jun'],
  [/\\bjuil\\.?/g, 'Jul'], [/\\baoût\\b/g, 'Aug'], [/\\bsept\\.?/g, 'Sep'], [/\\boct\\.?/g, 'Oct'], [/\\bnov\\.?/g, 'Nov'], [/\\bdéc\\.?/g, 'Dec'],
  [/\\bjanvier\\b/g, 'January'], [/\\bfévrier\\b/g, 'February'], [/\\bavril\\b/g, 'April'], [/\\bjuillet\\b/g, 'July'], [/\\bseptembre\\b/g, 'September'], [/\\boctobre\\b/g, 'October'], [/\\bnovembre\\b/g, 'November'], [/\\bdécembre\\b/g, 'December'],
]`;
const out = `// Dictionnaire français -> anglais de l'interface (généré par app/tools/i18n/build.mjs à partir de l'inventaire des textes).
// Une entrée manquante laisse le texte en français : ajoute-la ici (ou dans extra.json puis relance le script).
export const PAIRS = ${JSON.stringify(arr, null, 0).replace(/\],\[/g, '],\n[')};
export const RULES = ${RULES};
`;
fs.writeFileSync(new URL('../../public/i18n-en.js', import.meta.url), out);
console.log(arr.length, 'paires');
