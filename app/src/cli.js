#!/usr/bin/env node
// PAIZ — command line interface (zero dependency).
import { spawn } from 'node:child_process';
import { APP_NAME, APP_VERSION, humanBytes, normalizeDir, pathExists } from './util.js';
import { DATA_DIR, DEFAULT_PORT } from './config.js';
import {
  addRoot, duplicateGroups, getAsset, getRoot, listRoots, openDb, queryAssets, removeRoot, stats,
} from './db.js';
import { CATEGORIES, baseLabel } from './detect.js';
import { scanPath } from './scanner.js';
import {
  startHashJob, startLinkJob, startRestoreJob, startTrashJob, startTransferJob,
} from './jobs.js';
import { startServer, printHelp } from './server.js';

const color = process.env.NO_COLOR || !process.stdout.isTTY
  ? { dim: (s) => s, bold: (s) => s, green: (s) => s, yellow: (s) => s, red: (s) => s, cyan: (s) => s }
  : {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    };

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    } else if (arg === '-h') {
      flags.help = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function pad(value, width) {
  const s = String(value ?? '');
  return s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s.padEnd(width);
}

function printTable(rows, columns) {
  if (!rows.length) { console.log(color.dim('  (vide)')); return; }
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.value(r) ?? '').length)));
  console.log('  ' + columns.map((c, i) => color.bold(pad(c.label, Math.min(widths[i], c.max || 80)))).join('  '));
  for (const row of rows) {
    console.log('  ' + columns.map((c, i) => pad(c.value(row), Math.min(widths[i], c.max || 80))).join('  '));
  }
}

function resolveAsset(db, term) {
  if (!term) return null;
  if (/^\d+$/.test(String(term))) return getAsset(db, Number(term));
  const byPath = db.prepare('SELECT * FROM assets WHERE abs_path = ? COLLATE NOCASE').get(String(term));
  if (byPath) return getAsset(db, byPath.id);
  const rows = db.prepare('SELECT * FROM assets WHERE file_name = ? COLLATE NOCASE').all(String(term));
  if (rows.length === 1) return getAsset(db, rows[0].id);
  if (rows.length > 1) {
    console.error(color.yellow(`Plusieurs modèles portent ce nom, utilise un id:`));
    for (const r of rows) console.log(`  #${r.id}  ${r.abs_path}`);
    return null;
  }
  const likes = db.prepare("SELECT * FROM assets WHERE file_name LIKE ? OR title LIKE ? LIMIT 10").all(`%${term}%`, `%${term}%`);
  if (likes.length === 1) return getAsset(db, likes[0].id);
  if (likes.length > 1) {
    console.error(color.yellow('Correspondances multiples:'));
    for (const r of likes) console.log(`  #${r.id}  ${r.file_name}  ${color.dim(r.abs_path)}`);
    return null;
  }
  return null;
}

function requireAsset(db, term) {
  const asset = resolveAsset(db, term);
  if (!asset) {
    console.error(color.red(`Modèle introuvable: ${term}`));
    process.exitCode = 1;
  }
  return asset;
}

async function waitJob(job, { silent = false } = {}) {
  let lastLine = '';
  while (job.status === 'running') {
    if (!silent) {
      const p = job.progress;
      let line;
      if (p.totalBytes > 0) {
        line = `${p.phase} ${p.done}/${p.total || '?'}  ${humanBytes(p.bytes)} / ${humanBytes(p.totalBytes)}  ${p.current || ''}`;
      } else {
        line = `${p.phase} ${p.done}/${p.total || '?'}  ${p.current || ''}`;
      }
      line = line.slice(0, 110);
      if (line !== lastLine) {
        process.stdout.write(`\r  ${line.padEnd(112)}`);
        lastLine = line;
      }
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  if (!silent && lastLine) process.stdout.write(`\r${' '.repeat(114)}\r`);
  if (job.status === 'done') {
    console.log(color.green('  ✔ ') + job.label);
    if (!silent) console.log(color.dim('  ' + JSON.stringify(job.result)));
  } else {
    console.error(color.red(`  ✖ ${job.error || job.status}`));
    process.exitCode = 1;
  }
  return job;
}

async function cmdScan(db, args, flags) {
  const term = args[0];
  let targets = [];
  if (term) {
    const root = getRoot(db, term);
    if (root) targets.push({ dir: root.path, rootId: root.id, label: root.name });
    else targets.push({ dir: normalizeDir(term), rootId: null, label: term });
  } else {
    for (const root of listRoots(db)) targets.push({ dir: root.path, rootId: root.id, label: root.name });
  }
  if (!targets.length) {
    console.log(color.yellow('Aucune racine configurée. Utilise: paiz add-root <nom> <chemin>'));
    return;
  }
  for (const target of targets) {
    if (!(await pathExists(target.dir))) {
      console.log(color.yellow(`  ! ${target.label}: chemin introuvable (disque débranché ?) — ignoré`));
      continue;
    }
    console.log(color.bold(`\n  Scan ${target.label} — ${target.dir}`));
    let lastTick = 0;
    try {
      const res = await scanPath(db, {
        dir: target.dir,
        rootId: target.rootId,
        force: flags.force === true,
        minBytes: flags['min-size'] ? Number(flags['min-size']) : null,
        onProgress: (p) => {
          if (p.phase === 'walk') {
            if (Date.now() - lastTick > 500) {
              lastTick = Date.now();
              process.stdout.write(`\r  Analyse… ${p.found} fichier(s) trouvé(s)`);
            }
          } else {
            process.stdout.write(`\r  Indexation… ${p.processed}/${p.found}`);
          }
        },
      });
      process.stdout.write('\r' + ' '.repeat(90) + '\r');
      console.log(`  ${color.green('✔')} ${res.total} modèle(s) — ${res.added} ajouté(s), ${res.updated} mis à jour, ${res.unchanged} inchangé(s), ${humanBytes(res.bytes)}`);
      if (res.errors.length) console.log(color.yellow(`  ${res.errors.length} erreur(s) d'accès`));
      if (flags.json) console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error(color.red(`  ✖ ${err.message}`));
      process.exitCode = 1;
    }
  }
}

function cmdList(db, args, flags) {
  const res = queryAssets(db, {
    q: args[0] || flags.q || '',
    category: flags.category || 'all',
    base: flags.base || 'all',
    rootId: flags.root || 'all',
    state: flags.state || 'present',
    unmanaged: flags.unmanaged === true,
    sort: flags.sort || 'size',
    dir: flags.dir || 'desc',
    limit: Number(flags.limit || 100),
  });
  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(color.dim(`  ${res.total} modèle(s), ${humanBytes(res.items.reduce((s, i) => s + i.size_bytes, 0))} affichés\n`));
  printTable(res.items, [
    { label: 'ID', value: (r) => `#${r.id}`, max: 7 },
    { label: 'CAT', value: (r) => r.category, max: 12 },
    { label: 'BASE', value: (r) => r.base_model || '—', max: 12 },
    { label: 'TAILLE', value: (r) => humanBytes(r.size_bytes), max: 10 },
    { label: 'NOM', value: (r) => r.title || r.file_name, max: 44 },
    { label: 'EMPLACEMENT', value: (r) => r.abs_path, max: 70 },
    { label: 'ÉTAT', value: (r) => (r.state === 'missing' ? 'absent' : r.managed ? '' : 'non géré') },
  ]);
}

async function cmdDisks(db) {
  const roots = listRoots(db);
  if (!roots.length) { console.log(color.dim('  (aucune racine)')); return; }
  const rows = [];
  for (const root of roots) {
    let free = null; let total = null;
    if (await pathExists(root.path)) {
      try {
        const st = await (await import('node:fs/promises')).statfs(root.path);
        free = Number(st.bavail) * Number(st.bsize);
        total = Number(st.blocks) * Number(st.bsize);
      } catch { /* ignore */ }
    }
    const agg = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(size_bytes),0) b FROM assets WHERE root_id = ? AND state = 'present'").get(root.id);
    rows.push({ ...root, free, total, count: agg.n, bytes: agg.b });
  }
  printTable(rows, [
    { label: 'RACINE', value: (r) => r.name, max: 24 },
    { label: 'RÔLE', value: (r) => r.role, max: 10 },
    { label: 'DISQUE', value: (r) => r.volume || '—', max: 8 },
    { label: 'LIBRE', value: (r) => (r.free == null ? 'hors ligne' : humanBytes(r.free)), max: 12 },
    { label: 'TOTAL', value: (r) => (r.total == null ? '—' : humanBytes(r.total)), max: 12 },
    { label: 'MODÈLES', value: (r) => r.count, max: 8 },
    { label: 'POIDS', value: (r) => humanBytes(r.bytes), max: 10 },
    { label: 'CHEMIN', value: (r) => r.path, max: 60 },
  ]);
}

function cmdDups(db) {
  const groups = duplicateGroups(db);
  if (!groups.length) { console.log(color.green('  Aucun doublon détecté.')); return; }
  let wasted = 0;
  for (const g of groups) {
    wasted += g.wasted - g.size;
    console.log(color.bold(`\n  ${g.items[0].file_name}  —  ${humanBytes(g.size)} × ${g.count}`));
    for (const item of g.items) {
      console.log(`    #${String(item.id).padEnd(5)} ${humanBytes(item.size_bytes).padStart(9)}  ${item.managed ? '' : color.yellow('[non géré] ')}${item.abs_path}`);
    }
  }
  console.log(color.yellow(`\n  Espace récupérable: ${humanBytes(wasted)}`));
}

function cmdStats(db) {
  const s = stats(db);
  console.log(color.bold(`\n  ${s.totals.count} modèles — ${humanBytes(s.totals.bytes)}\n`));
  console.log(color.bold('  Par catégorie'));
  for (const row of s.byCategory) {
    console.log(`    ${pad(CATEGORIES.find((c) => c.id === row.category)?.short || row.category, 16)} ${String(row.count).padStart(5)}  ${humanBytes(row.bytes).padStart(10)}`);
  }
  if (s.byBase.length) {
    console.log(color.bold('\n  Par base'));
    for (const row of s.byBase) {
      console.log(`    ${pad(baseLabel(row.base_model) || row.base_model, 16)} ${String(row.count).padStart(5)}  ${humanBytes(row.bytes).padStart(10)}`);
    }
  }
  console.log(color.dim(`\n  Non gérés: ${s.unmanaged} · Absents: ${s.missing} · Groupes de doublons: ${s.duplicateGroups}`));
}

async function cmdMove(db, args, flags) {
  const asset = requireAsset(db, args[0]);
  if (!asset) return;
  if (!flags.to) { console.error(color.red('Indique la destination: --to <nom-de-racine>')); process.exitCode = 1; return; }
  const root = getRoot(db, flags.to);
  if (!root) { console.error(color.red(`Racine inconnue: ${flags.to}`)); process.exitCode = 1; return; }
  console.log(`  ${asset.file_name}  ${humanBytes(asset.size_bytes)}  →  ${root.name} (${root.path})`);
  const job = startTransferJob(db, { assetId: asset.id, toRoot: root.id, mode: flags.copy ? 'copy' : 'move' });
  await waitJob(job);
}

async function cmdLink(db, args, flags) {
  const asset = requireAsset(db, args[0]);
  if (!asset) return;
  const linkPath = args[1];
  if (!linkPath) { console.error(color.red('Usage: paiz link <id> <chemin-du-lien> [--hard]')); process.exitCode = 1; return; }
  const job = startLinkJob(db, { assetId: asset.id, linkPath, kind: flags.hard ? 'hardlink' : 'symlink' });
  await waitJob(job);
}

async function cmdTrash(db, args) {
  const ids = [];
  for (const term of args) {
    const asset = requireAsset(db, term);
    if (asset) ids.push(asset.id);
  }
  if (!ids.length) return;
  const job = startTrashJob(db, { assetIds: ids });
  await waitJob(job);
}

async function cmdRestore(db, args) {
  const ids = [];
  for (const term of args) {
    const asset = requireAsset(db, term);
    if (asset) ids.push(asset.id);
  }
  if (!ids.length) return;
  const job = startRestoreJob(db, { assetIds: ids });
  await waitJob(job);
}

async function cmdHash(db, args, flags) {
  const ids = [];
  for (const term of args) {
    const asset = requireAsset(db, term);
    if (asset) ids.push(asset.id);
  }
  if (!ids.length) return;
  const job = startHashJob(db, { assetIds: ids, full: !flags.quick });
  await waitJob(job);
}

function cmdAddRoot(db, args, flags) {
  const [name, target] = args;
  if (!name || !target) { console.error(color.red('Usage: paiz add-root <nom> <chemin> [--role store|active|external]')); process.exitCode = 1; return; }
  const root = addRoot(db, { name, path: normalizeDir(target), role: flags.role || 'store' });
  console.log(color.green(`  ✔ Racine "${root.name}" → ${root.path} (${root.role})`));
}

function cmdRoots(db) {
  const rows = listRoots(db).map((r) => {
    const agg = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(size_bytes),0) b FROM assets WHERE root_id = ? AND state = 'present'").get(r.id);
    return { ...r, count: agg.n, bytes: agg.b };
  });
  printTable(rows, [
    { label: 'ID', value: (r) => `#${r.id}`, max: 6 },
    { label: 'NOM', value: (r) => r.name, max: 24 },
    { label: 'RÔLE', value: (r) => r.role, max: 10 },
    { label: 'DISQUE', value: (r) => r.volume || '—', max: 8 },
    { label: 'MODÈLES', value: (r) => r.count, max: 8 },
    { label: 'POIDS', value: (r) => humanBytes(r.bytes), max: 10 },
    { label: 'CHEMIN', value: (r) => r.path, max: 70 },
  ]);
}

function openFolder(dir) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', dir], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
    console.log(color.dim(`  ${dir}`));
  } catch { console.log(dir); }
}

// Mode serveur sans interface : PAIZ sert d'API OpenAI locale à OpenCode, Continue, SillyTavern…
async function headlessBanner(db, url, flags) {
  const { summon, summonState, engineStatus } = await import('./engine.js');
  const line = (k, v) => console.log(`  ${color.dim(k.padEnd(10))} ${v}`);
  console.log(`\n  ${color.green(`${APP_NAME} v${APP_VERSION}`)} — serveur sans interface`);
  line('API', color.green(`${url}/v1`) + color.dim('   (compatible OpenAI ; clé : n’importe laquelle)'));
  line('Interface', `${url}  ${color.dim('(facultative)')}`);
  line('Données', DATA_DIR);
  if (flags.model) {
    const asset = resolveAsset(db, String(flags.model));
    if (!asset) { console.error(color.red(`\n  Modèle introuvable : ${flags.model}. Liste : paiz list --category llm`)); return; }
    line('Modèle', `${asset.file_name}${flags.mode ? ` · mode ${flags.mode}` : ''}`);
    summon(db, { assetId: asset.id, profile: flags.mode ? String(flags.mode) : undefined });
    let last = '';
    while (!['done', 'error'].includes(summonState.step)) {
      if (summonState.message !== last) { last = summonState.message; console.log(color.dim(`  … ${last}`)); }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (summonState.step === 'error') console.error(color.red(`  ✖ ${summonState.error}`));
    else console.log(color.green('  ✔ Modèle chargé.'));
  } else {
    let st = null; try { st = await engineStatus(db); } catch { /* moteur absent */ }
    line('Modèle', st?.current ? st.current.path : color.dim('aucun pour l’instant (le dernier utilisé se recharge s’il est réglé ainsi ; sinon --model <nom>)'));
  }
  console.log(color.dim(`\n  OpenCode : base URL ${url}/v1 · Ctrl+C pour arrêter.\n`));
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const cmd = positional.shift();

  if (!cmd || cmd === 'help' || flags.help) { printHelp(); return; }
  if (cmd === 'version' || cmd === '--version') { console.log(`${APP_NAME} v${APP_VERSION}`); return; }

  const db = openDb();

  switch (cmd) {
    case 'init':
      console.log(color.green(`  ✔ Base initialisée: ${DATA_DIR}`));
      console.log(color.dim('  Prochaine étape: paiz add-root archive D:\\IA\\Models'));
      break;
    case 'serve': {
      const headless = Boolean(flags.headless || flags.model);
      const { url, db: sdb } = await startServer({ port: Number(flags.port || DEFAULT_PORT), open: !flags['no-open'] && !headless, autoload: !flags.model, quiet: headless || flags.json });
      if (flags.json) { console.log(JSON.stringify({ url, api: `${url}/v1` })); break; }
      if (headless) await headlessBanner(sdb, url, flags);
      break;
    }
    case 'find-roots': {
      const { findRepos } = await import('./repomark.js');
      const r = await findRepos(db);
      for (const f of r.found) console.log(`  ${f.status === 'in-place' ? color.dim('ok      ') : color.green(f.status.padEnd(8))} ${f.role === 'active' ? 'Ready  ' : 'Reserve'}  ${f.path}${f.from ? color.dim(`  (avant : ${f.from})`) : ''}`);
      for (const m of r.missing) console.log(`  ${color.red('absent  ')} ${m.role === 'active' ? 'Ready  ' : 'Reserve'}  ${m.path}`);
      if (!r.found.length && !r.missing.length) console.log(color.dim('  Aucun dossier PAIZ trouvé.'));
      break;
    }
    case 'add-root': cmdAddRoot(db, positional, flags); break;
    case 'roots':
      if (flags.json) console.log(JSON.stringify(listRoots(db), null, 2));
      else cmdRoots(db);
      break;
    case 'rm-root': {
      const root = getRoot(db, positional[0]);
      if (!root) { console.error(color.red('Racine introuvable')); process.exitCode = 1; break; }
      db.prepare('UPDATE assets SET managed = 0, root_id = NULL WHERE root_id = ?').run(root.id);
      removeRoot(db, root.id);
      console.log(color.green(`  ✔ Racine "${root.name}" retirée (les fichiers restent sur le disque).`));
      break;
    }
    case 'scan': await cmdScan(db, positional, flags); break;
    case 'list': cmdList(db, positional, flags); break;
    case 'disks': await cmdDisks(db); break;
    case 'dups': cmdDups(db); break;
    case 'stats': cmdStats(db); break;
    case 'move': await cmdMove(db, positional, flags); break;
    case 'link': await cmdLink(db, positional, flags); break;
    case 'trash': await cmdTrash(db, positional); break;
    case 'restore': await cmdRestore(db, positional); break;
    case 'hash': await cmdHash(db, positional, flags); break;
    case 'opencode': {
      const { connectOpencode, opencodeStatus } = await import('./engine.js');
      const r = positional[0] === 'connect' ? await connectOpencode(db) : await opencodeStatus(db);
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'open': openFolder(DATA_DIR); break;
    case 'open-data': openFolder(DATA_DIR); break;
    default:
      console.error(color.red(`Commande inconnue: ${cmd}`));
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(color.red(err?.stack || String(err)));
  process.exit(1);
});
