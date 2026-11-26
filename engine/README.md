# WeightStream

**Faire tourner les mêmes modèles avec moins de ressources** (VRAM, RAM, CPU), ou sur des machines où ils ne tourneraient pas.
WeightStream n'est pas un moteur d'inférence concurrent de llama.cpp : c'est une couche qui s'y greffe et déplace les
poids **SSD → RAM → VRAM** à la demande, comme un streamer d'assets de jeu vidéo.

> **Ce que mesure le projet** : les ressources divisées par N *pour le même texte* (pic de VRAM, pic de RAM du processus,
> CPU). La vitesse est le prix payé, jamais le but. **Sans perte par défaut** : même texte, jamais moins d'experts ni de couches sautées.
> Un mode avec perte (par exemple compresser les poids en transit pour aller plus vite) ne sera proposé que comme option
> explicite, étiquetée à part, qui dit ce qui est perdu, sur quels réglages et pourquoi on l'accepte (la vitesse).

## État actuel (novembre 2026) : streaming d'experts MoE

Depuis novembre 2026, WeightStream streame les **experts des modèles MoE** (Mixture of Experts) via des crochets dans un
llama.cpp vendoré (sous-module épinglé, crochets fournis sous forme de patch). Quelques résultats mesurés (détails,
conditions et limites dans [`Docs/HANDOFF_2026-11.md`](Docs/HANDOFF_2026-11.md), sections numérotées) :

| Sujet | Résultat | Réf. handoff |
|---|---|---|
| Qwen3-Coder-Next 48,5 Go sous plafond de RAM (8 Go / VRAM 6 Go) | 3,6 tok/s contre 1,1 pour llama.cpp seul, texte identique | §25 |
| Prefill « tapis roulant » (prompt de 4 010 jetons) | 318 s → ~35-54 s, mêmes octets envoyés au GPU, pic de RAM 12,5 → 5,4 Go | §32 |
| Lookahead du routeur (experts de la couche N+d prédits d'avance) | −19 % de temps de génération, sortie identique | §35 |
| Gemma 4 26B-A4B : grille VRAM × RAM | La VRAM fait la vitesse (2 Go : 3 tok/s, 6 Go : 26 tok/s) ; à VRAM égale, 3,6× moins de RAM que llama.cpp seul | §42-43 |
| Plusieurs conversations / modèles en même temps | Deux `ws_npc_server` (Gemma + Qwen3-Coder-Next 48 Go) dans 12 Go de VRAM | §43 |
| Reprise de travail exacte | Pause/reprise d'une requête `/v1` en cours, point de reprise de fin de prompt | §38-40 |
| gpt-oss-120b (63 Go) sur RTX 3060 12 Go | ~1,5 tok/s, tâche de code réelle réussie (6 tests sur 6) | §42 |

Plusieurs pistes ont aussi été **mesurées et écartées** (décodage spéculatif sans brouillon, décodage par lots quand le SSD
domine, prédiction des experts du decode par ceux du prefill, saut de couches) : elles sont documentées avec leurs chiffres
pour ne pas être refaites.

### Les composants

- **`ExpertStore` / hooks llama.cpp** : lecture SSD des experts, cache RAM, cache VRAM ; patch à appliquer au sous-module
  (`Docs/patches/llama-weightstream-hooks-6c01da62.patch`).
- **`ws_npc_server`** : service local compatible OpenAI (`/v1/chat/completions`) avec fils de conversation persistants
  qui « dorment » sur disque, pause/reprise, profils de ressources réglables en marche. Voir [`Docs/NPC_SERVER.md`](Docs/NPC_SERVER.md).
- **`ws_moe_probe`, `ws_expert_profile`, `ws_mem_hog`, `ws_run_capped`, `ws_ssd_probe`…** : outils de mesure sous plafond
  mémoire (`tools/`).
- **Usages** (petits modèles de PNJ, modèle moyen, modèle plus grand que la machine, dialogue/jeu) : [`Docs/USAGES.md`](Docs/USAGES.md),
  multi-modèle : [`Docs/MULTI_MODEL.md`](Docs/MULTI_MODEL.md).
- **PAIZ-WeightStream** (dossier [`paiz/`](paiz/)) : l'application, c'est-à-dire l'interface qui pilote le moteur
  (Node ≥ 24, fenêtre Tauri optionnelle, aucune dépendance npm à l'exécution). Six onglets :
  **WeightStream** (lancer un modèle, grille « Où » GPU/RAM/adaptatif × « Combien » discret → rapide, branchement OpenCode),
  **Travail** (projets, discussion en direct avec un agent de code via OpenCode, file de tâches pour gros modèles avec
  pause/reprise, plans et to-do par consigne, mémoire de projet et mémoire globale, personnages),
  **Model Dispenser** (catalogue multi-disques, doublons, déplacements vérifiés), **Découvrir** (recherche et
  téléchargement de modèles), **Outils** (serveurs MCP, skills, Blender/ComfyUI/Godot), **Entretien** (santé, restes
  oubliés, sauvegardes). Un mode **⚠ extra-light** (« plus rapide mais instable ») utilise une version Q3 du modèle, fabriquée à la demande : environ 2,3 fois plus rapide à VRAM égale mais avec perte (voir `Docs/HANDOFF_2026-11.md` §44), à réserver à la discussion. Elle sert aussi un relais `/v1` qui ajoute persona, mémoire et préchauffage du prompt.
  Détails : [`paiz/README.md`](paiz/README.md).

### Démarrage (chemin MoE, Windows + CUDA)

```powershell
git clone --recursive https://github.com/Nosferatumiamor/PAIZ.git && cd PAIZ/engine   # ou: git submodule update --init
.\scripts\apply-llama-patch.ps1   # applique les crochets WeightStream au sous-module llama.cpp (épinglé sur 6c01da62)
.\scripts\build-llama.ps1         # llama.cpp CUDA -> build-llama\ (20-30 min la première fois)
.\scripts\build-ws-tools.ps1      # ws_moe_probe, ws_npc_server, ws_mem_hog... -> build-llama\bin
.\scripts\run-npc-server.ps1      # ou double-clic sur WeightStream.bat : menu des modèles et profil de ressources
```

Avec l'interface (recommandé) :

```powershell
cd paiz
npm start                         # http://127.0.0.1:7788  (Node >= 24) ; ou double-clic sur PAIZ.bat à la racine
npm test                          # 17 suites, sans modèle ni GPU (faux moteur)
```

Au premier lancement, déclarer le dossier des modèles (`node src/cli.js add-root ssd C:\llm-models --role active`) puis
`node src/cli.js scan`. PAIZ trouve le moteur construit ci-dessus dans `build-llama\bin` (réglage `engine.dir` sinon).

Les modèles (`.gguf`) ne sont pas dans le dépôt ; le lanceur lit `C:\llm-models` (à placer sur un SSD NVMe).
Après une modification du llama.cpp vendoré, régénérer le patch :
`git -C third_party/llama.cpp diff > Docs/patches/llama-weightstream-hooks-6c01da62.patch`.

**Matériel de référence** : RTX 3060 12 Go, 32 Go de RAM, SSD NVMe (PCIe 3, plafond mesuré ≈ 2,2 Gio/s).

### Limites connues

- Windows + NVIDIA seulement pour l'instant ; le chantier multiplateforme est décrit dans [`Docs/ROADMAP.md`](Docs/ROADMAP.md).
- Le `CMakeLists.txt` racine ne compile pas tel quel (le chemin MoE se construit avec les scripts ci-dessus).
- Beaucoup de mesures sont des essais uniques sur un seul prompt ; chaque section du handoff dit ce qui reste à confirmer.
- Le prefill de Gemma reste lent (~75 tok/s contre ~260 pour llama.cpp seul) : cause non élucidée.

---

# Annexe : moteur par pages (juillet 2026, ancien MVP)

*Cette partie décrit le premier moteur (pages de 32 Mo, VTMM, ordonnanceur FIFO), conservé pour référence. Une partie est
obsolète par rapport au chemin MoE ci-dessus.*

Moteur C++17 de **streaming de poids** pour modèles d'IA — indépendant de tout moteur d'inférence.

WeightStream ne fait pas d'inférence. Son rôle est de déplacer des blocs de données (tenseurs) entre **SSD → RAM → VRAM** de façon transparente, à la manière d'un moteur de streaming de ressources de jeu vidéo appliqué aux poids d'un réseau neuronal.

### Vision (RFC)

Les documents de référence sont dans `Docs/` :

| RFC | Sujet |
|-----|-------|
| RFC-0001 | Architecture globale, composants |
| RFC-0002 | Scheduler, cache, algorithmes de streaming |
| RFC-0003 | Virtual Tensor Address Space (VTAS) |
| RFC-0004 | Virtual Tensor Memory Manager (VTMM) |
| **[ROADMAP.md](ROADMAP.md)** | **Feuille de route (phases, offload dynamique)** |

Ce dépôt implémente un **MVP pragmatique** — pas la vision complète des RFC.

## MVP (ce qui est implémenté)

- [x] Lecture d'un fichier **GGUF** (index des tenseurs, pas de chargement intégral)
- [x] Construction de l'**index des tenseurs**
- [x] **VTAS** — adresses virtuelles stables, table de mapping
- [x] **VTMM** — pipeline SSD → RAM → VRAM avec caches à capacité fixe
- [x] **Scheduler FIFO** avec fenêtre de prefetch configurable
- [x] API **`GetPage()`** — pages fixes (défaut 32 Mo)
- [x] API **`GetTensor()`** — mode legacy (`--page-mib 0`)
- [x] **`ws_benchmark`** — matrice CSV de configs
- [x] **Coalescing SSD** — fusion des lectures contiguës (désactivé par défaut, stabilité)
- [x] Intégration llama.cpp (`ws_infer`, byte reader)
- [x] Garde-fou saturation RAM système (`SystemMemoryGuard`)

### Hors scope (RFC / ROADMAP, pas encore codé)

- Offload dynamique GPU/CPU (`ExecutionPolicy::HybridDynamic`) — voir `Docs/ROADMAP.md`
- Cache thermique HOT/WARM/COLD
- Double/triple buffering GPU réel
- Multi-modèles

## Build

```powershell
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

## Utilisation

### 1. Inspecter la composition logique d'un modèle

`ws_inspect_gguf` présente les blocs transformer tels qu'ils sont stockés dans le GGUF :
chaque couche logique, son poids total, puis chacun de ses tenseurs et dimensions. Il ne
découpe pas les couches selon une taille de page arbitraire. Cette vue sert de base au
futur protocole d'ablation et de bypass, où l'on testera des couches entières et non des
tranches de stockage.

```powershell
.\build\Release\ws_inspect_gguf.exe models\gemma4-coding-Q4_K_M.gguf
```

Pour afficher également les tenseurs partagés (embedding, sortie, etc.) et tout nom de
tenseur non reconnu :

```powershell
.\build\Release\ws_inspect_gguf.exe models\gemma4-coding-Q4_K_M.gguf --tensors
```

Pour exporter un manifeste exploitable par un futur pipeline de tests :

```powershell
.\build\Release\ws_inspect_gguf.exe models\gemma4-coding-Q4_K_M.gguf --json
```

Cette vue est le point de départ du futur protocole d'ablation : un masque de bypass
devra viser une couche logique complète, jamais une page de stockage de taille fixe.

### 2. Générer un faux modèle (simule un gros modèle)

```powershell
.\build\Release\ws_generate_synthetic.exe synthetic.gguf 80 512
# 80 tenseurs × 512 KiB ≈ 40 MiB (ajuster pour tester plus gros)
```

Pour simuler ~40 Go : `80 512000` (80 × 512 Mo).

### 2. Lancer la démo

```powershell
.\scripts\build.ps1
.\build\Release\weightstream_demo.exe models\Qwen2.5-32B-Instruct-Q4_K_L.gguf --page-mib 32
```

Options :

| Option | Description |
|--------|-------------|
| `--vram-mib N` | Budget VRAM simulé (défaut : 12 288 MiB) |
| `--ram-mib N` | Budget RAM cache (défaut : 32 768 MiB) |
| `--page-mib N` | Taille de page (défaut : 32, `0` = mode tenseur) |
| `--coalesce-mib N` | Taille max d'une lecture SSD fusionnée (défaut : 256, `0` = off) |
| `--tensor-mode` | Alias pour `--page-mib 0` |
| `--window N` | Fenêtre de prefetch FIFO (défaut : 4) |
| `--rounds N` | Nombre de passes (défaut : 2) |
| `--sequential` | Affiche chaque page au fil de l'eau |

### 3. Benchmark CSV

Matrice systématique (7 configs, **plusieurs heures** sur un gros modèle) :

```powershell
.\build\Release\ws_benchmark.exe models\Qwen2.5-32B-Instruct-Q4_K_L.gguf --csv results.csv
```

Test rapide (une config 32 Mo) :

```powershell
.\build\Release\ws_benchmark.exe models\Qwen2.5-32B-Instruct-Q4_K_L.gguf --quick
```

### 4. Profile PGO (`.wsprofile`)

```powershell
# Enregistrer une passe linéaire (apprentissage)
.\build\Release\ws_profile.exe record models\Qwen2.5-32B-Instruct-Q4_K_L.gguf `
  --out models\Qwen2.5-32B-Instruct-Q4_K_L.wsprofile

# Construire l'ordre layer-by-layer (sans exécuter l'inférence)
.\build\Release\ws_profile.exe infer models\Qwen2.5-32B-Instruct-Q4_K_L.gguf `
  --out models\Qwen2.5-32B-Instruct-Q4_K_L.wsprofile --rounds 1

# Rejouer avec prefetch + eviction guidés par le profil
.\build\Release\ws_profile.exe replay models\Qwen2.5-32B-Instruct-Q4_K_L.gguf `
  --profile models\Qwen2.5-32B-Instruct-Q4_K_L.wsprofile --rounds 1
```

### 5. Détection matériel + estimation

```powershell
.\build-gpu\ws_specs.exe
```

Affiche CPU, RAM, GPU et une estimation du type : « natif ~16 Go → streaming confort ~23 Go ».

### 6. Micro-interface de test (navigateur local)

```powershell
.\scripts\run-chat-ui.ps1
# ou manuellement :
.\build-gpu\ws_chat_ui.exe -m models\Qwen2.5-32B-Instruct-Q4_K_L.gguf --ram-gib 32 -ngl 35
```

Fenêtre web sur `http://127.0.0.1:8765` : réponse du modèle, prompt, console, jauge RAM, curseur quota garde-fou (20–100 %, mode Auto/Manuel/Off).

**Lanceur double-clic (Windows)** : `WeightStream Chat.bat` à la racine du repo.

### 7. API minimale

```cpp
#include "WeightStream/VTMM.h"

ws::Config config;
config.page_size = 32ULL * 1024 * 1024;  // pages 32 Mo (défaut)
config.vram_capacity = 12ULL * 1024 * 1024 * 1024;
config.ram_capacity  = 32ULL * 1024 * 1024 * 1024;
config.system_memory_guard = true;  // throttle si RAM système basse

ws::VTMM manager(config);
manager.load_model("model.gguf");

auto page = manager.get_page_by_index(0);
if (page.ready()) {
    const void* data = page.data;  // cache VRAM simulé
}
```

## Architecture

```
GGUF Reader → Tensor Index → VTAS (adresses virtuelles)
                                    ↓
                              VTMM + Scheduler
                                    ↓
                    SSD Reader → RAM Cache → VRAM Cache
```

Le moteur d'inférence (futur consommateur) ne connaît que `GetTensor(adresse_virtuelle)`.

## Tests

```powershell
ctest --test-dir build -C Release
```

## Prochaines étapes

Voir **[Docs/ROADMAP.md](Docs/ROADMAP.md)** pour le détail. En bref :

1. Stabiliser `ws_infer` sur Qwen 32B @ 32 GiB (`-ngl 35`)
2. Valider modèles 40–50 Go sur config RTX 3060 + 32 Go RAM
3. Phase 2 : API `ExecutionPolicy` (sans algo dynamique)
4. Phase 3 : offload compute guidé par profil `.wsprofile`

Validation rapide (~3 min) :

```powershell
.\scripts\run-realistic.ps1
```
