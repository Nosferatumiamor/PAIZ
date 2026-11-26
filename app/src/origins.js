// Traçage des modèles : d'où un modèle est parti quand il a quitté un repo actif (pour le remettre EXACTEMENT là), et de quels fichiers il a besoin
// (mmproj, VAE, encodeurs texte…). Stocké dans les réglages (JSON) ; la clé d'un modèle est « nom de fichier | taille » : elle survit aux déplacements.
import { getSetting, setSetting } from './db.js';

const OKEY = 'engine.origins';
const NKEY = 'engine.needs';
export const modelKey = (a) => `${String(a.file_name).toLowerCase()}|${a.size_bytes}`;
const read = (db, key) => { try { const o = JSON.parse(getSetting(db, key, '{}')); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const write = (db, key, o) => setSetting(db, key, JSON.stringify(o));

export const getOrigin = (db, a) => read(db, OKEY)[modelKey(a)] || null;
export function setOrigin(db, a, origin) { const o = read(db, OKEY); o[modelKey(a)] = origin; write(db, OKEY, o); }
export function clearOrigin(db, a) { const o = read(db, OKEY); if (delete o[modelKey(a)]) write(db, OKEY, o); }
export const allOrigins = (db) => read(db, OKEY);

// appelé après chaque déplacement réussi : un modèle qui QUITTE un repo actif garde son adresse d'origine ; qui y REVIENT l'efface
export function noteMove(db, asset, srcRoot, destRoot) {
  if (destRoot?.role === 'active') clearOrigin(db, asset);
  else if (srcRoot?.role === 'active') setOrigin(db, asset, { path: asset.abs_path, rootId: srcRoot.id, rootName: srcRoot.name, rootPath: srcRoot.path, at: new Date().toISOString() });
}

// besoins connus d'un modèle : [{ file_name, size_bytes, role }]
export const getNeeds = (db, a) => read(db, NKEY)[modelKey(a)] || [];
export function setNeeds(db, a, list) { const o = read(db, NKEY); if (list.length) o[modelKey(a)] = list; else delete o[modelKey(a)]; write(db, NKEY, o); }
