// Serveurs MCP choisis selon la question : un serveur dont la conversation ne parle pas est retiré du prompt ; il revient dès qu'on en
// parle (nom, synonyme, ou deux mots de ses outils), reste s'il a déjà servi, et la sélection ne rétrécit jamais en cours de conversation.
import assert from 'node:assert/strict';
const { pickNamespaces, relevance, userText, lastPick } = await import('../src/toolpick.js');
const { trimCodeMode, codeModeBlocks } = await import('../src/codemode.js');

const block = (ns, desc, tools) => `- ${ns} (${tools.length} tools, ${tools.length} shown) // ${desc}\n${tools.map((t) => `  - tools.${ns}.${t}({}): void`).join('\n')}`;
const catalog = `# Code Mode\n\nUtilise execute pour appeler ces outils.\n\n## Code Mode tools (call only inside \`execute\`)\n\n${[
  block('blender', 'Control Blender: objects, materials, render', ['get_scene_info', 'create_object', 'set_material', 'render_image']),
  block('comfyui', 'Run ComfyUI workflows and queue prompts', ['queue_workflow', 'list_models', 'get_history']),
  block('exa', 'Search the web with Exa', ['web_search_exa']),
].join('\n')}\n\n# Autre section\nfin`;
const req = (users, extra = []) => ({ messages: [{ role: 'system', content: catalog }, ...users.map((u) => ({ role: 'user', content: u })), ...extra], tools: [{ type: 'function', function: { name: 'read' } }, { type: 'function', function: { name: 'execute' } }] });
const blocks = codeModeBlocks(req([]));
assert.deepEqual(Object.keys(blocks), ['blender', 'comfyui', 'exa']);

// une question sans rapport : aucun serveur, la section et `execute` disparaissent
let j = req(['Corrige la faute dans README.md']);
let keep = pickNamespaces(blocks, j.messages);
assert.equal(keep.size, 0);
const before = JSON.stringify(j).length; const r = trimCodeMode(j, keep);
assert.ok(r.saved > 300 && !JSON.stringify(j).includes('Code Mode') && !j.tools.some((t) => t.function.name === 'execute'));
assert.ok(lastPick().dropped.length === 3);
console.log(`  ✔ choix MCP : question sans rapport → catalogue retiré (${before - JSON.stringify(j).length} caractères de moins)`);

// nom, synonyme, accents et majuscules
assert.ok(relevance('blender', blocks.blender, userText([{ role: 'user', content: 'Fais-moi un mesh de table en 3D' }])));
assert.ok(relevance('comfyui', blocks.comfyui, userText([{ role: 'user', content: 'Génère une image de chat roux' }])));
assert.ok(relevance('exa', blocks.exa, userText([{ role: 'user', content: 'Cherche sur internet la date de sortie' }])));
assert.equal(relevance('blender', blocks.blender, userText([{ role: 'user', content: 'Explique ce code JavaScript' }])), null);
assert.equal(relevance('exa', blocks.exa, userText([{ role: 'user', content: 'texa' }])), null, 'mot entier seulement');
j = req(['Ouvre Blender et ajoute un cube']); keep = pickNamespaces(blocks, j.messages);
assert.deepEqual([...keep], ['blender']); trimCodeMode(j, keep);
assert.ok(j.messages[0].content.includes('tools.blender.') && !j.messages[0].content.includes('tools.comfyui.'));
console.log('  ✔ choix MCP : nom ou synonyme (3D, image, internet…) → seulement le serveur concerné');

// la sélection ne rétrécit pas : un ancien message suffit à garder le serveur (le début du prompt reste en cache)
keep = pickNamespaces(blocks, req(['Ouvre Blender et ajoute un cube', 'Merci, maintenant explique le code']).messages);
assert.ok(keep.has('blender'));
// déjà utilisé par le modèle : gardé même si l'utilisateur n'en parle plus
const used = [{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'execute', arguments: '{"code":"await tools.comfyui.queue_workflow({})"}' } }] }];
keep = pickNamespaces(blocks, req(['Fais le nécessaire'], used).messages);
assert.ok(keep.has('comfyui') && lastPick().kept.find((k) => k.ns === 'comfyui').why.includes('déjà utilisé'));
// réglage « tous » : rien n'est retiré
assert.equal(pickNamespaces(blocks, req(['bonjour']).messages, { mode: 'all' }).size, 3);
console.log('  ✔ choix MCP : sélection stable en cours de conversation, serveur déjà utilisé gardé, réglage « tous »');
