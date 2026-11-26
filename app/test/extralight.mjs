// Mode extra-light (avec perte) : avertissement dans la grille, version Q3 à fabriquer, jamais lancée sans elle, échec propre.
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-xl-'));
process.env.PAIZ_HOME = path.join(tmp, 'home');
const { openDb } = await import('../src/db.js');
const { setSetting } = await import('../src/db.js');
const E = await import('../src/engine.js');
const db = openDb();

// la grille propose le mode, avec l'avertissement « faster but unstable »
const row = E.MODE_GRID.find((g) => g.id === 'xl');
assert.ok(row && row.options[0].profile === 'extralight');
assert.match(E.PROFILE_INFO.extralight.label, /instable/);
assert.match(E.PROFILE_INFO.extralight.desc, /Faster but unstable/);
assert.equal(E.PROFILE_INFO.extralight.lossy, true);
assert.equal(E.variantPath('C:/m/gemma.Q4.gguf'), 'C:/m/gemma.Q4-extralight-Q3_K_M.gguf');

// faux modèle + faux llama-quantize (copie le fichier source vers la sortie)
const model = path.join(tmp, 'm.gguf'); fs.writeFileSync(model, Buffer.alloc(4096, 1));
const asset = { id: 7, abs_path: model, size_bytes: 4096 };
const okExe = path.join(tmp, 'fake-quantize-ok.cmd'); fs.writeFileSync(okExe, '@echo off\r\ncopy /y "%2" "%3" >nul\r\nexit /b 0\r\n');
const badExe = path.join(tmp, 'fake-quantize-bad.cmd'); fs.writeFileSync(badExe, '@echo off\r\necho disque plein 1>&2\r\nexit /b 3\r\n');
const waitDone = async () => { for (let i = 0; i < 100 && E.variantState.running; i++) await new Promise((r) => setTimeout(r, 100)); };

// sans version : informations, et le lancement est refusé avec un message clair
assert.equal(E.variantInfo(db, asset).exists, false);
setSetting(db, 'engine.exe', path.join(tmp, 'ws_npc_server.exe')); fs.writeFileSync(path.join(tmp, 'ws_npc_server.exe'), '');
// extra-light réservé aux modèles allégés (Q3 / Q2) ; ils n'ont que ce mode
assert.equal(E.isLossyFile('C:/m/gemma-Q3_K_M.gguf'), true); assert.equal(E.isLossyFile('C:/m/x-IQ2_XS.gguf'), true);
assert.equal(E.isLossyFile('C:/m/gemma-Q4_K_M.gguf'), false); assert.equal(E.isLossyFile('C:/m/gemma-BF16.gguf'), false);

// échec de l'outil : message d'erreur, aucun fichier laissé, rien de publié
setSetting(db, 'engine.quantizeExe', badExe);
await E.buildVariant(db, asset); await waitDone();
assert.match(E.variantState.error, /code 3/);
assert.equal(fs.existsSync(E.variantPath(model)), false);
assert.equal(fs.existsSync(E.variantPath(model) + '.building'), false);

// réussite : fichier final présent, plus de fichier temporaire, message de fin
setSetting(db, 'engine.quantizeExe', okExe);
await E.buildVariant(db, asset); await waitDone();
assert.equal(E.variantState.error, null);
assert.equal(E.variantState.done, true);
assert.equal(E.variantInfo(db, asset).exists, true);
assert.equal(fs.existsSync(E.variantPath(model) + '.building'), false);
await assert.rejects(() => E.buildVariant(db, asset), /existe déjà/);
console.log('extra-light : OK');
