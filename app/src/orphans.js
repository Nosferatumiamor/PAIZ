// Registre des processus lancés par PAIZ (moteur, œil, serveur OpenCode) : si PAIZ meurt brutalement (plantage, arrêt forcé),
// ces processus peuvent survivre. Au démarrage suivant, on retrouve ceux que PAIZ avait lancés et on les termine.
// Garde-fou : on ne tue un PID que si son nom d'exécutable ET son heure de création correspondent à ce qui a été enregistré
// (un PID réutilisé par un autre programme, par exemple le serveur d'une autre appli, n'est jamais touché).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'children.json');

function readAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } }
function writeAll(list) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list)); } catch { /* disque indisponible : pas bloquant */ } }

// Enregistre un processus enfant (à appeler juste après spawn) ; se désenregistre tout seul quand il s'arrête.
export function registerChild(kind, proc, exePath) {
  if (!proc?.pid) return;
  const entry = { kind, pid: proc.pid, exe: path.basename(String(exePath || '')).toLowerCase(), startedAt: Date.now() };
  writeAll([...readAll().filter((e) => e.pid !== entry.pid), entry]);
  proc.once('exit', () => writeAll(readAll().filter((e) => e.pid !== entry.pid)));
}

// Heure de création (ms depuis 1970) et nom des processus demandés, par PowerShell ; {} si indisponible.
function inspect(pids) {
  if (process.platform !== 'win32' || !pids.length) return {};
  const script = `Get-CimInstance Win32_Process | Where-Object { @(${pids.join(',')}) -contains $_.ProcessId } | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const out = {};
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const [pid, name, created] = line.trim().split('|');
    if (pid && name) out[Number(pid)] = { name: name.toLowerCase(), created: Number(created) };
  }
  return out;
}

// Au démarrage de PAIZ : termine les processus laissés par une session précédente. Renvoie la liste de ceux qui ont été arrêtés.
export function sweepOrphans() {
  const list = readAll();
  if (!list.length) return [];
  const live = inspect(list.map((e) => e.pid));
  const killed = [];
  for (const e of list) {
    const p = live[e.pid];
    // même exécutable, créé au plus tard peu après l'enregistrement et jamais avant lui de plus de 60 s : c'est bien le nôtre
    if (p && p.name === e.exe && Math.abs(p.created - e.startedAt) < 60000) {
      spawnSync('taskkill', ['/PID', String(e.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killed.push({ kind: e.kind, pid: e.pid });
    }
  }
  writeAll([]);
  if (killed.length) console.log(`[paiz] processus laissés par une session précédente, arrêtés : ${killed.map((k) => `${k.kind}#${k.pid}`).join(', ')}`);
  return killed;
}

// ---- Moteurs égarés : processus du moteur (build-llama\bin) que PAIZ n'a PAS lancés ou dont le lanceur a disparu ----
// PAIZ ne les arrête jamais seul (ce peut être le serveur d'un autre programme, un test en cours...) : il les LISTE
// dans Entretien et l'utilisateur choisit. Garde-fou à l'arrêt : le PID doit toujours porter le même exécutable du dossier du moteur.
const STRAY_NAMES = /^(llama-server|llama-cli|llama-bench|llama-perplexity|ws_npc_server[^.]*|ws_moe_probe[^.]*)\.exe$/i;

function psJson(script) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  try { const j = JSON.parse(String(r.stdout || '').trim() || '[]'); return Array.isArray(j) ? j : [j]; } catch { return []; }
}

export function findStrays(engineDir) {
  if (process.platform !== 'win32' || !engineDir) return [];
  const bin = path.join(engineDir, 'build-llama', 'bin').toLowerCase();
  const rows = psJson(`Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; path=$_.ExecutablePath; cmd=$_.CommandLine; mb=[int]($_.WorkingSetSize/1MB); created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } } | ConvertTo-Json -Compress`);
  const alive = new Set(rows.map((r) => r.pid));
  const mine = new Set(readAll().map((e) => e.pid));
  return rows
    .filter((r) => r.path && r.path.toLowerCase().startsWith(bin) && STRAY_NAMES.test(r.name || '') && !mine.has(r.pid))
    .map((r) => ({ pid: r.pid, name: r.name, mb: r.mb, startedAt: r.created, command: String(r.cmd || '').slice(0, 300), parentAlive: alive.has(r.ppid) }));
}

export function stopStray(engineDir, pid) {
  const cur = findStrays(engineDir).find((s) => s.pid === Number(pid));
  if (!cur) throw new Error('Ce processus n’est plus un moteur égaré (déjà arrêté, ou lancé par PAIZ).');
  spawnSync('taskkill', ['/PID', String(cur.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  return cur;
}
