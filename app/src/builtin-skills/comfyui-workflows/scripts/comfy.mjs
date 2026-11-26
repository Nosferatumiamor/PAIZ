// Outils ComfyUI pour le skill comfyui-workflows : nodes, models, list, check, queue, free. Node 18+, aucune dépendance.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const hi = args.indexOf('--host');
const HOST = (hi >= 0 ? args.splice(hi, 2)[1] : 'http://127.0.0.1:8188').replace(/\/+$/, '');
const [cmd, arg] = args;
const NODES_FILE = 'comfy-nodes.json';

const get = async (p) => { const r = await fetch(HOST + p, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`${p} : ${r.status}`); return r.json(); };
const fail = (m) => { console.error(m); process.exit(1); };
const needServer = (e) => fail(`ComfyUI ne répond pas sur ${HOST} (${e.message}). Lance-le (même avec --cpu) ou donne --host.`);

// type d'une entrée : "MODEL", "INT"… ou liste de choix (combo)
function inputKind(spec) {
  const t = Array.isArray(spec) ? spec[0] : spec;
  if (Array.isArray(t)) return { combo: t };
  if (t === 'COMBO') return { combo: spec[1]?.options || [] };
  return { type: t };
}

async function main() {
  if (cmd === 'nodes') {
    let info; try { info = await get('/object_info'); } catch (e) { needServer(e); }
    fs.writeFileSync(NODES_FILE, JSON.stringify(info));
    console.log(`${Object.keys(info).length} nodes écrits dans ${path.resolve(NODES_FILE)}`);
    for (const [name, n] of Object.entries(info)) {
      const ins = Object.entries(n.input?.required || {}).map(([k, v]) => `${k}:${inputKind(v).type || 'choix'}`).join(', ');
      console.log(`${name} (${ins}) -> ${(n.output || []).join(', ') || '-'}`);
    }
  } else if (cmd === 'models') {
    let folders; try { folders = await get('/models'); } catch (e) { needServer(e); }
    for (const f of folders.filter((x) => !/^(configs|custom_nodes)$/.test(x))) { try { const l = await get(`/models/${f}`); if (l.length) console.log(`${f}: ${l.join(', ')}`); } catch { /* dossier absent */ } }
  } else if (cmd === 'list') {
    const d = path.join(arg || '.', 'user', 'default', 'workflows');
    if (!fs.existsSync(d)) fail(`Introuvable : ${d} (donne le dossier d'installation de ComfyUI).`);
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) console.log(path.join(d, f));
  } else if (cmd === 'check') {
    if (!arg) fail('Usage : comfy.mjs check workflow.json');
    let wf; try { wf = JSON.parse(fs.readFileSync(arg, 'utf8')); } catch (e) { fail(`JSON illisible : ${e.message}`); }
    if (Array.isArray(wf.nodes) || Array.isArray(wf.links)) fail('Format éditeur (nodes/links) : réécris-le au format API (clés = ids, avec class_type et inputs).');
    let info = null; try { info = JSON.parse(fs.readFileSync(NODES_FILE, 'utf8')); } catch { console.log(`(pas de ${NODES_FILE} : types et noms de nodes non vérifiés ; lance « comfy.mjs nodes »)`); }
    const errs = [];
    for (const [id, n] of Object.entries(wf)) {
      if (!n || typeof n !== 'object' || typeof n.class_type !== 'string' || typeof n.inputs !== 'object') { errs.push(`node ${id} : class_type ou inputs manquant`); continue; }
      const def = info?.[n.class_type];
      if (info && !def) { errs.push(`node ${id} : « ${n.class_type} » n'existe pas dans ce ComfyUI`); continue; }
      const all = { ...(def?.input?.required || {}), ...(def?.input?.optional || {}) };
      for (const k of Object.keys(def?.input?.required || {})) if (!(k in n.inputs)) errs.push(`node ${id} (${n.class_type}) : entrée « ${k} » manquante`);
      for (const [k, v] of Object.entries(n.inputs)) {
        if (def && !(k in all)) { errs.push(`node ${id} (${n.class_type}) : entrée « ${k} » inconnue`); continue; }
        if (Array.isArray(v)) {
          const [src, idx] = v; const s = wf[String(src)];
          if (!s) { errs.push(`node ${id}.${k} : pointe vers le node ${src} qui n'existe pas`); continue; }
          const sdef = info?.[s.class_type]; if (!sdef) continue;
          const out = sdef.output?.[idx];
          if (out === undefined) { errs.push(`node ${id}.${k} : le node ${src} (${s.class_type}) n'a pas de sortie ${idx}`); continue; }
          const want = inputKind(all[k] ?? []).type;
          if (want && want !== '*' && out !== '*' && want !== out) errs.push(`node ${id}.${k} : attend ${want}, reçoit ${out} (node ${src} sortie ${idx})`);
        } else if (def && k in all) {
          const kind = inputKind(all[k]);
          if (kind.combo && !kind.combo.includes(v)) errs.push(`node ${id}.${k} : « ${v} » absent des choix (${kind.combo.slice(0, 8).join(', ')}${kind.combo.length > 8 ? '…' : ''})`);
        }
      }
    }
    if (errs.length) { console.log(errs.map((e) => `ERREUR ${e}`).join('\n')); process.exit(2); }
    console.log(`OK : ${Object.keys(wf).length} nodes${info ? ', types et choix vérifiés' : ''}.`);
  } else if (cmd === 'queue') {
    if (!arg) fail('Usage : comfy.mjs queue workflow.json');
    const prompt = JSON.parse(fs.readFileSync(arg, 'utf8'));
    let r; try { r = await fetch(`${HOST}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) }); } catch (e) { needServer(e); }
    console.log(r.status, (await r.text()).slice(0, 600));
  } else if (cmd === 'free') {
    let r; try { r = await fetch(`${HOST}/free`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) }); } catch (e) { needServer(e); }
    console.log(r.status === 200 ? 'ComfyUI a libéré ses modèles.' : `Réponse ${r.status}`);
  } else fail('Commandes : nodes | models | list <dossier ComfyUI> | check <fichier> | queue <fichier> | free   (option : --host http://127.0.0.1:8188)');
}
main().catch((e) => fail(e.message));
