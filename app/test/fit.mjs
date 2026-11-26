// Estimation « ça passe sur ma machine » : machine de référence 12 Go VRAM / 32 Go RAM, valeurs mesurées du projet.
import assert from 'node:assert/strict';
import { estimateFit, isMoe } from '../src/fit.js';
const G = 1073741824; const machine = { ramBytes: 32 * G, vramBytes: 12 * G, gpu: 'test' };
assert.ok(isMoe('qwen3moe') && isMoe('qwen3next') && isMoe('glm4moe') && !isMoe('llama') && !isMoe('gemma3'));
assert.equal(estimateFit(8 * G, { moe: false, machine }).tier, 'vram');
assert.equal(estimateFit(14 * G, { moe: false, machine }).tier, 'ram');
assert.equal(estimateFit(70 * G, { moe: false, machine }).tier, 'dense-slow');
assert.equal(estimateFit(17 * G, { moe: true, machine }).tier, 'ram');
const q48 = estimateFit(48 * G, { moe: true, machine }); assert.equal(q48.tier, 'stream-ok'); assert.ok(q48.cachePct >= 27, 'au moins le cache mesuré (27 %)');
assert.equal(estimateFit(85 * G, { moe: true, machine }).tier, 'stream-slow');
assert.equal(estimateFit(159 * G, { moe: true, machine }).tier, 'too-big');
assert.equal(estimateFit(40 * G, { moe: true, machine: { ...machine, vramBytes: 0 } }).tier !== 'vram', true);
console.log('  ✔ estimation d\'adéquation : VRAM / RAM / streamé / trop gros, MoE et dense');
