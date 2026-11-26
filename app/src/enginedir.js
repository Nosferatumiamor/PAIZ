// Où est le moteur (ws_npc_server, llama-server…) ? Dans ce dépôt il vit à côté de l'application : <racine>/engine/.
// On remonte depuis le dossier de l'application (aussi quand c'est l'exe Tauri, dont la copie vit sous src-tauri/target/release/app)
// jusqu'à trouver un dossier « engine » qui contient le projet C++. Variable WS_HOME ou réglage engine.dir : toujours prioritaires (voir engine.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function findEngineDir() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const cand = path.join(dir, 'engine');
    if (fs.existsSync(path.join(cand, 'CMakeLists.txt'))) return cand;
    if (fs.existsSync(path.join(cand, 'build-llama', 'bin', 'ws_npc_server.exe'))) return cand; // moteur embarqué par l'installeur
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  return null;
}
