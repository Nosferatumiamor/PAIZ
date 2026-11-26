// Discovery of the volumes to scan, plus well-known model cache folders.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { isSubPath, pathExists } from './util.js';

const execFileAsync = promisify(execFile);
const EXEC_OPTS = { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 };

async function windowsVolumes(includeRemovable) {
  const filter = includeRemovable ? 'DriveType=2 OR DriveType=3' : 'DriveType=3';
  const script = `Get-CimInstance Win32_LogicalDisk -Filter "${filter}" | Select-Object -ExpandProperty DeviceID`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], EXEC_OPTS);
    return stdout.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[a-z]:$/i.test(line))
      .map((line) => `${line.slice(0, 2).toUpperCase()}\\`);
  } catch {
    return [];
  }
}

async function unixVolumes() {
  try {
    const { stdout } = await execFileAsync('df', ['-P', '-l'], EXEC_OPTS);
    const mounts = [];
    for (const line of stdout.split(/\r?\n/).slice(1)) {
      const match = line.match(/^\S+\s+\d+\s+\d+\s+\d+\s+\d+%\s+(.+)$/);
      if (!match) continue;
      const mount = match[1].trim();
      if (!mount.startsWith('/')) continue;
      if (/^\/(proc|sys|dev|run|snap|boot\/efi|System\/Volumes)(\/|$)/.test(mount)) continue;
      mounts.push(mount);
    }
    return mounts;
  } catch {
    return ['/'];
  }
}

function dedupeNested(paths) {
  const out = [];
  for (const candidate of [...new Set(paths)].sort((a, b) => a.length - b.length)) {
    if (!out.some((parent) => isSubPath(parent, candidate))) out.push(candidate);
  }
  return out;
}

/**
 * Local disks only. Removable disks are included by default, network shares are not.
 * On Windows, drive enumeration goes through PowerShell (Win32_LogicalDisk).
 */
export async function listLocalVolumes({ includeRemovable = true } = {}) {
  const volumes = process.platform === 'win32'
    ? await windowsVolumes(includeRemovable)
    : await unixVolumes();
  return dedupeNested(volumes);
}

/**
 * Caches that the normal walker intentionally skips (because `.cache` is noisy),
 * but which commonly contain real model weights.
 */
export function knownModelCacheDirs() {
  const home = os.homedir();
  const dirs = [
    process.env.HF_HOME,
    process.env.HUGGINGFACE_HUB_CACHE,
    path.join(home, '.cache', 'huggingface'),
    path.join(home, '.cache', 'lm-studio'),
    path.join(home, '.cache', 'modelscope'),
    path.join(home, '.cache', 'diffusers'),
    path.join(home, '.cache', 'torch', 'hub'),
  ].filter(Boolean);
  return [...new Set(dirs)];
}

export async function listScanTargets({ includeRemovable = true, includeCaches = true } = {}) {
  const volumes = await listLocalVolumes({ includeRemovable });
  const caches = [];
  if (includeCaches) {
    for (const dir of knownModelCacheDirs()) {
      if (await pathExists(dir)) caches.push(dir);
    }
  }
  return [
    ...volumes.map((p) => ({ path: p, kind: 'volume' })),
    ...caches.map((p) => ({ path: p, kind: 'cache' })),
  ];
}
