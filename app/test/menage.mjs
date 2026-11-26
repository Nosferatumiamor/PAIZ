// Entretien > Restes oubliés : téléchargements interrompus, vieux dossiers de sauvegarde, doublons dans un même repo actif ; suppression choisie seulement.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-menage-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
process.env.PAIZ_FAKE_HOME = path.join(TMP, 'user');
process.env.PAIZ_TRASH = 'folder';
const act = path.join(TMP, 'swarm'); const cache = path.join(process.env.PAIZ_FAKE_HOME, '.cache');
const put = (p, mb, fill) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(mb * 1024 * 1024, fill)); };
put(path.join(act, 'clip', 'qwen_3_4b.safetensors'), 3, 7);               // même fichier dans deux dossiers du même repo
put(path.join(act, 'text_encoders', 'qwen_3_4b.safetensors'), 3, 7);
put(path.join(act, 'Lora', 'autre.safetensors'), 3, 8);                    // unique : jamais proposé
put(path.join(act, 'base', 'grand.safetensors.tmp'), 25, 9);               // téléchargement interrompu
put(path.join(act, 'base', 'petit.tmp'), 1, 9);                            // trop petit pour compter
put(path.join(cache, 'huggingfacebackup', 'transformers', 'a.bin'), 60, 1); // ancienne sauvegarde
put(path.join(cache, 'mystere', 'x.bin'), 60, 2);                           // cache inconnu
put(path.join(cache, 'torch', 'hub', 'w.pth'), 60, 3);                      // cache CONNU : traité par la chasse d'eau, pas ici

const { openDb, addRoot } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const M = await import('../src/maintenance.js');
const db = openDb();
const r = addRoot(db, { name: 'swarm', path: act, role: 'active' });
await scanPath(db, { dir: act, rootId: r.id, maxDepth: 5, minBytes: 1 });

const items = await M.scanLeftovers(db);
const by = (k) => items.filter((x) => x.kind === k);
assert.equal(by('partial').length, 1); assert.match(by('partial')[0].label, /grand/);
assert.equal(by('stale').length, 1); assert.match(by('stale')[0].label, /huggingfacebackup/);
assert.equal(by('unknown').length, 1); assert.match(by('unknown')[0].label, /mystere/);
assert.ok(!items.some((x) => /torch/.test(x.path)), 'un cache connu n\'est pas dupliqué ici');
assert.equal(by('dupe').length, 1, 'une seule des deux copies est proposée, jamais les deux');
assert.ok(!items.some((x) => /autre\.safetensors/.test(x.path)));
console.log('  ✔ restes oubliés : interrompus, ancienne sauvegarde, cache inconnu, doublon (une seule copie)');

// suppression : seulement ce qui est choisi, recalculé côté serveur
await assert.rejects(M.removeLeftovers(db, { ids: ['pasunid'], permanent: true }), /Rien à supprimer/);
const part = by('partial')[0]; const stale = by('stale')[0]; const dupe = by('dupe')[0];
const res = await M.removeLeftovers(db, { ids: [part.id, stale.id, dupe.id], permanent: true });
assert.equal(res.freed, 3); assert.equal(res.failed.length, 0);
assert.ok(!fs.existsSync(part.path) && !fs.existsSync(stale.path) && !fs.existsSync(dupe.path));
assert.ok(fs.existsSync(path.join(cache, 'mystere', 'x.bin')), 'le cache inconnu non coché reste');
const keptCopy = ['clip', 'text_encoders'].map((d) => path.join(act, d, 'qwen_3_4b.safetensors')).filter((p) => fs.existsSync(p));
assert.equal(keptCopy.length, 1, 'il reste exactement une copie');
assert.ok(fs.readFileSync(path.join(process.env.PAIZ_HOME, 'menage-journal.jsonl'), 'utf8').split('\n').filter(Boolean).length === 3);
console.log('  ✔ restes oubliés : suppression choisie, journal écrit, une copie conservée');

// un dossier qui chevauche une racine PAIZ n'est jamais supprimé
fs.mkdirSync(path.join(cache, 'old-swarm'), { recursive: true }); put(path.join(cache, 'old-swarm', 'z.bin'), 60, 4);
addRoot(db, { name: 'cache-root', path: path.join(cache, 'old-swarm'), role: 'external' });
const again = (await M.scanLeftovers(db)).find((x) => /old-swarm/.test(x.path));
if (again) { const rr = await M.removeLeftovers(db, { ids: [again.id], permanent: true }); assert.equal(rr.freed, 0); assert.ok(fs.existsSync(path.join(cache, 'old-swarm', 'z.bin'))); }
console.log('  ✔ restes oubliés : jamais un dossier géré par PAIZ');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou sqlite */ }
process.exit(0);
