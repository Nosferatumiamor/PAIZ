// Bouton « ▶ Lancer » de l'écran Travail : exécute un script écrit par le modèle (Python, Node) dans son dossier de projet, sur clic de l'utilisateur.
// Garde-fous : le fichier doit exister et se trouver dans un projet connu (jamais hors projet, jamais dans un dossier protégé) ; extension limitée ;
// pas de shell (arguments passés tels quels) ; une seule instance par fichier ; arrêt possible ; les erreurs de démarrage sont renvoyées.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertProjectAllowed } from './guard.js';
import { listProjects } from './projects.js';

const norm = (p) => path.resolve(p).toLowerCase();
const RUNNERS = {
  '.py': () => (process.platform === 'win32' ? [['python'], ['py', '-3']] : [['python3'], ['python']]),
  '.pyw': () => (process.platform === 'win32' ? [['pythonw'], ['pyw', '-3']] : [['python3']]),
  '.js': () => [['node']], '.mjs': () => [['node']], '.cjs': () => [['node']],
};
const runs = new Map(); // chemin normalisé -> { proc, startedAt }

export const isRunnable = (file) => Object.hasOwn(RUNNERS, path.extname(String(file)).toLowerCase());

function projectOf(db, file) {
  const f = norm(file);
  return listProjects(db).projects.map((p) => p.dir).find((d) => f.startsWith(norm(d) + path.sep));
}

// Retourne { running: true, pid } si le programme tourne encore après un court délai, { exited, code, output } s'il s'est arrêté (erreur ou fin rapide).
export async function runScript(db, { file, dir }) {
  const abs = path.resolve(dir && !path.isAbsolute(file) ? path.join(dir, file) : file);
  if (!isRunnable(abs)) throw new Error('Seuls les scripts Python (.py) et Node (.js, .mjs) se lancent d\'ici.');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('Fichier introuvable.');
  const proj = projectOf(db, abs);
  if (!proj) throw new Error('Ce fichier n\'est dans aucun projet connu de PAIZ : il ne sera pas lancé.');
  assertProjectAllowed(db, proj);
  const key = norm(abs);
  const old = runs.get(key); if (old && old.proc.exitCode === null) throw new Error('Ce programme tourne déjà (■ Arrêter pour le fermer).');
  const ext = path.extname(abs).toLowerCase();
  let lastErr = null;
  for (const cmd of RUNNERS[ext]()) {
    const out = [];
    const proc = spawn(cmd[0], [...cmd.slice(1), abs], { cwd: path.dirname(abs), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const done = new Promise((resolve) => {
      proc.once('error', (e) => resolve({ spawnError: e }));
      proc.once('exit', (code) => resolve({ code }));
    });
    const grab = (b) => { out.push(String(b)); if (out.join('').length > 8000) out.splice(0, out.length - 20); };
    proc.stdout.on('data', grab); proc.stderr.on('data', grab);
    const r = await Promise.race([done, new Promise((res) => setTimeout(() => res({ still: true }), 2500))]);
    if (r.spawnError) { lastErr = r.spawnError; continue; } // interpréteur absent : on essaie le suivant
    if (r.still) { runs.set(key, { proc, startedAt: Date.now() }); proc.once('exit', () => { if (runs.get(key)?.proc === proc) runs.delete(key); }); return { running: true, pid: proc.pid, file: abs }; }
    const text = out.join('').trim().slice(-3000);
    const hint = /No module named ['"]?(\w+)/.exec(text); // ex. pygame absent
    return { running: false, exited: true, code: r.code, output: text, hint: hint ? `Module Python manquant : ${hint[1]}. Installe-le (pip install ${hint[1]}) puis relance.` : null, file: abs };
  }
  throw new Error(`Interpréteur introuvable (${RUNNERS[ext]()[0][0]}) : ${lastErr?.message || 'installe-le et ajoute-le au PATH'}.`);
}

export function stopScript(file) {
  const r = runs.get(norm(file)); if (!r || r.proc.exitCode !== null) { runs.delete(norm(file)); return { stopped: false, gone: true }; }
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(r.proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else r.proc.kill();
  runs.delete(norm(file)); return { stopped: true };
}
export const runningFiles = () => [...runs.entries()].filter(([, r]) => r.proc.exitCode === null).map(([k]) => k);
process.on('exit', () => { for (const r of runs.values()) { try { if (process.platform === 'win32') spawn('taskkill', ['/PID', String(r.proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else r.proc.kill(); } catch { /* déjà arrêté */ } } });
