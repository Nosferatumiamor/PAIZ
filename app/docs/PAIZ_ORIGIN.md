# ◈ PAIZ

> **PAIZ — the AI models dispenser.** Un catalogue local qui sait **où** sont tes modèles, **combien** ils pèsent, **à quoi** ils servent — et qui t'aide à les **échanger entre disques** sans re-télécharger.

Le problème : ton SSD NVMe est rapide mais petit, tes disques classiques sont gros mais lents. Tu passes ta vie à déplacer des LLM, des checkpoints et des LoRA entre les deux. **PAIZ** garde l'inventaire, et déplace les fichiers à ta place.

Rien n'est centralisé de force : PAIZ peut gérer **plusieurs racines sur plusieurs disques**. Il ne fait que savoir où elles sont.

---

## Ce que ça fait (v0.2)

- **Catalogue multi-disques** : chaque modèle indexé avec son chemin exact, sa taille, sa date, son empreinte et ses métadonnées.
- **Vue groupée à la demande** : clique sur `Catégorie`, `Base` ou `Emplacement` dans l'en-tête du tableau pour regrouper les modèles (groupes triés A→Z), puis reclique pour revenir à la vue plate.
- **Détection automatique** des catégories : checkpoint, LoRA/LyCORIS, ControlNet, VAE, embedding, upscaler, CLIP/T5, IP-Adapter, FaceID, motion, LLM/GGUF, ONNX.
- **Détection des bases** : SD 1.5, SD 2.x, SDXL, Pony, Illustrious, NoobAI, SD 3.x, FLUX, Wan, Hunyuan, Llama, Qwen, Mistral… et **compatibilité LoRA ↔ checkpoint** via la famille.
- **Lecture des en-têtes safetensors et GGUF** sans aucune dépendance : base model, module LoRA, dim/alpha, architecture, quantization (`Q4_K_M`, `F16`…), contexte.
- **Fiche `.civitai.info` / `.json`** lue automatiquement quand elle existe (nom, version, mots-clés).
- **Doublons** par empreinte rapide (taille + début + fin de fichier) — sans lire 20 Go.
- **Déplacement / copie vérifiée** entre racines, avec barre de progression, contrôle d'empreinte avant suppression de la source, et refus si l'espace libre est insuffisant.
- **Corbeille** `.mdisp-trash` (jamais de suppression définitive depuis l'UI) + restauration.
- **Liens symboliques / physiques** pour exposer un modèle à une autre application sans le dupliquer.
- **Plan « faire de la place »** : choisis un disque saturé, le dispenser propose les plus gros modèles à renvoyer vers une archive, avec le total libérable.
- **Scan de dossier / disque** : les modèles trouvés hors racine sont marqués « non gérés » puis adoptés en un clic.
- **Découverte douce de tous les disques** : un scan en tâche de fond des volumes locaux, avec faible concurrence, pauses régulières, dossiers système ignorés et fichiers de moins de 1 Mo écartés.
- **Application desktop PAIZ** (Tauri v2) : une vraie fenêtre, un installeur Windows, le moteur Node embarqué.
- **Interface web locale** (aucun build, aucun framework) + **CLI** + **API JSON**.
- **Zéro dépendance npm à l'exécution** : Node.js 24+ (SQLite intégré via `node:sqlite`).

---

## Démarrage rapide

### Application desktop PAIZ

Prérequis pour builder : **Node.js ≥ 24**, **Rust stable (MSVC)**, **Visual Studio Build Tools** avec la charge C++ et **WebView2** (déjà présent sur Windows 11).

```powershell
cd "D:\005-GIT\PAIZ - MODEL DISPENSER"
npm install

npm run tauri:dev       # fenêtre PAIZ en développement
npm run tauri:build     # installeur NSIS dans src-tauri/target/release/bundle/nsis
npm run tauri:build:exe # exe seul : src-tauri/target/release/PAIZ.exe
```

Ou double-clique simplement **`lancer-paiz.cmd`** : il ouvre l'exe local, sinon l'installation, sinon la version web.

L'icône est générée depuis `assets/paiz-icon.png` : `npm run tauri:icon`.

Le lanceur Tauri choisit un port local libre, démarre le backend Node embarqué, attend qu'il réponde, puis affiche l'interface. En version installée :

- données : `%APPDATA%\PAIZ\data`
- journal du moteur : `%APPDATA%\PAIZ\server.log`

`npm run tauri:prepare` recopie `src/`, `public/` et le runtime `node.exe` dans `src-tauri/resources/` : c'est ce dossier qui rend l'installation autonome (aucun Node à installer chez l'utilisateur final). Ces fichiers stagés sont ignorés par git.

Si le moteur ne démarre pas, la page de démarrage affiche l'erreur et le chemin du journal. Variables utiles en développement :

| Variable | Effet |
|---|---|
| `PAIZ_APP_DIR` | Force le dossier contenant `src/cli.js` |
| `PAIZ_NODE` | Force le binaire Node à utiliser |
| `PAIZ_HOME` | Force le dossier de données |

### Version web / CLI

Prérequis : **Node.js ≥ 24** (testé sur Node 26).

```powershell
cd "D:\005-GIT\PAIZ - MODEL DISPENSER"
npm start
```

L'interface s'ouvre sur <http://127.0.0.1:7788>.

### 1. Déclarer tes racines

> **Envie de voir à quoi ça ressemble sans toucher à tes disques ?**  
> `npm run demo` crée une bibliothèque factice dans ton dossier temporaire et lance l'interface sur <http://127.0.0.1:7799>.

Dans **Réglages**, ajoute par exemple :

| Nom | Chemin | Rôle |
|---|---|---|
| `active` | `C:\IA\Models` | `active` — le NVMe, disque de travail |
| `archive-D` | `D:\IA\Models` | `store` — l'écurie, disque lent |
| `archive-I` | `I:\Sauvegardes\models` | `store` — autre disque |
| `civitai` | `K:\civitai` | `external` — dossier déjà existant, non réorganisé |

Une racine `active` est un dossier de travail normal. Une racine `store` est une archive. `external` sert aux dossiers que tu ne veux pas déplacer.

### 2. Scanner

**Scanner** → indique un dossier (ou choisis « enregistrer comme racine »). Le scan :
1. parcourt le dossier,
2. lit l'en-tête des fichiers `.safetensors` / `.gguf`,
3. calcule une empreinte rapide,
4. classe et indexe.

Les fichiers trouvés hors racine apparaissent en **« non gérés »** : tu peux les adopter vers une racine.

**Scanner tous les disques** lance le même travail sur les volumes locaux (fixes et amovibles) et quelques caches de modèles connus (HuggingFace, LM Studio, ModelScope…). Le mode est volontairement doux : parcours séquentiel, deux fichiers analysés à la fois, pause toutes les 20 dossiers, dossiers système ignorés, fichiers de moins de 1 Mo écartés. Les fichiers déjà dans une racine restent rattachés à cette racine ; les autres deviennent « non gérés ». Le bouton **Annuler** de la barre de progression arrête proprement le scan.

### 3. Échanger

- **Déplacer** un modèle d'une racine à l'autre : bouton « Déplacer » dans le catalogue.
- **Faire de la place** : onglet Disques → choisis `C:` → « Proposer un plan » → coche → destination → « Déplacer la sélection ».
- Le transfert se fait **fichier → fichier**, vérifié par empreinte, sans aucun téléchargement.

> Les transferts entre disques passent par une copie complète (c'est le prix à payer). Sur un même disque, un `rename` instantané est utilisé.

---

## Ligne de commande

```powershell
# Raccourci Windows (facultatif) : paiz.cmd est fourni
.\paiz.cmd --help
```

| Commande | Description |
|---|---|
| `paiz serve [--port 7788] [--no-open]` | Lance l'interface web |
| `paiz init` | Initialise la base locale |
| `paiz add-root <nom> <chemin> [--role store\|active\|external]` | Déclare une racine |
| `paiz roots` | Liste les racines et leur occupation |
| `paiz rm-root <nom\|id>` | Retire une racine (les fichiers restent) |
| `paiz scan [chemin\|nom-racine] [--force]` | Scanne et indexe (`--force` relit les métadonnées) |
| `paiz list [recherche] [--category lora --base sdxl --root archive]` | Liste le catalogue |
| `paiz disks` | Espace libre, poids et nombre de modèles par racine |
| `paiz dups` | Groupes de doublons + espace récupérable |
| `paiz move <id> --to <racine> [--copy]` | Déplace (ou copie) un modèle |
| `paiz trash <id…>` / `paiz restore <id…>` | Corbeille / restauration |
| `paiz link <id> <chemin> [--hard]` | Lien symbolique ou physique |
| `paiz hash <id…> [--quick]` | Calcule le SHA-256 complet |
| `paiz stats` | Statistiques par catégorie et par base |
| `paiz open` | Ouvre le dossier de données |

Toutes les commandes de lecture acceptent `--json` (sortie machine).

> Compatibilité : `mdisp.cmd` et l'alias `mdisp` restent disponibles pour les scripts existants.

---

## Comment ça reconnaît un modèle

### Safetensors
L'en-tête JSON est lu directement (sans charger le fichier) :

- `__metadata__.ss_base_model_version` → base (Pony, SDXL, FLUX…)
- `__metadata__.ss_network_module` / `ss_network_dim` → LoRA
- noms de tenseurs (`lora_down`, `hada_w1_a`, `input_hint_block`, `first_stage_model`…) → catégorie
- `modelspec.title`, `modelspec.architecture` → titre et famille

### GGUF
Le bloc de métadonnées GGUF est décodé (types scalaires, tableaux ignorés proprement) :

- `general.architecture` → Llama, Qwen, Mistral, Gemma…
- `general.name` → titre
- `general.file_type` + nom de fichier → quantization (`Q4_K_M`, `Q8_0`, `F16`…)
- `*.context_length`, `*.block_count` → infos techniques

### Nom de fichier
En dernier recours, des heuristiques prudentes (`pony`, `sdxl`, `control_v11p_sd15_openpose`, `4x_`, `lora`, `vae`…). L'ordre est : métadonnées fortes → fiche Civitai → nom de fichier.

### Fiches Civitai
Si un fichier `<modele>.safetensors.civitai.info` ou `<modele>.json` existe à côté du modèle, il est lu (base, nom, version, mots-clés).

---

## Familles et compatibilité des LoRA

Chaque base est rangée dans une famille :

| Famille | Bases |
|---|---|
| `sd15` | SD 1.5 |
| `sd2` | SD 2.0, SD 2.1 |
| `sdxl` | SDXL, **Pony**, **Illustrious**, **NoobAI** |
| `sd3` | SD 3, SD 3.5 |
| `flux` | FLUX |
| `llama`, `qwen`, `mistral`, `gemma`, `phi`, `deepseek` | LLM |

Le filtre « base » de l'interface permet de sélectionner **toute une famille** (ex. « SDXL & dérivés ») : c'est la vue « quels LoRA sont compatibles avec ce checkpoint ».

> C'est volontairement large : un LoRA Pony est marqué famille `sdxl`. Pour un tri fin (version exacte du checkpoint d'entraînement), utilise les tags et les notes de la fiche.

---

## Liens vers les autres applications

Deux modes :

1. **Lien symbolique** : l'application voit le fichier à l'emplacement attendu, le contenu réel reste dans le dispenser. Sous Windows, il faut le **Mode développeur** (Paramètres → Système → Pour les développeurs) ou un terminal administrateur.
2. **Lien physique** (`--hard`, même disque uniquement) : zéro octet supplémentaire, mais le fichier n'existe que sur ce volume.

Exemple classique :

```powershell
paiz link 42 "C:\IA\ComfyUI\models\loras\mon-style.safetensors"
```

Le lien est enregistré dans la fiche du modèle (section « Liens créés »).

---

## API JSON locale

L'interface n'est qu'un client de l'API. Tout autre programme peut s'y brancher.

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/api/state` | Racines, volumes, stats, événements |
| `GET` | `/api/assets?q=&category=&base=&rootId=&unmanaged=1&sort=size&dir=desc` | Catalogue filtré |
| `GET` | `/api/assets/:id` | Fiche détaillée |
| `GET` | `/api/lookup?name=…` | **Pour les autres apps** : retrouve un modèle par nom et renvoie son chemin |
| `PATCH` | `/api/assets/:id` | Éditer titre, catégorie, base, version, notes |
| `DELETE` | `/api/assets/:id` | Retirer de l'index **sans** toucher au fichier |
| `GET` | `/api/duplicates` | Groupes de doublons |
| `GET` | `/api/suggest?volume=C:&need=…` | Plan d'éviction |
| `POST` | `/api/roots` | Ajouter une racine |
| `POST` | `/api/scan` | Scanner un dossier (tâche asynchrone) |
| `POST` | `/api/scan/disks` | Découverte douce de tous les disques locaux (tâche asynchrone) |
| `POST` | `/api/jobs/transfer` | Déplacer / copier un modèle |
| `POST` | `/api/jobs/bulk-transfer` | Déplacer une sélection |
| `POST` | `/api/jobs/link` | Créer un lien |
| `POST` | `/api/jobs/trash` / `restore` / `hash` | Corbeille, restauration, empreinte |
| `GET` | `/api/jobs/:id` | Suivi de progression |
| `GET` | `/api/export` | Export complet du catalogue |

Exemple :

```powershell
curl.exe -s "http://127.0.0.1:7788/api/assets?category=lora&base=group:sdxl" | ConvertFrom-Json
```

Toutes les réponses sont en JSON. Les actions longues renvoient un `job` à suivre via `/api/jobs/:id` (`progress.done`, `progress.bytes`, `progress.totalBytes`, `status`). `POST /api/scan/disks` accepte aussi `{ includeRemovable, includeCaches, minBytes, maxDepth, paceMs }` pour ajuster la découverte (les valeurs par défaut sont le mode doux).

### Exemple d'intégration (Pinokio, ComfyUI, script perso)

1. `GET /api/lookup?name=flux1-dev.safetensors` → le chemin exact du modèle (ou plusieurs candidats).
2. Si l'application a besoin du modèle sur `C:` alors qu'il dort sur `D:`, lancer `POST /api/jobs/transfer` avec `{ "assetId": 12, "toRootId": 1, "mode": "move" }`, suivre le job, puis lire `result.path`.
3. Après usage, renvoyer le modèle vers l'archive avec le même endpoint (racine inverse).

C'est le « swap » sans re-téléchargement : le dispenser est le seul à connaître l'emplacement réel.

---

## Architecture

```
src/
  cli.js        # CLI (paiz, alias mdisp)
  server.js     # serveur HTTP + API + fichiers statiques
  db.js         # schéma SQLite et requêtes
  detect.js     # analyse safetensors / GGUF / Civitai / noms
  scanner.js    # parcours disque + indexation, mode découverte douce
  volumes.js    # énumération des disques locaux et caches de modèles connus
  jobs.js       # transferts, liens, corbeille, hash (jobs en mémoire)
  util.js       # helpers (hash rapide, tailles, chemins)
public/
  index.html    # interface web
  app.js        # client vanilla
  style.css
ui/
  index.html    # splash Tauri (démarrage / erreurs)
src-tauri/
  src/main.rs   # coque PAIZ : port libre, spawn Node, attente, navigation
  tauri.conf.json
  resources/    # staging généré (app/ + node.exe), ignoré par git
scripts/
  prepare-tauri.mjs  # copie src/, public/ et node.exe pour le bundle
  demo.mjs           # bibliothèque factice pour tester
test/
  smoke.mjs     # tests de bout en bout (fichiers factices + API)
assets/
  paiz-icon.png # source de l'icône, régénérée via npm run tauri:icon
lancer-paiz.cmd # lanceur Windows : exe local → installation → version web
```

- Données web/CLI : `./.data/dispenser.db` (SQLite, WAL). Données desktop : `%APPDATA%\PAIZ\data`. Modifiable via `PAIZ_HOME` (`MDISP_HOME` reste accepté).
- Aucune dépendance npm à l'exécution, aucun build pour l'interface web.
- L'empreinte rapide = SHA-256 de `taille + 256 Ko de début + 256 Ko de fin`. Le SHA-256 complet est optionnel (`paiz hash`, bouton « Empreinte »).

```powershell
npm test
```

---

## Limites connues / feuille de route

- **Pas de lecture des `.ckpt` / `.pt`** (pickle) : on se rabat sur le nom et la fiche Civitai. Les lire nécessiterait un parseur Python-compatible et serait risqué.
- **Pas d'aperçu des images** de modèles pour l'instant (les fiches Civitai contiennent souvent une URL).
- **Liens symboliques Windows** : dépend du Mode développeur.
- **Doublons** basés sur l'empreinte rapide, pas sur un hash intégral par défaut (volontairement rapide). Le hash complet est disponible au cas par cas.
- **Jobs en mémoire** : un redémarrage interrompt le suivi (mais pas les fichiers déjà copiés ; le transfert vérifie avant suppression).
- **Pistes envisagées** :
  - serveur MCP pour que les agents IA puissent demander « sors-moi ce modèle sur C: »
  - intégration Pinokio / ComfyUI (détection des dossiers `models/*`)
  - déduplication par hardlinks sur un même volume
  - quotas par disque et règles de rangement automatiques (LRU)
  - support des partages réseau (SMB) et des hashs mis en cache
  - import/export de « profils » (ex. « config FLUX » = checkpoint + LoRA + VAE + ControlNet)

---

## Sécurité

Le serveur écoute uniquement sur `127.0.0.1` par défaut. Il ne supprime jamais de fichier hors de la corbeille `.mdisp-trash`, et ne déplace un fichier qu'après vérification d'empreinte. Ne l'expose pas sur le réseau sans ajouter d'authentification.
