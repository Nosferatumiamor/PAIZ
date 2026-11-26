// Tâches : un modèle cloud gratuit (OpenCode) s'accepte comme modèle d'exécution, sans rien charger en local ; l'assistant sait décrire les outils de PAIZ.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.PAIZ_HOME = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-tcloud-')), 'home');
const { openDb } = await import('../src/db.js');
const T = await import('../src/tasks.js');
const { PAIZ_GUIDE } = await import('../src/persona.js');
const db = openDb(); T._resetForTests();
const t = T.addTask(db, { title: 'Résumé', spec: 'Résume ce texte.', model: 'cloud:deepseek-v4.1-flash-free', status: 'draft' });
assert.equal(t.model, 'cloud:deepseek-v4.1-flash-free'); assert.match(t.modelName, /deepseek/);
assert.ok(T.isCloud(t.model) && !T.isCloud('chat') && !T.isCloud(12));
const u = T.editTask(db, t.id, { model: 'chat' }); assert.equal(u.model, 'chat');
assert.throws(() => T.addTask(db, { spec: 'x', model: '99999' }), /inconnu/);
assert.ok(/paiz-task/.test(PAIZ_GUIDE) && /TÂCHES/.test(PAIZ_GUIDE) && /MEMORY/.test(PAIZ_GUIDE) && /BROUILLON/.test(PAIZ_GUIDE));
console.log('  ✔ tâches : modèle cloud gratuit accepté (création, modification), guide des outils PAIZ pour l’assistant');
