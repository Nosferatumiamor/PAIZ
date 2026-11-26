#!/usr/bin/env node
// Plafond théorique de génération (décodage) d'un modèle GGUF, pour situer nos mesures : « à quel % du possible est-on ? ».
// Méthode reprise du skill inference-optimisation (sybil-solutions, licence MIT, references/ceilings.md), adaptée au streaming
// d'experts de WeightStream : les poids denses restent en VRAM, les experts actifs viennent du cache VRAM (succès) ou, en cas
// d'échec, de la RAM par le PCIe, voire du SSD.
//
//   node engine/scripts/ceiling.mjs <modele.gguf> [--vram-gbs 360] [--pcie-gbs 12] [--ssd-gbs 3] [--ctx 4096] [--kv-bytes 2]
//                                                 [--ram-hit 1] [--hits 0.5,0.7,0.8,0.9,0.95] [--json]
//
// Lit seulement l'en-tête du fichier (tailles réelles des tenseurs, quantification comprise ; jamais « paramètres × bits »).
// Les débits par défaut sont ceux de la machine de référence (RTX 3060 12 Go, PCIe 4.0 x16, NVMe) : à MESURER sur ta machine et passer en options.
// Un plafond est une borne haute (100 % du débit mesuré, aucun coût de calcul ni de synchronisation) : la vitesse réelle est en dessous.
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^[\d.,]+$/.test(a));
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
if (!file || !fs.existsSync(file)) { console.error('usage : node ceiling.mjs <modele.gguf> [--vram-gbs 360] [--pcie-gbs 12] [--ssd-gbs 3] [--ctx 4096] [--hits 0.5,0.8,0.95] [--json]'); process.exit(2); }
const BW = { vram: Number(opt('vram-gbs', 360)) * 1e9, pcie: Number(opt('pcie-gbs', 12)) * 1e9, ssd: Number(opt('ssd-gbs', 3)) * 1e9 };
const CTX = Number(opt('ctx', 4096)); const KVB = Number(opt('kv-bytes', 2)); const RAM_HIT = Number(opt('ram-hit', 1));
const HITS = String(opt('hits', '0.5,0.7,0.8,0.9,0.95')).split(',').map(Number);

// ---------------------------------------------------------------- lecture de l'en-tête GGUF (méta + table des tenseurs)
const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
let buf = Buffer.alloc(0); let base = 0; let pos = 0;
const need = (n) => { if (pos + n <= base + buf.length) return; const len = Math.max(n, 8 << 20); const b = Buffer.alloc(len); const r = fs.readSync(fd, b, 0, len, pos); buf = b.subarray(0, r); base = pos; };
const u32 = () => { need(4); const v = buf.readUInt32LE(pos - base); pos += 4; return v; };
const u64 = () => { need(8); const v = Number(buf.readBigUInt64LE(pos - base)); pos += 8; return v; };
const str = () => { const n = u64(); need(n); const s = buf.toString('utf8', pos - base, pos - base + n); pos += n; return s; };
const SCALAR = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
function value(t) {
  if (t === 8) return str();
  if (t === 9) { const it = u32(); const n = u64(); const out = []; for (let i = 0; i < n; i++) { const v = value(it); if (out.length < 512) out.push(v); } return out; }
  const n = SCALAR[t]; need(n); const o = pos - base; pos += n;
  switch (t) { case 0: return buf.readUInt8(o); case 1: return buf.readInt8(o); case 2: return buf.readUInt16LE(o); case 3: return buf.readInt16LE(o); case 4: return buf.readUInt32LE(o); case 5: return buf.readInt32LE(o);
    case 6: return buf.readFloatLE(o); case 7: return buf.readUInt8(o) !== 0; case 10: return Number(buf.readBigUInt64LE(o)); case 11: return Number(buf.readBigInt64LE(o)); default: return buf.readDoubleLE(o); }
}
need(24); if (buf.toString('ascii', 0, 4) !== 'GGUF') { console.error('Pas un fichier GGUF.'); process.exit(2); }
pos = 4; u32(); const nT = u64(); const nKV = u64();
const meta = {}; for (let i = 0; i < nKV; i++) { const k = str(); meta[k] = value(u32()); }
const tensors = []; for (let i = 0; i < nT; i++) { const name = str(); const nd = u32(); for (let d = 0; d < nd; d++) u64(); u32(); tensors.push({ name, off: u64() }); }
const align = Number(meta['general.alignment'] || 32); const dataStart = Math.ceil(pos / align) * align;
const sorted = [...tensors].sort((a, b) => a.off - b.off);
sorted.forEach((t, i) => { t.bytes = (i + 1 < sorted.length ? sorted[i + 1].off : size - dataStart) - t.off; });
fs.closeSync(fd);
if (args.includes('--split-warning') || /-0000\d-of-/.test(file)) console.error('Attention : modèle en plusieurs morceaux, seul ce fichier est compté.');

// ---------------------------------------------------------------- octets lus par mot généré
const arch = meta['general.architecture']; const m = (k) => meta[`${arch}.${k}`];
const nExp = Number(m('expert_count') || 0); const nUsed = Number(m('expert_used_count') || 0);
const sum = (f) => tensors.filter(f).reduce((n, t) => n + t.bytes, 0);
const isExp = (t) => /_exps\.(weight|bias|scale)/.test(t.name);
const expertTotal = sum(isExp);
const hasOutput = tensors.some((t) => t.name === 'output.weight');
const lmHead = hasOutput ? sum((t) => t.name === 'output.weight') : sum((t) => t.name === 'token_embd.weight'); // tête liée aux embeddings
const dense = sum((t) => !isExp(t) && t.name !== 'token_embd.weight' && t.name !== 'output.weight'); // l'embedding n'est lu qu'à raison d'une ligne par mot
const expertActive = nExp ? expertTotal * (nUsed / nExp) : 0;
const layers = Number(m('block_count') || 0);
const kvHeads = [].concat(m('attention.head_count_kv') ?? m('attention.head_count') ?? 0).map(Number);
const kvh = kvHeads.length > 1 ? kvHeads.reduce((a, b) => a + b, 0) / kvHeads.length : kvHeads[0];
const kDim = Number(m('attention.key_length') || (Number(m('embedding_length')) / Number([].concat(m('attention.head_count'))[0] || 1)));
const vDim = Number(m('attention.value_length') || kDim);
const swa = Number(m('attention.sliding_window') || 0);
const kvPerTok = layers * kvh * (kDim + vDim) * KVB; // borne haute : toutes les couches gardent tout le contexte
const kvRead = kvPerTok * CTX;

const tokps = (sec) => (sec > 0 ? 1 / sec : Infinity);
const allVram = tokps((dense + lmHead + expertActive + kvRead) / BW.vram);
// streaming : dense + tête + KV en VRAM ; experts actifs : succès du cache VRAM au débit VRAM, échecs par le PCIe (depuis la RAM) ou SSD puis PCIe
const missCost = (b) => RAM_HIT * (b / BW.pcie) + (1 - RAM_HIT) * (b / BW.ssd + b / BW.pcie);
const streamed = HITS.map((h) => ({ hit: h, tokps: tokps((dense + lmHead + kvRead) / BW.vram + expertActive * h / BW.vram + missCost(expertActive * (1 - h))) }));
const fromSsd = tokps((dense + lmHead + kvRead) / BW.vram + expertActive / BW.ssd + expertActive / BW.pcie);

const G = (b) => `${(b / 1e9).toFixed(2)} Go`;
const out = { file, arch, layers, experts: nExp ? `${nUsed}/${nExp}` : 'dense', bytesPerToken: { dense, lmHead, expertActive, expertTotal, kvRead }, kvPerToken: kvPerTok, swa,
  bandwidth: { vramGBs: BW.vram / 1e9, pcieGBs: BW.pcie / 1e9, ssdGBs: BW.ssd / 1e9 }, ctx: CTX,
  ceilings: { allInVram: allVram, streamed, allMissesFromSsd: fromSsd }, vramForAllInVram: dense + lmHead + expertTotal + kvPerTok * CTX, vramFloorStreaming: dense + lmHead + kvPerTok * CTX };
if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
console.log(`\n${file}\n  architecture ${arch} · ${layers} couches · ${nExp ? `MoE ${nUsed}/${nExp} experts par mot` : 'dense (rien à streamer)'}${swa ? ` · fenêtre glissante ${swa}` : ''}`);
console.log(`\n  Octets lus par mot (contexte ${CTX}) :`);
console.log(`    poids denses (attention, partagés, routeur)  ${G(dense)}`);
console.log(`    tête de sortie                                ${G(lmHead)}`);
if (nExp) console.log(`    experts actifs (${nUsed}/${nExp} de ${G(expertTotal)})       ${G(expertActive)}`);
console.log(`    cache KV lu (borne haute${swa ? ', fenêtre glissante non déduite' : ''})          ${G(kvRead)}`);
console.log(`\n  Plafonds (débits : VRAM ${BW.vram / 1e9} Go/s, PCIe ${BW.pcie / 1e9} Go/s, SSD ${BW.ssd / 1e9} Go/s) :`);
console.log(`    tout en VRAM (il faudrait ${G(out.vramForAllInVram)} de VRAM)      ${allVram.toFixed(1)} mots/s`);
if (nExp) {
  console.log(`    streaming, VRAM minimale ${G(out.vramFloorStreaming)} + cache d'experts :`);
  for (const s of streamed) console.log(`      cache VRAM ${String(Math.round(s.hit * 100)).padStart(3)} % de succès${RAM_HIT < 1 ? `, RAM ${Math.round(RAM_HIT * 100)} %` : ', échecs servis par la RAM'}   ${s.tokps.toFixed(1)} mots/s`);
  console.log(`    tous les experts depuis le SSD (pire cas)     ${fromSsd.toFixed(1)} mots/s`);
}
console.log('\n  Borne haute : la vitesse mesurée sera en dessous. Mesure tes débits réels (copie VRAM, transfert PCIe, lecture SSD) et passe-les en options.\n');
