// Skills : en-tête SKILL.md, liste, activation (déplacement de dossier), retrait, adresse GitHub. Hors ligne.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-skills-'));
process.env.PAIZ_HOME = TMP;
const { parseFrontmatter, listSkills, setSkillEnabled, removeSkill, parseGithub, installBuiltin, SKILLS_OFF, SKILLS_ON, ensureSkillDirs } = await import('../src/skills.js');

assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: "Fait X"\n---\ncorps'), { name: 'a', description: 'Fait X' });
assert.equal(parseFrontmatter('---\nname: b\ndescription: >\n  ligne un\n  ligne deux\n---\n').description, 'ligne un ligne deux');
assert.deepEqual(parseFrontmatter('pas d en-tête'), {});
assert.deepEqual(parseGithub('https://github.com/a/b'), { owner: 'a', repo: 'b', branch: 'HEAD', sub: '' });
assert.deepEqual(parseGithub('a/b.git'), { owner: 'a', repo: 'b', branch: 'HEAD', sub: '' });
assert.deepEqual(parseGithub('https://github.com/a/b/tree/main/skills/x'), { owner: 'a', repo: 'b', branch: 'main', sub: 'skills/x' });
assert.throws(() => parseGithub('https://example.com/a/b'), /invalide/);
console.log('  ✔ skills : en-tête et adresses GitHub');

ensureSkillDirs();
fs.mkdirSync(path.join(SKILLS_OFF, 'demo')); fs.writeFileSync(path.join(SKILLS_OFF, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Pour tester.\n---\nx');
let l = listSkills(); assert.equal(l.length, 1); assert.equal(l[0].enabled, false); assert.equal(l[0].tokens, 0);
setSkillEnabled('demo', true);
l = listSkills(); assert.equal(l[0].enabled, true); assert.ok(l[0].tokens > 0); assert.ok(fs.existsSync(path.join(SKILLS_ON, 'demo', 'SKILL.md')));
setSkillEnabled('demo', false); assert.equal(listSkills()[0].enabled, false);
assert.throws(() => setSkillEnabled('absent', true), /inconnu/);
removeSkill('demo'); assert.equal(listSkills().length, 0);
console.log('  ✔ skills : liste, activation, retrait');
// skill ComfyUI fourni : installation puis vérificateur de workflow contre un faux ComfyUI
assert.deepEqual(installBuiltin('comfyui-workflows'), ['comfyui-workflows']);
assert.equal(listSkills().find((x) => x.id === 'comfyui-workflows').enabled, false);
const script = path.join(SKILLS_OFF, 'comfyui-workflows', 'scripts', 'comfy.mjs');
assert.ok(fs.existsSync(script));
const info = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors']] } }, output: ['MODEL', 'CLIP', 'VAE'] },
  CLIPTextEncode: { input: { required: { text: ['STRING', {}], clip: ['CLIP'] } }, output: ['CONDITIONING'] },
  EmptyLatentImage: { input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } }, output: ['LATENT'] },
  KSampler: { input: { required: { seed: ['INT', {}], model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'] } }, output: ['LATENT'] },
};
const srv = http.createServer((q, r) => { r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify(q.url === '/object_info' ? info : [])); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const host = `http://127.0.0.1:${srv.address().port}`;
const run = (...a) => new Promise((res) => { execFile(process.execPath, [script, ...a, '--host', host], { cwd: TMP }, (e, out, err) => res({ code: e ? e.code : 0, out: out + err })); });
assert.equal((await run('nodes')).code, 0);
const good = { 4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } }, 6: { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['4', 1] } }, 5: { class_type: 'EmptyLatentImage', inputs: { width: 8, height: 8, batch_size: 1 } }, 3: { class_type: 'KSampler', inputs: { seed: 1, model: ['4', 0], positive: ['6', 0], negative: ['6', 0], latent_image: ['5', 0] } } };
fs.writeFileSync(path.join(TMP, 'ok.json'), JSON.stringify(good));
assert.equal((await run('check', 'ok.json')).code, 0);
const bad = structuredClone(good); bad[3].inputs.model = ['4', 1]; bad[4].inputs.ckpt_name = 'zzz'; bad[7] = { class_type: 'Inconnu', inputs: {} }; bad[6].inputs.clip = ['99', 0];
fs.writeFileSync(path.join(TMP, 'bad.json'), JSON.stringify(bad));
const b2 = await run('check', 'bad.json');
assert.equal(b2.code, 2);
for (const m of ['attend MODEL, reçoit CLIP', 'absent des choix', "n'existe pas dans ce ComfyUI", "node 99 qui n'existe pas"]) assert.ok(b2.out.includes(m), m);
fs.writeFileSync(path.join(TMP, 'ed.json'), JSON.stringify({ nodes: [], links: [] }));
assert.notEqual((await run('check', 'ed.json')).code, 0);
srv.close();
console.log('  ✔ skills : ComfyUI fourni (installation, vérification des liens, types, choix, nodes inconnus)');
fs.rmSync(TMP, { recursive: true, force: true });
