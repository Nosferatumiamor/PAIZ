// Captures d'écran de l'interface pour le README, SANS toucher au bureau : un Edge sans fenêtre (headless) piloté par CDP,
// branché sur l'instance de démonstration (npm run demo, données factices dans le dossier temporaire).
// Usage : node scripts/screenshots.mjs <dossier de sortie> [url=http://127.0.0.1:7799]
// Important : lancer le démo avec TEMP/TMP vers un dossier neutre, sinon les chemins affichés contiennent le nom d'utilisateur Windows.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const out = path.resolve(process.argv[2] || 'shots');
const url = process.argv[3] || 'http://127.0.0.1:7799';
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9444;
fs.mkdirSync(out, { recursive: true });
const prof = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'edge-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--window-size=1360,860', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch { /* pas prêt */ } await sleep(300); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 860, deviceScaleFactor: 1, mobile: false });
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, 'base64')); console.log('  ✔', name); };
const click = (text) => ev(`(() => { const el = [...document.querySelectorAll('button,[role=tab],a,.tab,.cf-click')].find((e) => e.offsetParent && (e.textContent || '').trim().replace(/\\s+/g, ' ').includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
const steps = JSON.parse(fs.readFileSync(process.env.STEPS || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'screenshots.steps.json'), 'utf8'));
await send('Page.navigate', { url });
await sleep(2500);
if (process.env.LIST) { if (process.env.LIST !== '1') await click(process.env.LIST), await sleep(1500); console.log(await ev(`[...document.querySelectorAll('button,[role=tab]')].filter((e) => e.offsetParent).map((e) => (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40)).join(' | ')`)); }
else for (const s of steps) {
  for (const c of s.clicks || []) { const ok = await click(c); if (!ok) console.log('  ⚠ bouton introuvable :', c); await sleep(s.wait || 1200); }
  if (s.eval) { await ev(s.eval); await sleep(800); }
  if (s.name) await shot(s.name);
}
ws.close(); edge.kill();
await sleep(500); try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* verrou */ }
process.exit(0);
