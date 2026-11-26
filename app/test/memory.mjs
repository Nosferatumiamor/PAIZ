// Mémoire : notes (dédoublonnage), recherche plein texte, bloc injecté, digestion, projets privés.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-mem-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb } = await import('../src/db.js');
const M = await import('../src/memory.js');
const db = openDb();
const P = 'D:\proj\pong';

const a = M.addNote(db, { project: P, cat: 'decision', text: 'Le jeu de pong sera écrit en Python avec pygame', importance: 4 });
const b = M.addNote(db, { project: P, cat: 'decision', text: 'Le jeu de pong sera écrit en Python avec pygame.', importance: 2 });
assert.equal(b.merged, true); assert.equal(M.listNotes(db, P).length, 1, 'doublon renforcé, pas dupliqué');
M.addNote(db, { global: true, cat: 'preference', text: 'L’utilisateur préfère des réponses courtes en français', importance: 5 });
M.addNote(db, { project: 'D:\autre', cat: 'projet', text: 'Autre projet secret de jardinage', importance: 5 });
assert.equal(M.listNotes(db, P).length, 2, 'les notes d’un autre projet ne sont pas vues');
console.log('  ✔ mémoire : notes, dédoublonnage, portées projet / globale');

const blk = M.buildBlock(db, { project: P, query: 'et pour le jeu, quelle bibliothèque ?', requestText: '' });
assert.match(blk, /pygame/); assert.match(blk, /réponses courtes/); assert.doesNotMatch(blk, /jardinage/);
const j = { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'salut' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'et pour le jeu ?' }] };
assert.equal(M.injectMemory(j, blk), true); assert.equal(j.messages[1].content, 'salut'); assert.match(j.messages[3].content, /Mémoire PAIZ/); assert.equal(j.messages[0].content, 'S');
const ri = M.requestInfo({ messages: [{ role: 'system', content: 'Env\nWorking directory: D:\proj\pong\nx' }, { role: 'user', content: [{ type: 'text', text: 'bonjour' }] }] });
assert.equal(ri.project, 'D:\proj\pong'); assert.equal(ri.query, 'bonjour');
console.log('  ✔ mémoire : bloc court, ajouté au dernier message seulement, dossier lu dans les consignes');

M.applyDigest(db, { text: 'Voici : {"summary":"On a choisi pygame pour le pong et fixé les raquettes.","notes":[{"cat":"promesse","text":"Montrer le prototype de pong à Marc","importance":4,"due":"2026-12-01","scope":"projet"},{"cat":"identite","text":"L’utilisateur s’appelle Guillaume","importance":5,"scope":"global"}]}', meta: { session: 's1', project: P, title: 'Pong', when: Date.now() - 3 * 86400000, upto: 123, msgs: ['Utilisateur : on fait les raquettes en rouge'] } });
assert.equal(M.listNotes(db, P).length, 4); assert.equal(M.listSummaries(db, P).length, 1);
const b2 = M.buildBlock(db, { project: P, query: 'raquettes rouges du pong', requestText: '' });
assert.match(b2, /pygame pour le pong/); assert.match(b2, /il y a 3 jours/); assert.match(b2, /raquettes en rouge/);
assert.match(M.buildDigestPrompt({ title: 'T', lines: ['Utilisateur : a'], existing: [{ text: 'connue' }] }), /JSON[\s\S]*Utilisateur : a[\s\S]*connue/);
console.log('  ✔ mémoire : digestion (résumé, notes datées, extraits) et rappel d’une vieille conversation');

M.setMemConfig(db, { project: P, private: true });
assert.equal(M.listSummaries(db, P).length, 0); assert.equal(M.listNotes(db, P).filter((n) => n.scope.startsWith('projet')).length, 0);
assert.doesNotMatch(M.buildBlock(db, { project: P, query: 'pygame raquettes' }), /pygame|raquettes/);
M.setMemConfig(db, { on: false }); assert.equal(M.buildBlock(db, { project: 'D:/x', query: 'courtes' }), '');
console.log('  ✔ mémoire : projet privé oublié et jamais lu, interrupteur général');
process.exit(0);
