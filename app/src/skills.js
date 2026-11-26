// Skills (« sets de tools ») : dossiers avec un SKILL.md (nom + description + consignes, parfois des scripts) que le modèle charge à la demande.
// OpenCode ne met dans le prompt que le nom et la description de chaque skill ACTIF ; le reste n'est lu que si le modèle l'ouvre.
// Disposition : <DATA>/skills/on (lu par OpenCode via skills.paths) et <DATA>/skills/off (installés, désactivés). Activer = déplacer le dossier.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';

const BUILTIN_DIR = fileURLToPath(new URL('./builtin-skills/', import.meta.url));

export const SKILLS_ROOT = path.join(DATA_DIR, 'skills');
export const SKILLS_ON = path.join(SKILLS_ROOT, 'on');
export const SKILLS_OFF = path.join(SKILLS_ROOT, 'off');
const WIN = process.platform === 'win32';
const META = '.paiz-skill.json';
const MAX_ZIP = 120 * 1024 * 1024;
const MAX_SKILL = 200 * 1024 * 1024;

export const ensureSkillDirs = () => { fs.mkdirSync(SKILLS_ON, { recursive: true }); fs.mkdirSync(SKILLS_OFF, { recursive: true }); };
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

// En-tête « --- name: … description: … --- » d'un SKILL.md (YAML simplifié : une ligne par clé, ou bloc > / |).
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || '').replace(/^﻿/, ''));
  const out = {}; if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const k = /^([\w-]+):\s*(.*)$/.exec(lines[i]); if (!k) continue;
    let v = k[2].trim();
    if (/^[>|][+-]?$/.test(v)) { v = ''; while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) v += `${lines[++i].trim()} `; }
    out[k[1]] = v.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  return out;
}

function dirSize(d, cap = MAX_SKILL + 1) {
  let n = 0; const st = [d];
  while (st.length && n < cap) {
    const cur = st.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) st.push(p); else { try { n += fs.statSync(p).size; } catch { /* disparu */ } }
    }
  }
  return n;
}
function readMeta(d) { try { return JSON.parse(fs.readFileSync(path.join(d, META), 'utf8')); } catch { return {}; } }

export function listSkills() {
  ensureSkillDirs(); const out = [];
  for (const [base, enabled] of [[SKILLS_ON, true], [SKILLS_OFF, false]]) {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const d = path.join(base, e.name); const f = path.join(d, 'SKILL.md');
      if (!fs.existsSync(f)) continue;
      const fm = parseFrontmatter(fs.readFileSync(f, 'utf8')); const meta = readMeta(d);
      const description = String(fm.description || '');
      out.push({ id: e.name, name: fm.name || e.name, description, enabled, size: dirSize(d), source: meta.source || '', needs: meta.needs || [], tokens: enabled ? Math.round((description.length + (fm.name || e.name).length + 60) / 3.4) : 0 });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
export function setSkillEnabled(id, enabled) {
  ensureSkillDirs(); id = slug(id);
  const from = path.join(enabled ? SKILLS_OFF : SKILLS_ON, id); const to = path.join(enabled ? SKILLS_ON : SKILLS_OFF, id);
  if (!fs.existsSync(from)) { if (fs.existsSync(to)) return; throw new Error('Skill inconnu.'); }
  fs.rmSync(to, { recursive: true, force: true }); fs.renameSync(from, to);
}
export function removeSkill(id) { id = slug(id); for (const b of [SKILLS_ON, SKILLS_OFF]) fs.rmSync(path.join(b, id), { recursive: true, force: true }); }

// « https://github.com/owner/repo[/tree/branche/sous/dossier] » ou « owner/repo »
export function parseGithub(input) {
  const s = String(input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?$/.exec(s);
  if (!m) throw new Error('Adresse GitHub invalide (https://github.com/proprietaire/depot).');
  return { owner: m[1], repo: m[2], branch: m[3] || 'HEAD', sub: (m[4] || '').replace(/^\/+|\/+$/g, '') };
}

function findSkillDirs(root, depth = 0, acc = []) {
  if (fs.existsSync(path.join(root, 'SKILL.md'))) { acc.push(root); return acc; }
  if (depth >= 4) return acc;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isDirectory() && !/^(node_modules|\.git)$/.test(e.name)) findSkillDirs(path.join(root, e.name), depth + 1, acc);
  return acc;
}

// Télécharge l'archive du dépôt, en extrait chaque dossier contenant un SKILL.md, et les range DÉSACTIVÉS.
export async function installFromGithub(input, needs = []) {
  ensureSkillDirs();
  const g = parseGithub(input);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paiz-skill-'));
  try {
    const ref = g.branch === 'HEAD' ? 'HEAD' : `refs/heads/${g.branch}`;
    const r = await fetch(`https://codeload.github.com/${g.owner}/${g.repo}/zip/${ref}`, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(r.status === 404 ? 'Dépôt introuvable (ou privé).' : `GitHub : ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_ZIP) throw new Error('Archive trop grosse (> 120 Mo).');
    const zip = path.join(tmp, 'a.zip'); fs.writeFileSync(zip, buf);
    const ex = path.join(tmp, 'x'); fs.mkdirSync(ex);
    const t = spawnSync(WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', // bsdtar de Windows (le tar de Git Bash lit « C: » comme un hôte)
       ['-xf', zip, '-C', ex], { windowsHide: true, encoding: 'utf8' });
    if (t.status !== 0) throw new Error(`Extraction impossible : ${String(t.stderr || t.error || '').slice(0, 200)}`);
    const base = path.join(ex, fs.readdirSync(ex)[0]);
    const scan = g.sub ? path.join(base, g.sub) : base;
    if (!path.resolve(scan).startsWith(path.resolve(base)) || !fs.existsSync(scan)) throw new Error('Sous-dossier introuvable dans le dépôt.');
    const found = findSkillDirs(scan);
    if (!found.length) throw new Error("Aucun SKILL.md dans ce dépôt : ce n'est pas un skill.");
    const added = [];
    for (const d of found) {
      const fm = parseFrontmatter(fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'));
      const id = slug(fm.name || (d === base ? g.repo : path.basename(d)));
      if (!id) continue;
      if (dirSize(d) > MAX_SKILL) throw new Error(`« ${id} » dépasse 200 Mo.`);
      const was = fs.existsSync(path.join(SKILLS_ON, id));
      removeSkill(id);
      const dest = path.join(was ? SKILLS_ON : SKILLS_OFF, id); // une réinstallation garde l'état actif
      fs.cpSync(d, dest, { recursive: true });
      fs.writeFileSync(path.join(dest, META), JSON.stringify({ source: `https://github.com/${g.owner}/${g.repo}`, needs, installedAt: new Date().toISOString() }));
      added.push(id);
    }
    return added;
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); }
}

// Skills fournis avec PAIZ (src/builtin-skills/<id>) : copiés désactivés, sans téléchargement.
export function installBuiltin(id) {
  ensureSkillDirs(); id = slug(id);
  const src = path.join(BUILTIN_DIR, id);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('Skill fourni inconnu.');
  const was = fs.existsSync(path.join(SKILLS_ON, id));
  removeSkill(id);
  const dest = path.join(was ? SKILLS_ON : SKILLS_OFF, id);
  fs.cpSync(src, dest, { recursive: true });
  fs.writeFileSync(path.join(dest, META), JSON.stringify({ source: `paiz:${id}`, needs: [], installedAt: new Date().toISOString() }));
  return [id];
}

// Logiciels que certains skills attendent (affichés pour info, rien n'est installé).
export function skillPrereqs() {
  const run = (c, a) => { try { const r = spawnSync(c, a, { windowsHide: true, encoding: 'utf8', shell: WIN }); return r.status === 0 ? String(r.stdout || r.stderr).trim().split(/\r?\n/)[0] : ''; } catch { return ''; } };
  const chromePaths = WIN
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap((b) => [path.join(b, 'Google/Chrome/Application/chrome.exe'), path.join(b, 'Microsoft/Edge/Application/msedge.exe')])
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app'];
  const node = run('node', ['--version']);
  return { node, nodeOk: parseInt(node.replace(/^v/, ''), 10) >= 22, python: run(WIN ? 'python' : 'python3', ['--version']), ffmpeg: run('ffmpeg', ['-version']).slice(0, 40), chrome: chromePaths.some((p) => fs.existsSync(p)) };
}

export const SKILLS_CURATED = [
  { id: 'comfyui-workflows', label: 'ComfyUI — écrire des workflows', builtin: true, url: 'paiz:comfyui-workflows', description: "Le modèle écrit des workflows ComfyUI (JSON), les vérifie avec la liste réelle de tes nodes et modèles, puis te les donne à charger. ComfyUI peut rester en veille ou en --cpu : aucun modèle d'image n'est chargé.", needs: ['node22'], note: "Conseil : pour ce travail, un modèle d'environ 15 Go suffit et laisse de la VRAM à ComfyUI (évite de recharger le gros modèle à chaque génération). Fourni avec PAIZ, rien à télécharger." },
  { id: 'cinecode', label: 'CineCode — films en code', url: 'https://github.com/sarpstar/cinecode', description: 'Le modèle écrit un film (scénario, images rendues dans Chrome, son généré) et produit un MP4. Licence MIT.', needs: ['node22', 'python', 'ffmpeg', 'chrome'], note: 'Workflow long, plein de fichiers de référence : un modèle local lent risque de peiner. À essayer sur un petit film.' },
  { id: 'blender-skills', label: 'Blender — 28 skills (modélisation, UV, PBR, rig, animation, export…)', url: 'https://github.com/EL4CTEO/blender-skills', description: "Des workflows Blender 5.x prêts pour un agent : modélisation, UV, matériaux PBR, baking, rigging, animation, géométrie nodes, export (Unity, Unreal, Godot…), contrôle qualité. Chaque skill vient avec des scripts testés. Licence MIT.", needs: ['python'], note: "Il faut Blender 5.2 ou plus installé. Les 28 s'installent désactivés : n'active que blender-core (le point d'entrée) et ceux dont tu as besoin, car chaque skill actif ajoute son nom et sa description au prompt de chaque message." },
  { id: 'superpowers', label: 'Superpowers — méthode de développement (15 skills)', url: 'https://github.com/obra/superpowers', description: "Brainstorming, plans écrits, développement piloté par les tests, débogage méthodique, revue de code, vérification avant de dire « fini ». Pensé pour les agents de code ; tout s'installe désactivé : active seulement ce qui te sert. Licence MIT." },
  { id: 'addy-agent-skills', label: 'Agent Skills d’Addy Osmani — ingénierie (26 skills)', url: 'https://github.com/addyosmani/agent-skills', description: "Bonnes pratiques d'ingénieur : découpage des tâches, sécurité, performance, accessibilité, API, documentation, revue de code, mise en production. Tout s'installe désactivé. Licence MIT." },
  { id: 'inference-optimisation', label: 'Inference optimisation — régler un serveur de modèle local', url: 'https://github.com/sybil-solutions/inference-optimisation-skill', description: "Méthode pour accélérer un serveur de modèle local (llama.cpp, vLLM, SGLang, MLX…) : plafond théorique calculé d'abord, un seul changement à la fois, mesures répétées avec témoins, journal des essais, vérification que le texte ne change pas. Licence MIT.", needs: ['python'], note: "Vise la vitesse ; ses scripts de mesure sont écrits pour Linux (bash, /proc) : sous Windows, seuls bench.py et ceiling.py servent tels quels. N'utilise pas son « chien de garde » mémoire : ce genre de test peut geler la machine." },
  { id: 'anthropic-skills', label: "Skills officiels d'Anthropic", url: 'https://github.com/anthropics/skills', description: "Le pack open source d'Anthropic (documents Word/PDF/PowerPoint/Excel, design, création de skills…). Tout s'installe désactivé : active ceux dont tu as besoin.", needs: ['python'], note: 'Licences variées selon le skill (certains sont « source disponible », pas libres) : regarde le LICENSE de chaque dossier.' },
];
