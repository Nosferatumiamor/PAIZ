// Conscience du temps : heure et moment de la journée, absence signalée, longue séance évoquée une seule fois (pas de maternage).
import assert from 'node:assert/strict';
const { timeNote } = await import('../src/clock.js');

const at = (h, m = 0, day = 24) => new Date(2026, 10, day, h, m).getTime();
const conv = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i === 0 ? 'Salut, on bosse sur PAIZ ?' : `message ${i}` }));

let t = timeNote(conv(1), at(15, 52));
assert.match(t, /15 h 52/); assert.match(t, /l'après-midi/); assert.match(t, /novembre 2026/);
assert.doesNotMatch(t, /revient|pause/, 'premier message : rien d’autre');

t = timeNote(conv(3), at(19, 0));
assert.match(t, /le soir/); assert.match(t, /revient après 3 h 08/, 'absence signalée');

// longue séance : messages rapprochés pendant plus de 2 h → une seule évocation
let n = 5; let nudges = 0;
for (let m = 5; m <= 150; m += 10) { const s = timeNote(conv(n), at(19, 0) + m * 60000); n += 2; if (/pause/.test(s)) nudges++; }
assert.equal(nudges, 1, 'la pause n’est proposée qu’une fois sur 2 h 30');

// une relance du même tour (même nombre de messages) ne compte ni comme nouveau message ni comme absence
t = timeNote(conv(n - 2), at(23, 0));
assert.doesNotMatch(t, /revient/);
assert.equal(timeNote([{ role: 'system', content: 'x' }]), '', 'sans message de l’utilisateur : rien');
console.log('  ✔ notion du temps : heure, absence, longue séance (une fois)');
