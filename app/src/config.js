import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const home = process.env.PAIZ_HOME || process.env.MDISP_HOME;
export const DATA_DIR = home ? path.resolve(home) : path.join(ROOT_DIR, '.data');
export const DB_PATH = path.join(DATA_DIR, 'dispenser.db');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const DEFAULT_PORT = Number(process.env.PAIZ_PORT || process.env.MDISP_PORT || 7788);
