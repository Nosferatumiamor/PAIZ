// Stage everything the Tauri bundle needs under src-tauri/resources:
//   resources/app/      → src/, public/, package.json (zero npm deps)
//   resources/node.exe  → a copy of the Node runtime running this script
//
// Run before `tauri build` / `tauri dev`. The produced folder is gitignored.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TAURI_DIR = path.join(ROOT, 'src-tauri');
const RES_DIR = path.join(TAURI_DIR, 'resources');
const APP_DIR = path.join(RES_DIR, 'app');
const NODE_SRC = process.env.PAIZ_NODE || process.execPath;
const NODE_DEST = path.join(RES_DIR, 'node.exe');

function fail(message) {
  console.error(`\n  ✖ ${message}\n`);
  process.exit(1);
}

if (!fs.existsSync(path.join(ROOT, 'ui', 'index.html'))) {
  fail('ui/index.html manquant : la page de démarrage Tauri est requise.');
}
if (!fs.existsSync(NODE_SRC)) {
  fail(`Runtime Node introuvable : ${NODE_SRC}`);
}

console.log('\n  Préparation des ressources Tauri…');

fs.rmSync(APP_DIR, { recursive: true, force: true });
fs.mkdirSync(APP_DIR, { recursive: true });

for (const name of ['src', 'public']) {
  const from = path.join(ROOT, name);
  if (!fs.existsSync(from)) fail(`Dossier manquant : ${from}`);
  fs.cpSync(from, path.join(APP_DIR, name), { recursive: true });
  console.log(`  ✔ ${name}/`);
}

fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(APP_DIR, 'package.json'));
console.log('  ✔ package.json');

fs.rmSync(NODE_DEST, { force: true });
fs.copyFileSync(NODE_SRC, NODE_DEST);
const nodeMb = (fs.statSync(NODE_DEST).size / 1024 / 1024).toFixed(1);
console.log(`  ✔ node.exe (${nodeMb} Mo) depuis ${NODE_SRC}`);

// Moteur (installeur seulement : option --engine). Copie les binaires compilés (engine/build-llama/bin, sans les données ni les
// outils de mesure) et le runtime CUDA redistribuable (cudart, cuBLAS) : l'utilisateur n'a besoin que du pilote NVIDIA.
// Sans --engine (build de l'exe pour le développement), un dossier vide suffit : l'exe trouve alors le moteur du dépôt.
const ENGINE_DEST = path.join(RES_DIR, 'engine', 'build-llama', 'bin');
fs.rmSync(path.join(RES_DIR, 'engine'), { recursive: true, force: true });
fs.mkdirSync(ENGINE_DEST, { recursive: true });
if (process.argv.includes('--engine')) {
  const ENGINE_SRC = path.resolve(ROOT, '..', 'engine', 'build-llama', 'bin');
  if (!fs.existsSync(path.join(ENGINE_SRC, 'ws_npc_server.exe'))) fail(`Moteur non compilé : ${ENGINE_SRC} (voir engine/README.md)`);
  const KEEP = /^(ws_npc_server|llama-server|llama-quantize|llama-gguf-split)\.exe$|\.dll$/i;
  let bytes = 0;
  for (const f of fs.readdirSync(ENGINE_SRC)) {
    const src = path.join(ENGINE_SRC, f);
    if (!fs.statSync(src).isFile() || !KEEP.test(f) || /bench|perplexity|cli-impl/i.test(f)) continue;
    fs.copyFileSync(src, path.join(ENGINE_DEST, f)); bytes += fs.statSync(src).size;
  }
  const cudaBin = process.env.CUDA_PATH ? path.join(process.env.CUDA_PATH, 'bin') : 'C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v12.3/bin';
  for (const f of fs.existsSync(cudaBin) ? fs.readdirSync(cudaBin) : []) {
    if (!/^(cudart64_12|cublas64_12|cublasLt64_12)\.dll$/i.test(f)) continue;
    fs.copyFileSync(path.join(cudaBin, f), path.join(ENGINE_DEST, f)); bytes += fs.statSync(path.join(cudaBin, f)).size;
  }
  if (!fs.existsSync(path.join(ENGINE_DEST, 'cudart64_12.dll'))) fail(`Runtime CUDA introuvable dans ${cudaBin} (variable CUDA_PATH)`);
  console.log(`  ✔ engine/ (${(bytes / 1024 / 1024).toFixed(0)} Mo, moteur + runtime CUDA)`);
} else {
  fs.writeFileSync(path.join(ENGINE_DEST, 'LISEZ-MOI.txt'), "Vide hors installeur : le moteur du depot est utilise (npm run tauri:installer pour l'embarquer).");
}

if (!fs.existsSync(path.join(TAURI_DIR, 'icons', 'icon.ico'))) {
  console.warn('\n  ! src-tauri/icons/icon.ico manquant — lance `npm run tauri:icon` avant de builder.');
}

console.log(`\n  Ressources prêtes : ${RES_DIR}\n`);
