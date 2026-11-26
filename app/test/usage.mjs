// Suivi des modèles : usage (moteur / relais), origine + date, statuts (étoile / actif / ancien / jamais utilisé / nouveau), recul du suivi.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-usage-'));
process.env.PAIZ_HOME = path.join(TMP, 'home');
const { openDb, addRoot, setSetting, getSetting, logEvent } = await import('../src/db.js');
const { scanPath } = await import('../src/scanner.js');
const { logUse, logUseByPath, programOf, recordSource, usageReport, keyOf, TH, recentMap } = await import('../src/usage.js');
const db = openDb();

const dir = path.join(TMP, 'actif'); fs.mkdirSync(dir);
const hdr = Buffer.alloc(24); hdr.write('GGUF', 0); hdr.writeUInt32LE(3, 4);
const mk = (name, extra = 100) => { const p = path.join(dir, name); fs.writeFileSync(p, Buffer.concat([hdr, Buffer.alloc(extra, 7)])); return p; };
const pStar = mk('etoile-Q4_K_M.gguf', 100); const pActif = mk('actif-Q4_K_M.gguf', 200); const pOld = mk('ancien-Q4_K_M.gguf', 300);
const pNever = mk('jamais-Q4_K_M.gguf', 400); const pDl = mk('telecharge-Q4_K_M.gguf', 500);
const root = addRoot(db, { name: 'actif', path: dir, role: 'active' });
await scanPath(db, { dir, rootId: root.id, minBytes: 1 });
const asset = (n) => usageReport(db).rows.find((r) => r.file_name === n);
const assets = Object.fromEntries(['etoile', 'actif', 'ancien', 'jamais', 'telecharge'].map((n) => [n, asset(`${n}-Q4_K_M.gguf`)]));
assert.ok(Object.values(assets).every(Boolean), 'les 5 modèles sont au catalogue');

// programmes reconnus
assert.equal(programOf({ headers: { 'x-paiz-persona': '1' } }), 'OpenCode (écran Travail)');
assert.equal(programOf({ headers: { 'user-agent': 'opencode/1.2' } }), 'OpenCode (externe)');
assert.match(programOf({ headers: { 'user-agent': 'python-requests/2.31' } }), /python-requests/);
assert.equal(programOf({ headers: {} }), 'Client OpenAI');

// un lancement du moteur compte ; une requête du relais compte une seule fois par tranche de 20 min et par programme
for (let i = 0; i < 6; i++) logUse(db, assets.etoile, 'PAIZ · moteur', 'profil normal');
logUseByPath(db, pActif, 'OpenCode (écran Travail)'); logUseByPath(db, pActif, 'OpenCode (écran Travail)'); logUseByPath(db, pActif, 'OpenCode (écran Travail)');
logUseByPath(db, pActif, 'Client « curl »');
let r = asset('actif-Q4_K_M.gguf');
assert.equal(r.uses, 2, 'requêtes répétées du même programme : comptées une fois ; un autre programme : une fois de plus');
assert.deepEqual(r.programs.map((p) => p.name).sort(), ['Client « curl »', 'OpenCode (écran Travail)']);
assert.equal(asset('etoile-Q4_K_M.gguf').uses, 6);

// origine + date d'un téléchargement ; ancien téléchargement (dépôt seul, sans date)
recordSource(db, pDl, { repo: 'unsloth/gemma-test' });
r = asset('telecharge-Q4_K_M.gguf');
assert.equal(r.source.repo, 'unsloth/gemma-test'); assert.ok(r.source.downloadedAt, 'date de téléchargement notée');
setSetting(db, 'hub.origins', JSON.stringify({ 'ancien-q4_k_m.gguf': 'vieux/depot' }));
r = asset('ancien-Q4_K_M.gguf');
assert.equal(r.source.repo, 'vieux/depot'); assert.equal(r.source.downloadedAt, null, 'ancien téléchargement : date inconnue');
assert.equal(asset('jamais-Q4_K_M.gguf').source, null, 'origine inconnue');

// statuts : on avance l'horloge
const at = (days) => Date.now() + days * 86400000;
const st = (n, now) => usageReport(db, now).rows.find((x) => x.file_name === n).status;
assert.equal(st('jamais-Q4_K_M.gguf', at(1)), 'nouveau', 'suivi récent : pas de jugement');
assert.equal(st('etoile-Q4_K_M.gguf', at(1)), 'star', '6 usages récents : étoile');
assert.equal(st('actif-Q4_K_M.gguf', at(1)), 'actif');
assert.equal(st('jamais-Q4_K_M.gguf', at(TH.graceDays + 1)), 'jamais', 'après le délai de grâce : jamais utilisé');
assert.equal(st('actif-Q4_K_M.gguf', at(TH.oldDays + 5)), 'ancien', 'sans usage depuis > 90 jours : ancien');
assert.equal(st('etoile-Q4_K_M.gguf', at(TH.starRecentDays + 5)), 'actif', 'plus récent depuis longtemps : plus étoile, encore actif');
const rep = usageReport(db, at(TH.oldDays + 5));
assert.equal(rep.summary.jamais, 3, 'jamais utilisés : jamais, ancien-sans-usage, telecharge');
assert.ok(rep.summary.reclaimBytes > 0 && rep.summary.reclaimCount >= 3, 'place récupérable sur les disques actifs');
assert.ok(getSetting(db, 'models.usage.since'), 'début du suivi noté');
assert.equal(keyOf('A.gguf', 5), 'a.gguf|5');
// récence : un rangement / une invocation (événement « move ») ou un usage remonte le modèle ; jamais touché = absent
const rec0 = recentMap(db);
assert.ok(rec0[assets.etoile.id] && rec0[assets.actif.id], 'les modèles utilisés ont une date');
assert.equal(rec0[assets.jamais.id], undefined, 'jamais touché : pas de date');
const t1 = new Date(Date.now() + 5000).toISOString();
db.prepare('INSERT INTO events (at, type, asset_id, detail) VALUES (?, ?, ?, ?)').run(t1, 'move', assets.jamais.id, '{}');
const rec1 = recentMap(db);
assert.equal(rec1[assets.jamais.id], t1, 'un rangement / une invocation donne une date');
const ordre = Object.entries(rec1).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).map(([id]) => Number(id));
assert.equal(ordre[0], assets.jamais.id, 'le dernier rangé est en tête');
console.log('  ✔ suivi des modèles : usage, programmes, origine + date, statuts');
