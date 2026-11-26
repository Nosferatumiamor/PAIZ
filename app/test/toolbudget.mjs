// Budget d'outils : profils d'usage, cases / cadenas, mode Auto, ordre stable, API du panneau.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-budget-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb } = await import('../src/db.js');
const { applyBudget, setBudget, getBudget, budgetPanel, CORE } = await import('../src/toolbudget.js');
const { selectTools } = await import('../src/proxy.js');
const db = openDb();

const T = (n, pad = 200) => ({ type: 'function', function: { name: n, description: 'x'.repeat(pad), parameters: { type: 'object', properties: {} } } });
const ALL = ['bash', 'task', 'todowrite', 'edit', 'read', 'webfetch', 'grep', 'glob', 'write', 'skill'];
const mk = (users = ['bonjour'], calls = []) => {
  const messages = [{ role: 'system', content: 'SYS' }];
  users.forEach((u, i) => { messages.push({ role: 'user', content: u }); for (const c of calls.filter((x) => x.turn === i + 1)) messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: c.name, arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c', content: 'ok' }); });
  return { messages, tools: ALL.map((n) => T(n, n === 'bash' ? 1500 : 200)) };
};
const auto = (jj) => selectTools(jj, 'auto', [], false);
const names = (j) => (j.tools || []).map((t) => t.function.name);

// profil Discussion : plus aucun outil, le champ disparaît
setBudget(db, { profile: 'chat' });
let j = mk(); applyBudget(db, j, auto);
assert.equal(j.tools, undefined, 'Discussion : aucun outil');
// profil Code : base + terminal + todowrite, sans web ni agents
setBudget(db, { profile: 'code' });
j = mk(); applyBudget(db, j, auto);
assert.deepEqual(names(j).sort(), ['bash', 'edit', 'glob', 'grep', 'read', 'todowrite', 'write'].sort(), 'Code');
// profil Recherche
setBudget(db, { profile: 'search' });
j = mk(); applyBudget(db, j, auto);
assert.deepEqual(names(j).sort(), ['glob', 'grep', 'read', 'webfetch'], 'Recherche');
// profil Complet : tout (websearch absent ici)
setBudget(db, { profile: 'full' });
j = mk(); applyBudget(db, j, auto);
assert.equal(j.tools.length, 10, 'Complet : tout');
// profil Automatique = ancienne sélection par mots-clés
setBudget(db, { profile: 'auto' });
j = mk(['bonjour']); applyBudget(db, j, auto);
assert.ok(!names(j).includes('bash') && !names(j).includes('task'), 'Auto : sans bash ni task tant que non réclamés');
j = mk(['fais un git commit']); applyBudget(db, j, auto);
assert.ok(names(j).includes('bash'), 'Auto : bash revient quand la tâche le réclame');

// cases : décocher retire, cocher re-garde malgré le profil ; ordre : outils de base d'abord, activables en fin de liste
setBudget(db, { profile: 'code' });
setBudget(db, { toggle: { name: 'bash', on: false } });
j = mk(); applyBudget(db, j, auto);
assert.ok(!names(j).includes('bash'), 'case décochée : outil retiré');
setBudget(db, { toggle: { name: 'webfetch', on: true } });
j = mk(); applyBudget(db, j, auto);
assert.ok(names(j).includes('webfetch'), 'case cochée : gardé malgré le profil Code');
const order = names(j); const firstNonCore = order.findIndex((n) => !CORE.has(n));
assert.ok(order.slice(firstNonCore).every((n) => !CORE.has(n)), 'outils de base en tête, activables en fin de liste');
assert.equal(order.indexOf('todowrite') > order.indexOf('write'), true);
// changer de profil remet les choix à zéro
setBudget(db, { profile: 'full' });
assert.deepEqual(getBudget(db).off, {}, 'nouveau profil : choix remis à zéro');

// pastilles : vert (appelé récemment), orange (peu de recul / appelé il y a longtemps), rouge (jamais appelé en 8+ messages), noir (éteint)
setBudget(db, { profile: 'full' });
const longChat = Array.from({ length: 10 }, (_, i) => `message ${i}`);
j = mk(longChat, [{ turn: 10, name: 'grep' }, { turn: 2, name: 'webfetch' }]);
applyBudget(db, j, auto);
let p = budgetPanel(db); const st = Object.fromEntries(p.view.rows.map((r) => [r.name, r.state]));
assert.equal(st.grep, 'green'); assert.equal(st.read, 'green', 'base : vert'); assert.equal(st.webfetch, 'orange', 'appelé il y a longtemps : orange'); assert.equal(st.bash, 'red'); assert.equal(st.task, 'red');
j = mk(['bonjour']); applyBudget(db, j, auto); p = budgetPanel(db);
assert.equal(p.view.rows.find((r) => r.name === 'bash').state, 'orange', 'conversation courte : pas assez de recul = orange');
assert.ok(p.view.rows.find((r) => r.name === 'bash').tokens > 300);
setBudget(db, { toggle: { name: 'bash', on: false } });
j = mk(longChat); applyBudget(db, j, auto); p = budgetPanel(db);
assert.equal(p.view.rows.find((r) => r.name === 'bash').state, 'black', 'éteint : noir');
assert.match(p.view.rows.find((r) => r.name === 'bash').why, /toi/);
assert.ok(p.changeCostS > 0, 'coût d\'un changement annoncé');

// mode AUTO : rouge 3 requêtes de suite → éteint ; cadenas = jamais ; outils de base jamais
setBudget(db, { profile: 'full' }); setBudget(db, { mode: 'auto' });
setBudget(db, { lock: { name: 'task', locked: true } });
for (let i = 0; i < 2; i++) { j = mk(longChat); applyBudget(db, j, auto); }
assert.ok(!getBudget(db).off.bash, 'pas avant 3 requêtes');
j = mk(longChat); applyBudget(db, j, auto);
assert.equal(getBudget(db).off.bash, 'auto', 'rouge 3 fois : éteint automatiquement');
assert.ok(!getBudget(db).off.task, 'cadenas : jamais éteint');
assert.ok(!getBudget(db).off.read, 'outil de base : jamais éteint');
j = mk(longChat); applyBudget(db, j, auto);
assert.ok(!names(j).includes('bash') && names(j).includes('task'), 'appliqué à la requête suivante, cadenas respecté');
assert.equal(budgetPanel(db).view.rows.find((r) => r.name === 'bash').why, 'éteint automatiquement');
// un outil rappelé par le modèle repasse au vert et sort de la série rouge
setBudget(db, { mode: 'manual' });
console.log('  ✔ budget d\'outils : profils, cases, pastilles, mode auto, cadenas, ordre stable');
