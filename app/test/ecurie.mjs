// Écurie propre : classement par type / base, plan et rangement de l'existant (avec annulation), traces, retour dans le dossier habituel d'un repo actif.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-ecurie-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const act = path.join(TMP, 'swarm'); const sto = path.join(TMP, 'f-models');
for (const d of [path.join(act, 'Lora'), path.join(act, 'Stable-Diffusion'), path.join(sto, 'Lora'), path.join(sto, 'vrac', 'sous'), path.join(sto, 'LLM-Decide')]) fs.mkdirSync(d, { recursive: true });
const put = (p, n, fill) => fs.writeFileSync(p, Buffer.alloc(n, fill));
put(path.join(act, 'Lora', 'add_detail_lora.safetensors'), 40000, 1);            // une LoRA déjà dans l'install SD (donne le dossier habituel « Lora »)
put(path.join(act, 'Stable-Diffusion', 'ponyDiffusionV6XL.safetensors'), 90000, 2);
put(path.join(sto, 'Lora', 'astolfo_lora.safetensors'), 30000, 3);                // vrac de l'existant
put(path.join(sto, 'vrac', 'sous', 'skin_texture_lora.safetensors'), 31000, 4);
put(path.join(sto, 'vrac', 'copie_astolfo_lora.safetensors'), 30000, 3);          // doublon exact d'astolfo (même octets) dans le même repo
put(path.join(sto, 'LLM-Decide', 'Decide-v3-26B-A4B-Q4_K_M.gguf'), 60000, 5);
put(path.join(sto, 'LLM-Decide', 'Decide-v3-26B-A4B-Q4_K_M-00001-of-00002.gguf'), 20000, 6);
const { openDb, addRoot, queryAssets, setSetting } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const { getJob } = await import('../src/jobs.js');
const { moveModel } = await import('../src/placement.js');
const E = await import('../src/ecurie.js');
const db = openDb();
const rA = addRoot(db, { name: 'swarm', path: act, role: 'active' });
const rS = addRoot(db, { name: 'f-models', path: sto, role: 'store' });
await scanPath(db, { dir: act, rootId: rA.id, maxDepth: 5, minBytes: 1 });
await scanPath(db, { dir: sto, rootId: rS.id, maxDepth: 5, minBytes: 1 });
const byName = (n) => queryAssets(db, { q: n, limit: 20 }).items.find((a) => a.file_name === n);
const wait = async (id) => { for (let i = 0; i < 200; i++) { const j = getJob(id); if (j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 100)); } throw new Error('délai'); };
const ex = (p) => fs.existsSync(p);

// nom de dossier propre : un modèle et ses morceaux ensemble
assert.equal(E.modelStem('Decide-v3-26B-A4B-Q4_K_M.gguf'), 'Decide-v3-26B-A4B');
assert.equal(E.modelStem('Decide-v3-26B-A4B-Q4_K_M-00001-of-00002.gguf'), 'Decide-v3-26B-A4B');
assert.equal(E.modelStem('mmproj-Qwen2-VL-F16.gguf'), 'Qwen2-VL');
console.log('  ✔ écurie : nom de dossier de modèle (sans quantification ni morceau)');

// pas encore une écurie propre : rien ne change pour un repo ordinaire
assert.equal(E.isCleanRoot(db, rS.id), false);
await assert.rejects(async () => E.setCleanRoot(db, rA.id, true), /stockage/);
E.setCleanRoot(db, rS.id, true); assert.equal(E.isCleanRoot(db, rS.id), true);

// plan : l'existant est classé, le doublon exact du même repo n'est rangé qu'une fois (l'autre nom sera fusionné), rien ne bouge tant qu'on n'applique pas
const plan = E.planReorg(db, rS.id);
const files = plan.moves.map((m) => m.file);
assert.ok(files.includes('skin_texture_lora.safetensors'));
assert.equal(files.filter((f) => /astolfo/.test(f)).length, 1, 'un seul exemplaire du doublon est rangé');
assert.equal(plan.merges.length, 1, 'l\'autre copie identique est prévue pour la fusion');
assert.ok(ex(path.join(sto, 'Lora', 'astolfo_lora.safetensors')) && ex(path.join(sto, 'vrac', 'sous', 'skin_texture_lora.safetensors')));
const pieces = plan.moves.filter((m) => /Decide/.test(m.file)); assert.equal(pieces.length, 2);
assert.equal(path.dirname(pieces[0].to), path.dirname(pieces[1].to), 'les morceaux d\'un même modèle vont dans le même dossier');
console.log('  ✔ écurie : plan sans rien déplacer, doublon du même repo rangé une seule fois');

// application : seulement les ids demandés, destinations recalculées, vieux dossiers vides retirés, journal + trace
const sk = byName('skin_texture_lora.safetensors'); const ru = byName('Decide-v3-26B-A4B-Q4_K_M.gguf');
const res = await E.applyReorg(db, rS.id, [sk.id, ru.id, 999999]);
assert.equal(res.moved, 2); assert.equal(res.failed.length, 0);
const skNew = byName('skin_texture_lora.safetensors');
assert.equal(skNew.abs_path.toLowerCase(), path.join(sto, E.cleanRel(skNew)).toLowerCase()); assert.ok(ex(skNew.abs_path));
assert.ok(!ex(path.join(sto, 'vrac', 'sous')), 'le dossier vide laissé derrière est retiré');
assert.ok(ex(path.join(sto, 'vrac', 'copie_astolfo_lora.safetensors')), 'les fichiers non demandés ne bougent pas');
const trace = JSON.parse(fs.readFileSync(path.join(sto, E.META_DIR, 'trace.json'), 'utf8'));
assert.ok(Object.keys(trace.fichiers).some((k) => /skin_texture_lora/.test(k)));
assert.ok(fs.readdirSync(path.join(sto, E.META_DIR)).some((f) => /^journal-/.test(f)));
console.log('  ✔ écurie : rangement de l\'existant, journal et trace écrits');

// annulation : tout revient exactement où c'était
const back = await E.undoLast(db, rS.id);
assert.equal(back.restored, 2);
assert.ok(ex(path.join(sto, 'vrac', 'sous', 'skin_texture_lora.safetensors')) && ex(path.join(sto, 'LLM-Decide', 'Decide-v3-26B-A4B-Q4_K_M.gguf')));
assert.equal(byName('skin_texture_lora.safetensors').abs_path.toLowerCase(), path.join(sto, 'vrac', 'sous', 'skin_texture_lora.safetensors').toLowerCase());
await assert.rejects(E.undoLast(db, rS.id), /Aucun rangement/);
console.log('  ✔ écurie : annulation du rangement');

// Ranger depuis l'install SD vers l'écurie propre : classé proprement ; Invoquer : retour à l'adresse EXACTE
const pony = byName('ponyDiffusionV6XL.safetensors'); const ponyOrig = pony.abs_path;
let r = await moveModel(db, { assetId: pony.id, toRoot: rS.id, companionIds: [] });
assert.equal((await wait(r.job.id)).status, 'done');
const ponyIn = byName('ponyDiffusionV6XL.safetensors');
assert.equal(ponyIn.abs_path.toLowerCase(), path.join(sto, E.cleanRel(ponyIn)).toLowerCase()); assert.ok(ex(ponyIn.abs_path));
assert.equal(path.relative(sto, ponyIn.abs_path).split(path.sep).length, 3, 'type / base / fichier');
assert.ok(JSON.parse(fs.readFileSync(path.join(sto, E.META_DIR, 'trace.json'), 'utf8')).fichiers[path.relative(sto, ponyIn.abs_path).replace(/\\/g, '/')].origine, 'la trace garde d\'où il vient');
r = await moveModel(db, { assetId: ponyIn.id, toRoot: rA.id, companionIds: [] });
assert.equal((await wait(r.job.id)).status, 'done');
assert.equal(byName('ponyDiffusionV6XL.safetensors').abs_path.toLowerCase(), ponyOrig.toLowerCase());
console.log('  ✔ écurie : rangé proprement avec sa trace, retour à l\'adresse exacte');

// Invoquer un fichier qui n'a PAS d'origine (copie de sauvegarde) : il va dans le dossier que l'install SD utilise déjà pour ce type (« Lora »)
const sk2 = byName('skin_texture_lora.safetensors'); assert.equal(sk2.category, 'lora');
await E.applyReorg(db, rS.id, [sk2.id]);
const skClean = byName('skin_texture_lora.safetensors');
r = await moveModel(db, { assetId: skClean.id, toRoot: rA.id, companionIds: [] });
assert.equal((await wait(r.job.id)).status, 'done');
assert.equal(byName('skin_texture_lora.safetensors').abs_path.toLowerCase(), path.join(act, 'Lora', 'skin_texture_lora.safetensors').toLowerCase());
console.log('  ✔ écurie : sans origine, retour dans le dossier habituel du repo actif');
// types inconnus : la structure d'une appli (Wan2GP…) est gardée, et idempotente
const o1 = { category: 'other', file_name: 'q.safetensors', rel_path: 'installed-2026\\AI-MODELS\\WAN2GP-CKPTS\\Qwen3\\q.safetensors' };
assert.equal(E.cleanRel(o1), path.join('Applis', 'WAN2GP-CKPTS', 'Qwen3', 'q.safetensors'));
assert.equal(E.cleanRel({ ...o1, rel_path: path.join('Applis', 'WAN2GP-CKPTS', 'Qwen3', 'q.safetensors') }), E.cleanRel(o1));
assert.equal(E.cleanRel({ ...o1, rel_path: path.join('Autres', 'WAN2GP-CKPTS', 'Qwen3', 'q.safetensors') }), E.cleanRel(o1), 'ancien rangement « Autres » reconnu');
console.log('  ✔ écurie : les fichiers « autres » gardent la structure de leur appli');

// Nouvelle écurie sur le même disque : tout le vieux repo y passe, rangé ; les fichiers d'accompagnement suivent ; doublon fusionné ;
// CATALOGUE.md écrit, et une note ajoutée à la main est relue par PAIZ ; annulation complète
const old = path.join(TMP, 'vrac-ancien'); fs.mkdirSync(path.join(old, 'installed-2026', 'AI-MODELS', 'WAN2GP-CKPTS', 'Qwen3'), { recursive: true });
fs.mkdirSync(path.join(old, 'divers'), { recursive: true });
put(path.join(old, 'installed-2026', 'AI-MODELS', 'WAN2GP-CKPTS', 'Qwen3', 'qwen3.safetensors'), 50000, 7);
fs.writeFileSync(path.join(old, 'installed-2026', 'AI-MODELS', 'WAN2GP-CKPTS', 'Qwen3', 'tokenizer.json'), '{"t":1}');
const gg = Buffer.concat([(() => { const h = Buffer.alloc(24); h.write('GGUF', 0); h.writeUInt32LE(3, 4); return h; })(), Buffer.alloc(70000, 8)]);
fs.writeFileSync(path.join(old, 'divers', 'Gemma-4-26B-A4B-Q4_K_M.gguf'), gg);
fs.writeFileSync(path.join(old, 'divers', 'Gemma-copie.gguf'), gg);
const rOld = addRoot(db, { name: 'vrac', path: old, role: 'store' });
await scanPath(db, { dir: old, rootId: rOld.id, maxDepth: 6, minBytes: 1000 });
const neuf = path.join(TMP, 'PAIZ', 'Reserve'); fs.mkdirSync(neuf, { recursive: true });
const rNew = addRoot(db, { name: 'Reserve (T:)', path: neuf, role: 'store' });
setSetting(db, 'shelf.items', JSON.stringify([{ path: path.join(old, 'divers', 'Gemma-4-26B-A4B-Q4_K_M.gguf') }]));
const mp = E.planReorg(db, rOld.id, { into: rNew.id });
assert.equal(mp.moves.length, 2); assert.equal(mp.merges.length, 1);
const mr = await E.applyReorg(db, rOld.id, null, { into: rNew.id });
assert.equal(mr.moved, 2); assert.equal(mr.companions, 1); assert.equal(mr.merged, 1); assert.equal(mr.failed.length, 0, JSON.stringify(mr.failed));
const q = byName('qwen3.safetensors'); assert.equal(q.root_id, rNew.id);
assert.ok(ex(path.join(path.dirname(q.abs_path), 'tokenizer.json')), 'le tokenizer suit son modèle');
assert.ok(!ex(path.join(old, 'divers', 'Gemma-copie.gguf')), 'copie identique retirée');
assert.match(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'shelf.items'").get().value)[0].path, /Reserve/, 'les chemins enregistrés dans PAIZ suivent');
assert.ok(E.isCleanRoot(db, rNew.id), 'la nouvelle écurie est propre');
const catFile = path.join(neuf, E.CATALOGUE); assert.ok(ex(catFile));
let md = fs.readFileSync(catFile, 'utf8'); assert.match(md, /### /); assert.match(md, /- Notes : /);
fs.writeFileSync(catFile, md.replace(/(- Fichier : `[^`]*Gemma[^`]*`[\s\S]*?- Notes : )/, '$1mon modèle préféré'));
await E.writeTrace(db, rNew.id);
assert.equal(byName('Gemma-4-26B-A4B-Q4_K_M.gguf').notes, 'mon modèle préféré', 'la note écrite dans CATALOGUE.md arrive dans PAIZ');
assert.match(fs.readFileSync(catFile, 'utf8'), /- Notes : mon modèle préféré/, 'et elle est gardée à la réécriture');
const ub = await E.undoLast(db, rNew.id);
assert.ok(ub.restored >= 2);
assert.ok(ex(path.join(old, 'divers', 'Gemma-copie.gguf')), 'la copie fusionnée est recréée');
assert.ok(ex(path.join(old, 'installed-2026', 'AI-MODELS', 'WAN2GP-CKPTS', 'Qwen3', 'tokenizer.json')) && ex(path.join(old, 'divers', 'Gemma-4-26B-A4B-Q4_K_M.gguf')));
assert.equal(byName('qwen3.safetensors').root_id, rOld.id);
console.log('  ✔ écurie : nouvelle écurie rangée (accompagnement, doublon, chemins PAIZ), CATALOGUE.md relu, annulation');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou sqlite */ }
process.exit(0);
