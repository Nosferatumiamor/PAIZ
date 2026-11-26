// Serveurs MCP : liste/activation, configuration d'OpenCode (seulement les actifs), essai de connexion avec un faux serveur,
// et allègement du catalogue « Code Mode » du prompt.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-mcp-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb } = await import('../src/db.js');
const { listMcp, saveMcp, setMcpEnabled, removeMcp, mcpConfig, enabledNamespaces, probeServer, splitCommand, nsOf } = await import('../src/mcp.js');
const { trimCodeMode } = await import('../src/codemode.js');
const db = openDb();
const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-mcp.mjs');

assert.deepEqual(splitCommand('node "a b/c.js" --x 1'), ['node', 'a b/c.js', '--x', '1']);
assert.equal(nsOf('io.github.Foo/Blender-MCP v2'), 'io_github_foo_blender_mcp_v2');

saveMcp(db, { name: 'Faux serveur', command: ['node', fake], environment: { MARKER: path.join(TMP, 'm.txt') } });
assert.equal(listMcp(db).length, 1);
assert.deepEqual(mcpConfig(db), {}, 'un serveur est désactivé par défaut : rien dans la config d\'OpenCode');
assert.equal(enabledNamespaces(db).size, 0);
setMcpEnabled(db, 'faux_serveur', true);
const cfg = mcpConfig(db);
assert.equal(cfg.faux_serveur.type, 'local'); assert.equal(cfg.faux_serveur.enabled, true);
assert.equal(cfg.faux_serveur.command[0], 'node');
assert.ok(enabledNamespaces(db).has('faux_serveur'));
assert.throws(() => saveMcp(db, { name: 'x', command: '' }), /commande/);
assert.throws(() => saveMcp(db, { name: 'x', type: 'remote', url: 'ftp://x' }), /Adresse/);
console.log('  ✔ MCP : liste, désactivé par défaut, configuration d\'OpenCode');

const probe = await probeServer(listMcp(db)[0], 20000);
assert.equal(probe.ok, true, probe.error);
assert.equal(probe.tools.length, 1); assert.equal(probe.tools[0].name, 'echo'); assert.ok(probe.tokens > 0);
const bad = await probeServer({ type: 'local', command: ['node', path.join(TMP, 'inexistant.js')] }, 8000);
assert.equal(bad.ok, false);
console.log('  ✔ MCP : essai de connexion (outils listés, poids estimé, erreur claire)');

removeMcp(db, 'faux_serveur'); assert.equal(listMcp(db).length, 0);

// ---- Code Mode
const catalog = (ns) => `# Code Mode\n\nIntro\n\n- search({})\n\n## Code Mode tools (call only inside \`execute\`)\n\n${ns.map((n) => `- ${n} (3 tools, 1 shown) // desc\n  - tools.${n}.a({}): void`).join('\n')}`;
const mk = (nsList) => ({ messages: [{ role: 'system', content: `Début du prompt\n${catalog(nsList)}` }, { role: 'user', content: 'salut' }], tools: [{ function: { name: 'read' } }, { function: { name: 'execute' } }] });
let j = mk(['browser', 'opencode']);
const before = j.messages[0].content.length;
let r = trimCodeMode(j, new Set());
assert.ok(r.saved > 0 && !j.messages[0].content.includes('Code Mode'), 'aucun serveur activé : section retirée');
assert.ok(j.messages[0].content.startsWith('Début du prompt'));
assert.deepEqual(j.tools.map((t) => t.function.name), ['read'], 'et l\'outil execute avec');
j = mk(['browser', 'faux', 'opencode']);
r = trimCodeMode(j, new Set(['faux']));
assert.deepEqual(r.kept, ['faux']);
assert.ok(j.messages[0].content.includes('tools.faux.a') && !j.messages[0].content.includes('tools.browser') && !j.messages[0].content.includes('tools.opencode'));
assert.ok(j.messages[0].content.includes('search({})') && j.tools.some((t) => t.function.name === 'execute'), 'avec un serveur : search et execute restent');
assert.ok(before > 0);
j = { messages: [{ role: 'system', content: 'rien de spécial' }] };
assert.equal(trimCodeMode(j, new Set()).saved, 0);
console.log('  ✔ catalogue Code Mode : retiré sans serveur, filtré avec serveur');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* base encore ouverte : dossier jetable laissé dans Temp */ }
process.exit(0);
