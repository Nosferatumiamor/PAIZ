// /v1 de PAIZ : relais vers un faux moteur, balise « <|channel>thought<channel|> » retirée (JSON et SSE, y compris coupée en morceaux).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-proxy-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb, setSetting } = await import('../src/db.js');
const { startServer } = await import('../src/server.js');
const { selectTools } = await import('../src/proxy.js');
const db = openDb();

const sse = (parts) => parts.map((c) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: c }] })}\n\n`).join('') + 'data: [DONE]\n\n';
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    const j = JSON.parse(b || '{}');
    globalThis.__lastBody = j;
    if (j.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (j.tag === 'slow') { // flux lent : deux morceaux, une pause, puis la fin (pour l'aperçu en direct)
        const one = (c) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: c }] })}

`;
        res.write(one({ content: 'Premier ' })); res.write(one({ content: 'morceau' }));
        setTimeout(() => res.end(`${one({ content: ' et suite' })}data: [DONE]

`), 700);
        return;
      }
      const t = j.tag === 'tool'
        ? [{ content: '<|channel>' }, { content: 'thought\n' }, { content: '<channel|>' }, { tool_calls: [{ index: 0, function: { name: 'x' } }] }]
        : j.tag === 'plain' ? [{ content: 'Bon' }, { content: 'jour' }]
          : [{ content: '<|channel>' }, { content: 'thought\n' }, { content: '<channel|>' }, { content: 'Salut' }, { content: ' toi' }];
      res.end(sse(t));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '<|channel>thought\n<channel|>Salut' } }] }));
    }
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
setSetting(db, 'engine.port', fake.address().port);
const { server } = await startServer({ port: 0, open: false });
const url = `http://127.0.0.1:${server.address().port}`;

const post = (body) => fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const streamText = async (body) => {
  const t = await (await post({ ...body, stream: true })).text();
  return t.split('\n\n').filter((e) => e.startsWith('data: {')).map((e) => JSON.parse(e.slice(6)).choices[0].delta.content || '').join('');
};

assert.equal((await (await post({})).json()).choices[0].message.content, 'Salut');
assert.equal(await streamText({}), 'Salut toi');
assert.equal(await streamText({ tag: 'plain' }), 'Bonjour');
const tool = await (await post({ stream: true, tag: 'tool' })).text();
assert.ok(tool.includes('"tool_calls"') && !tool.includes('channel'), 'appel d\'outil conservé, balise retirée');
const mk = (text) => ({ messages: [{ role: 'system', content: 'x' }, { role: 'user', content: text }], tools: ['read', 'edit', 'write', 'glob', 'grep', 'shell', 'webfetch', 'websearch', 'subagent', 'skill', 'question', 'execute', 'experimental_image_generate', 'mon_outil_mcp'].map((n) => ({ type: 'function', function: { name: n } })) });
const names = (j) => j.tools.map((t) => t.function.name);
let j = mk('Crée un jeu Pong dans ce dossier'); selectTools(j, 'auto');
assert.deepEqual(names(j), ['read', 'edit', 'write', 'glob', 'grep', 'mon_outil_mcp'], 'tâche simple : cœur + outils inconnus seulement');
j = mk('Corrige le bug puis fais git commit et lance les tests'); selectTools(j, 'auto');
assert.ok(names(j).includes('shell') && !names(j).includes('webfetch'), 'git/tests : terminal activé, web non');
j = mk('Regarde sur github comment ils font'); selectTools(j, 'auto');
assert.ok(names(j).includes('webfetch') && !names(j).includes('shell'), 'github : web activé');
j = mk('Corrige le bug puis git commit'); selectTools(j, 'focus');
assert.ok(!names(j).includes('shell'), 'focus : jamais de terminal');
j = mk('git commit'); selectTools(j, 'all', [], true); assert.equal(j.tools.length, 14, 'tous : rien retiré (websearch gardé sur demande)');
console.log('  ✔ sélection des outils par tâche (auto / focus / tous)');
// pause / reprise / stop du relais (écran Travail) : la requête suivante est retenue, la reprise la libère, le stop abandonne la file
const { relayPause, relayAbortAll, relayStatus } = await import('../src/proxy.js');
relayPause(true);
assert.equal(relayStatus().paused, true);
let done = false;
const held = post({ stream: true }).then(async (r) => { await r.text(); done = true; return r.status; });
await new Promise((r) => setTimeout(r, 300));
assert.equal(done, false, 'pause : requête retenue');
assert.equal(relayStatus().held, 1);
relayPause(false);
assert.equal(await held, 200); assert.equal(relayStatus().held, 0, 'reprise : requête libérée');
relayPause(true);
const held2 = post({ stream: true }).then((r) => r.status);
await new Promise((r) => setTimeout(r, 200));
relayAbortAll();
assert.equal(await held2, 499, 'stop : requête retenue abandonnée'); assert.equal(relayStatus().paused, false, 'stop : pause levée');
assert.ok(relayStatus().last && relayStatus().last.outTok >= 2, 'suivi : jetons comptés');
console.log('  ✔ relais : pause / reprise / stop + suivi d avancement');
// aperçu en direct : le texte déjà reçu du moteur est visible pendant que la réponse continue d'arriver
const { relayLive } = await import('../src/proxy.js');
const slow = post({ stream: true, tag: 'slow' }).then((r) => r.text());
await new Promise((r) => setTimeout(r, 350));
const mid = await relayLive();
assert.equal(mid.active, true); assert.equal(mid.writing, true); assert.equal(mid.text, 'Premier morceau', 'aperçu : texte partiel visible avant la fin');
await slow;
assert.equal((await relayLive()).active, false, 'aperçu : plus rien une fois la réponse finie');
console.log('  ✔ aperçu en direct : texte partiel visible pendant l ecriture');
// « caractère » du modèle : ajouté aux requêtes de l'écran Travail (en-tête), jamais aux autres clients
const { setActivePersona, savePersona } = await import('../src/persona.js');
const postH = (body, h) => fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
const msgs = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'salut' }];
await (await postH({ messages: msgs }, {})).text();
assert.equal(globalThis.__lastBody.messages[0].content, 'SYS', 'sans en-tête : requête intacte');
await (await postH({ messages: msgs }, { 'X-Paiz-Persona': '1' })).text();
assert.match(globalThis.__lastBody.messages[0].content, /^SYS[\s\S]*assistant de programmation/, 'profil Assistant ajouté après le système');
setActivePersona(db, savePersona(db, { name: 'Pirate', text: 'Parle comme un pirate.' }));
await (await postH({ messages: msgs }, { 'X-Paiz-Persona': '1' })).text();
assert.match(globalThis.__lastBody.messages[0].content, /Parle comme un pirate/, 'profil perso appliqué');
setActivePersona(db, 'aucun');
await (await postH({ messages: msgs }, { 'X-Paiz-Persona': '1' })).text();
assert.equal(globalThis.__lastBody.messages[0].content, 'SYS', 'profil Aucun : rien ajouté');
console.log('  ✔ caractère du modèle : ajouté seulement avec l en-tête, profils fournis et perso');
console.log('  ✔ /v1 : balise parasite retirée (JSON, flux, flux coupé, appel d\'outil)');
server.closeAllConnections(); fake.closeAllConnections(); server.close(); fake.close();
