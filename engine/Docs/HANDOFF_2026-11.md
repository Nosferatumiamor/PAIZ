# WeightStream — note de passation (novembre 2026)

Note écrite par Claude (Opus) le 2026-11-06 pour la session suivante (Sonnet). Elle fait le bilan du
redémarrage du projet : ce qui a été construit, ce qui marche, ce qui n'a pas marché, et les pistes.
**À lire avant `AGENTS.md`, dont la partie architecture décrit encore l'ancienne version (pages de 32 Mo).**

## Objectif réel du projet (fixé par l'utilisateur le 2026-11-07) — à relire avant toute mesure

On ne fait **pas** la course avec llama.cpp. llama.cpp est le moteur ; WeightStream lui fait faire tourner les mêmes
modèles **avec moins de ressources**, ou sur des machines où il n'essaierait même pas. Trois cibles :

1. **Petits modèles "corrects"** (discussion, PNJ de jeu) avec quasiment rien en VRAM, RAM et CPU.
2. **Modèles moyens (Gemma de 10-15 Go)** avec nettement moins de VRAM et de RAM que normalement, génération plus lente
   assumée, **résultat identique**.
3. **Modèles qui dépassent la machine** : ils doivent tourner et sortir une réponse cohérente à la fin, même lentement.

L'indicateur principal est donc **les ressources divisées par N pour le même texte** (pic VRAM, pic RAM du processus,
CPU) ; la vitesse est le prix payé, jamais l'objectif. "x2 plus rapide que llama.cpp" n'est pas ce qu'on cherche ;
"même texte avec 2 fois moins de RAM et 3 fois moins de VRAM, à Y tok/s" l'est. Les comparaisons de vitesse des §9 à §13
sont à relire sous cet angle. Toujours sans perte.

## 1. Contexte et objectif

WeightStream était abandonné depuis juillet 2026 : streamer les poids d'un modèle **dense** depuis le
disque ne pouvait pas marcher (Qwen 32B = ~19,5 Go à lire par token). L'utilisateur l'a relancé après
avoir vu [turbo-fieldfare](https://github.com/drumih/turbo-fieldfare), qui fait tourner Gemma 4 26B-A4B
sur un Mac 8 Go en streamant depuis le SSD **les experts d'un modèle MoE** (~5,9 tok/s).

Objectif de l'utilisateur : faire de WeightStream un **outil de code hors-ligne pour machines modestes**,
pour deux cibles :
1. faire tourner un modèle sur un appareil qui a moins de RAM que le modèle ;
2. sur sa propre machine, faire tourner un modèle "trop gros" pour elle.

Idée directrice : l'architecture d'origine (SSD → RAM → VRAM avec caches) était bonne, c'est l'unité
qui était fausse. On passe des pages de 32 Mo d'un modèle dense aux **experts d'un modèle MoE**.

## 2. Matériel de l'utilisateur (important)

| Élément | Valeur |
|---|---|
| GPU | RTX 3060 12 Go |
| RAM | 32 Go, mais **~17 Go réellement disponibles** (Windows + appli). **Firefox prenait 17,5 Go** : le faire fermer avant toute mesure |
| `C:` | **SSD NVMe Samsung 980** : 2,1-2,3 Go/s en lectures aléatoires de taille d'expert, 0,5 ms |
| `D:` | **Disque dur mécanique** (Seagate SATA) : 0,04-0,05 Go/s en aléatoire, 18 ms. Le repo est dessus, **jamais les modèles** |
| `I:` | SSD NVMe en boîtier USB (Realtek RTL9210B), coincé en USB 2.0 (~40 Mo/s, pilote USBSTOR au lieu d'UAS) malgré câble/port changés : inutilisable |

L'échec de juillet ("le SSD est trop lent") venait en partie de là : on streamait depuis le disque dur.

**Modèle de test :** `C:\llm-models\Qwen3-Coder-Next-Q4_K_M.gguf` (unsloth, 48,5 Go). 80B paramètres,
3B actifs, 48 couches, 512 experts par couche, 10 actifs par token + 1 partagé, architecture hybride
DeltaNet (`qwen3next`). Experts routés : 43,6 Go (un expert = 3 tranches gate/up/down, ~1,82 Mo).
Tout le reste ne fait que 1,6 Go et tient en VRAM. Le modèle dépasse volontairement RAM + VRAM.

## 3. Ce qui a été fait

### llama.cpp (vendorisé, `third_party/llama.cpp`)
- Mis à jour de `32e41fa` (juillet) vers l'upstream **`6c01da62`** (2026-11-06). Les patchs de juillet sont
  sauvegardés dans `Docs/patches/` (et dans un `git stash` du sous-repo).
- Réappliqué le pont historique WeightStream (lecteur d'octets, `llama-mmap.cpp/h`).
- L'upstream a désormais un **cache VRAM d'experts** (`--moe-cache-mib`, `src/llama-moe-cache.cpp`, PR
  #29887) pour les experts gardés en RAM. Problème : ses ratés sont copiés depuis `w->data`, un mmap qui,
  si le modèle dépasse la RAM, devient un défaut de page géré par Windows (lent, une petite lecture à la fois).
- **Deux points d'accroche ajoutés** (`src/llama-ext.h` + `src/llama-moe-cache.cpp`, ~40 lignes) :
  - `llama_moe_set_expert_source` : sur un raté du cache VRAM, llama.cpp passe **tous les experts
    manquants d'une couche d'un coup** à WeightStream, qui renvoie un pointeur par expert. Les tampons
    restent valides jusqu'à l'appel suivant (`copy()` synchronise le GPU avant chaque couche).
  - `llama_moe_set_expert_observer` : remonte **tous** les experts choisis par le routeur, à chaque couche.
  - Sans source ni observateur branché, le comportement est exactement celui de l'upstream.
- Limite : ces points ne sont appelés que sur le chemin du cache VRAM, c'est-à-dire avec les experts
  forcés en CPU (`--cpu-moe` ou équivalent), `moe_cache_size > 0`, et des micro-lots ≤ 32 tokens
  (`--ubatch 32` pour y faire passer aussi la lecture du prompt).

### WeightStream (`include/WeightStream/`, `src/`)
- **`ExpertStore`** : cache RAM d'experts à taille fixe (arène `VirtualAlloc`, LRU) + lectures disque
  **non bufferisées, en parallèle** (`ReadFile` overlapped, `FILE_FLAG_NO_BUFFERING`, alignement secteur
  géré). Préchargement en tâche de fond d'un "profil" (experts épinglés, lectures urgentes prioritaires).
  **Windows uniquement** pour l'instant.
- **`GGUFReader`** corrigé : ne connaissait pas les formats K / IQ (tailles fausses, 0) et avait Q4_1/Q5_1
  faux. Table complète des types ggml désormais.
- **`ExpertSheets`** : les "fiches de perso" des experts demandées par l'utilisateur. Pour chaque expert
  de chaque couche : nombre d'usages par domaine, part, et **affinité** (= part dans le domaine / part du
  domaine dans tout l'usage ; ×1 = aucune préférence). Personne n'étiquette les experts, les fiches
  s'affinent à l'usage. Format binaire `.wssheets` + export CSV.
- **`DomainRouter`** : à chaque tour de parole, compare le routage du prompt aux fiches (cosinus) pour
  reconnaître le domaine, demande à `ExpertStore` de précharger le profil du domaine, puis ajoute
  l'usage réel aux fiches (`--learn`).

### Outils (`tools/`, compilés par `scripts/build-ws-tools.ps1`)
- `ws_moe_probe` : banc de mesure (journaux llama.cpp complets, stats du cache). Options `--cache-mib`
  (VRAM), `--ws-ram-mib` (brancher WeightStream), `--ubatch`.
- `ws_ssd_probe` : vitesse disque en lectures aléatoires non bufferisées de taille d'expert.
- `ws_expert_profile` : passe un jeu de prompts étiquetés, remplit les fiches, analyse (similarité entre
  domaines, détection du domaine depuis le prompt seul, couverture d'un préchargement), en "leave-one-out".
- `ws_moe_session` : rejoue une session et compare trois stratégies `--mode none|global|domain`.

### Données (`profiles/`)
- `prompts_fr.tsv` : 30 prompts d'apprentissage (6 domaines × 5, **tous en français** pour ne pas
  confondre langue et domaine) : code, discussion, traduction, histoire, sciences, calcul.
- `prompts_eval_fr.tsv` : 18 prompts **inédits**, domaines alternés, pour l'évaluation.
- `qwen3-coder-next.wssheets` + `qwen3-coder-next_fiches.csv` : les fiches apprises.
- `profile_run_1.txt`, `session_*.txt` : sorties brutes des mesures ci-dessous.

## 4. Résultats

### Vitesse (Qwen3-Coder-Next 48,5 Go, RTX 3060, prompt de code, génération greedy)

| Configuration | Prompt | Génération |
|---|---|---|
| llama.cpp officiel, modèle sur le **disque dur** | 0,3-0,4 tok/s | 0,44 tok/s |
| llama.cpp officiel, modèle sur le **NVMe** (cache VRAM 7,5 Go) | 1,53 tok/s | 2,18 tok/s |
| **+ WeightStream** (cache RAM 12 Go), 48 tokens à froid | **3,70 tok/s** | **4,12 tok/s** |
| **+ WeightStream**, session de 18 prompts (caches chauds) | **5,26 tok/s** | **8,53 tok/s** |

- **Sortie identique au caractère près** avec et sans WeightStream (vérifié avec `cmp`).
- Cache VRAM de llama.cpp : ~70-75 % de succès en génération (pour 17 % des experts). Le cache RAM
  WeightStream ne voit que ce que la VRAM rate : ~22-26 % de succès dessus.
- En génération à chaud : discussion et histoire montent à 13-18 tok/s, code et calcul restent à 6-9 tok/s.

### Fiches d'experts et détection du domaine
- **Domaine reconnu depuis le prompt seul : 30/30** (leave-one-out) et **18/18 sur les prompts inédits**.
- Similarité entre domaines (cosinus de l'usage des experts) : 0,50 à 0,71. Les plus proches : code ↔
  calcul (0,71) et code ↔ sciences (0,68).
- Exemples de fiches : couche 23 / expert 182 = 100 % histoire (×5,9) ; couche 21 / expert 13 = 81 %
  traduction (×7) ; couche 26 / expert 446 = 60 % calcul + 25 % sciences ; couche 46 / expert 154 =
  généraliste (~même part pour tous les domaines). 14 % des experts jamais sollicités sur 30 prompts.

### Préchargement : échec (pour l'instant)

Mode `ws_moe_session`, 18 prompts inédits, domaines alternés, 64 tokens par réponse :

| Stratégie | Génération | Succès cache RAM | Lu par le préchargement |
|---|---|---|---|
| **Aucun préchargement** | **8,53 tok/s** | 26,2 % | 0 |
| Profil global (top du classement) | 6,24 tok/s | 29,4 % | 6,6 Go |
| Profil du domaine (top) | 6,07 tok/s | 31,7 % | 56 Go |
| Profil global "étagé" (rangs 4129 et +) | 6,93 tok/s | 29,9 % | 6,6 Go |
| Profil du domaine "étagé" | 5,71 tok/s | 34,1 % | 77 Go |

L'estimation de `ws_expert_profile` annonçait 70 % (global) et 82 % (domaine) de couverture. **Elle était
trompeuse** : elle mesure la couverture de *tous* les usages, alors que la RAM ne voit que les ratés
de la VRAM. Causes probables du ralentissement :
1. Le haut du classement est **déjà dans le cache VRAM** ; le précharger en RAM fait doublon. La version
   "étagée" (sauter les ~4 100 premiers, que la VRAM est censée tenir) n'a presque rien changé.
2. **Épingler 75 % du cache RAM** ne laisse que 25 % au LRU qui absorbe les ratés imprévus.
3. Les lectures de préchargement **se disputent le SSD** avec les lectures urgentes (56-77 Go lus en
   mode domaine, parce que chaque changement de sujet recharge un profil).
4. Le jeu d'évaluation change de domaine à **chaque** prompt (pire cas) et chaque tour repart d'un
   contexte vide (pas de vraie conversation suivie).

**Conclusion actuelle :** la détection de domaine et les fiches marchent ; s'en servir pour remplir le
cache RAM pendant la génération coûte plus cher qu'un simple LRU.

## 5. Problèmes connus / pièges

- **Ne jamais mesurer avec le modèle sur `D:`** (disque dur), et faire fermer Firefox.
- La nouvelle interface de `llama-cli` n'affiche plus les journaux (même `-lv`, même `--log-file`) :
  utiliser `ws_moe_probe` pour voir les stats du cache.
- `CMakeLists.txt` principal **pas à jour** : il référence encore les outils de juillet (`ws_ablate`,
  `ws_bi_score`, `ws_fit_patch`, `ws_greedy_prune`, `ws_chat_probe`), qui utilisent l'API `skip_layers`
  retirée lors de la mise à jour de llama.cpp. Il **ne compilera pas** tel quel. Les nouveaux outils
  passent par `scripts/build-llama.ps1` puis `scripts/build-ws-tools.ps1`.
- `build-llama/` a été configuré avec l'ancien chemin du repo : `scripts/build-llama.ps1` le détecte et
  reconfigure (compilation CUDA complète, ~20-30 min la première fois).
- `ExpertStore` est Windows uniquement ; les tampons RAM ne sont pas "pinned" (copies vers la VRAM plus
  lentes que possible).
- La lecture du prompt (micro-lots > 8 tokens) obtient 0 % de succès dans le cache VRAM : chaque
  micro-lot de 32 tokens touche beaucoup d'experts.
- Le repo n'a **aucun commit git** (tout est "untracked") ; le sous-repo llama.cpp a ses modifications locales.

## 6. Matériel requis et estimations

**Un stockage rapide en lecture aléatoire est indispensable** : c'est lui qui fixe la vitesse de
génération. Disque dur = impossible (mesuré : ~0,2 tok/s même optimisé).

Plafonds **estimés** (non mesurés, disque seul) pour un MoE de la classe Gemma 4 26B-A4B
(~800 Mo d'experts par token, ~50 % déjà en cache) :

| Stockage | Lecture aléatoire | Plafond estimé | Exemples |
|---|---|---|---|
| NVMe récent | 3-5 Go/s | ~8-10 tok/s | PC récent, Mac/iPad M |
| NVMe ancien | ~2 Go/s (mesuré, Samsung 980) | ~5 tok/s | PC 2019-2022 |
| UFS 4.0 | ~1,5-2 Go/s | ~3-5 tok/s | téléphone haut de gamme récent |
| SSD SATA | ~0,4 Go/s | ~1 tok/s | vieux PC avec SSD |
| UFS 2.x / eMMC | 0,1-0,3 Go/s | 0,3-1 tok/s | tablette d'entrée de gamme |
| Disque dur | 0,04 Go/s (mesuré) | ~0,1 tok/s | inutilisable |

Ce qui rend un modèle "streamable" : MoE (jamais dense), peu de paramètres actifs, petite partie
commune (tient en mémoire), experts nombreux et petits, usage des experts concentré (cache efficace).
Références existantes : turbo-fieldfare (Mac 8 Go, ~6 tok/s) et le fork moe-stream (Jetson 8 Go,
~2-3 tok/s), tous deux avec Gemma 4 26B-A4B. Pour téléphone/tablette Android ou vieux PC Linux, il
faut porter `ExpertStore` (`pread` + `O_DIRECT`) ; iPhone/iPad passerait par Metal.

## 7. Pistes, par priorité

0. **Lecture des longs prompts (priorité n°1 pour un outil de code).** ~5 tok/s aujourd'hui : un agent
   de code qui envoie 3 000 tokens de contexte attendrait ~10 min. Idée : pour un gros micro-lot,
   presque tous les experts servent, donc lire chaque couche **entière et d'une traite** à pleine
   vitesse du SSD (le cas "dense") au lieu de passer par le cache d'experts. Ordre de grandeur sur le
   NVMe : ~43,6 Go de couches par lot de 512 tokens à ~2 Go/s ≈ 20 s, soit ~25 tok/s, à vérifier. Voir
   aussi les "waves" de la PR llama.cpp #25294.
1. **Revoir le rôle du préchargement plutôt que l'abandonner** :
   - ne plus épingler (ou très peu), juste un remplissage de départ que le LRU peut évincer ;
   - précharger **seulement pendant les temps morts** (entre deux tours, pendant que l'utilisateur
     tape), jamais en concurrence avec la génération ;
   - mesurer sur des sessions réalistes (un même domaine plusieurs tours de suite, contexte conservé).
2. **Rendre le cache RAM sensible à la fréquence** (CRF/LFU comme le cache VRAM upstream) au lieu du LRU pur.
3. **Mémoire "pinned"** pour l'arène RAM (`ggml_backend_cuda_register_host_buffer`) : copies vers la VRAM plus rapides.
4. **Faire calculer l'expert partagé pendant que le disque lit** (réordonner le graphe, comme le fork
   moe-stream d'Anyesh) : turbo-fieldfare y gagne ~7 %. Chantier plus lourd dans llama.cpp.
5. **Mettre à jour `CMakeLists.txt`** (retirer les outils de juillet, intégrer les nouveaux) et faire un
   premier commit.
6. **Cible "appareil faible"** : simuler avec un petit budget RAM/VRAM ; porter `ExpertStore` sous Linux
   (`pread` + `O_DIRECT`).
7. **Couche produit** : serveur compatible OpenAI pour les outils de code (llama-server + le point
   d'accroche), auto-configuration selon la machine (`ws_specs`), indicateur de chargement du profil.
8. Étoffer les fiches (plus de prompts, sessions réelles via `--learn`), et voir si un affichage des fiches
   (page HTML) intéresse l'utilisateur.
9. **Idée de l'utilisateur, à creuser : plusieurs modèles semi-chargés en parallèle** (par ex. un LLM et
   un modèle d'image dans ses autres projets), au lieu de tout décharger/recharger à chaque bascule.
   - LLM MoE : garder en permanence son cœur commun + ses experts chauds en VRAM, le reste en RAM/disque.
   - Modèle d'image (diffusion) : il est **dense** et utilise tous ses poids à chaque étape. Le streamer
     depuis le disque à chaque étape serait trop lent ; le garder en RAM et le monter en VRAM couche par
     couche pendant la génération est réaliste (comme l'"offload" de ComfyUI/diffusers).
   - L'apport de WeightStream serait un **chef d'orchestre mémoire multi-modèles** (VRAM chaude / RAM
     tiède / disque froid) qui anticipe la bascule (ex. : monter le modèle d'image en RAM pendant que le
     LLM finit sa réponse). Leçon des mesures : précharger dans les temps morts ou via RAM -> VRAM, jamais
     en concurrence avec les lectures disque de ce qui tourne.
   - **Projet concerné : `D:\005-GIT\l'application cliente`** (compagne de conversation locale). Analyse faite le 2026-11-06
     en lecture seule (rien modifié ; respecter son `AGENTS.md` : ne jamais lancer de générations d'images
     ni relancer son llama-server sans l'accord de l'utilisateur) :
     - LLM **dense** NemoMix-Unleashed-12B Q4_K_M (~7,5 Go, `C:\l'application cliente-modeles`) via llama-server ; images
       ComfyUI (SwarmUI) SDXL/Pony + IP-Adapter + ControlNet (~6 Go VRAM) ; les deux ne tiennent pas dans 12 Go.
     - Stratégie actuelle `swap_llm` (`client/images/engine.py`, `client/llm/server.py`) : llama-server est
       **tué** pendant l'image puis relancé. Mesures de son `docs/images.md` : image 26-35 s, LLM indisponible
       34-44 s, rechargement 7-8 s depuis le SSD ; 1re image de session ~60-70 s (lecture disque). ComfyUI
       garde déjà ses modèles en RAM entre deux images (seule la VRAM est libérée).
     - Conclusion : le streaming d'experts actuel **ne s'applique pas tel quel** (LLM dense) et l'essentiel de
       l'attente est la génération d'image elle-même. Gains possibles : (a) rechargement du LLM plus rapide en
       gardant ses poids en RAM ou en chargeant mieux (7-8 s -> quelques s) ; (b) préchauffer ComfyUI et le
       checkpoint au démarrage de l'appli (1re image) ; (c) **le vrai gain structurel** : passer à un LLM
       **MoE** (classe 30B-A3B / Gemma 4 26B-A4B, version "roleplay"/non censurée à valider en français) dont
       seule la partie commune + le cache KV restent en VRAM (~3 Go), experts en RAM (et sur NVMe via
       `ExpertStore` si la RAM est disputée avec ComfyUI) -> coexistence avec SDXL **sans aucun swap**, chat
       disponible pendant les images. Contrepartie : chat plus lent qu'aujourd'hui (~49 mots/s en dense GPU),
       qualité à tester.

## 8. Références

- turbo-fieldfare : `docs/SYSTEM_DESIGN.md` et `docs/OPTIMIZATION_JOURNEY.md` (mmap 0,50 → pread 3,97 tok/s ;
  prédiction des experts de la couche suivante abandonnée, 7 % de réussite).
- llama.cpp : PR #29887 (cache VRAM, fusionnée), PR #25294 (streaming disque, ouverte, O_DIRECT, "waves"
  pour le prefill), discussion #27149 (épinglage calibré : 42 % de succès contre 6 % au hasard),
  fork Anyesh `upstream-pr/moe-stream` (slots + callback sur le top-k + recouvrement).

## 9. Mise à jour (soir du 2026-11-06) : changement de modèle et échelle de budgets

**Décisions de l'utilisateur** : streaming **sans perte uniquement** (pas de réduction du nombre d'experts, pas de
couches sautées : ça rend les modèles "bègues") ; viser des modèles "un peu plus gros que la machine" (le ~100 Go est un
cap, le To est "en ligne de mire") ; la démonstration à faire est **"à quel budget mémoire ça tourne encore, et à quelle
vitesse ?"**, pas "WeightStream contre llama.cpp" (llama.cpp est le moteur, on ne le concurrence pas). Deux usages :
faire tourner plus gros que la machine, ou faire tourner un modèle normal avec moins de VRAM/RAM (idée PNJ de jeu :
réponses courtes, peu de ressources). l'application cliente reste pour plus tard.

**Modèles** : le Qwen3-Coder-Next de 48 Go a été supprimé (l'utilisateur veut garder Firefox ouvert). Téléchargés dans
`C:\llm-models\` : `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf` (22,1 Go, 256 experts) et `gemma-4-26B-A4B-it-UD-Q4_K_M.gguf`
(16,9 Go, 128 experts). Le llama.cpp vendorisé gère `qwen35moe`, `gemma4`, `gemma3n`, `olmoe`, `lfm2moe`.

**Outils ajoutés** : `ws_mem_hog` (verrouille de la RAM jusqu'à ce que N Mo restent disponibles, et continue à serrer :
simule une machine à RAM réduite), `ws_moe_probe` affiche maintenant pic de RAM (working set) et une empreinte du texte
généré, `scripts/sweep-moe.sh` (VRAM x RAM), `scripts/ladder-moe.sh` (échelle de budgets, llama.cpp seul puis WeightStream,
pic VRAM via nvidia-smi, empreinte du texte). `ExpertStore` : seuil minimal abaissé de 1024 à 384 emplacements
(`kMinSlots`) ; sous le seuil de besoin d'une couche, le hook retombe sur les pointeurs mmap (correct, mais lent).
Piège : lancer `build-llama.ps1` avec `*>` ou `2>&1` DANS PowerShell le fait échouer (CMake écrit sur stderr et
`$ErrorActionPreference=Stop`) ; appeler `powershell.exe -File ... > log 2>&1` depuis bash.

**Qwen3.6-35B-A3B, génération (tok/s), 160 tokens, grille VRAM x RAM WeightStream** (RAM libre ~11 Go, Firefox ouvert) :
cache VRAM 2 Go : seul 4,98 / WS3Go 3,99 / WS6Go 6,28 ; 4 Go : 5,35 / 6,23 / 8,31 ; 6 Go : 6,30 / 9,62 / 10,83 ;
7,5 Go : 6,76 / 12,86 / 13,91. Prompt : +50 à +80 % partout. Le cache RAM de WS compte peu (taux de succès 1-46 %) :
le gain vient surtout des lectures parallèles non bufferisées.

**Gemma 4 26B-A4B, échelle de budgets** (`reports/g4/ladder2/summary.tsv`, 128 tokens, essais uniques) :

| Cache VRAM | RAM visée | llama.cpp seul | + WeightStream | Pic RAM seul / WS |
|---|---|---|---|---|
| 6 Go | libre | 12,8 | 20,6 | 11,9 / 8,6 Go |
| 4 Go | libre | 24,5 (cache OS chaud ; 11,8 dans l'autre run) | 15,1 | 11,9 / 8,8 Go |
| 6 Go | 8 Go | 6,6 | **19,6** | 8,2 / 7,4 Go |
| 4 Go | 8 Go | 6,2 | **13,4** | 8,3 / 7,5 Go |
| 3 Go | 6 Go | 3,4 | **9,0** | 7,1 / 5,6 Go |
| 4 Go | 4,5 Go | 5,0 | **9,8** | 6,9 / 4,1 Go |
| 2 Go | 4,5 Go | 4,2 | 4,5 | 8,5 / 4,0 Go |

- **Texte identique (même empreinte) dans les 14 essais** : le streaming est sans perte, quel que soit le budget.
- WeightStream gagne ×2 à ×3 dès que la RAM est contrainte (<= 8 Go dispo) et consomme 35-50 % de RAM en moins.
  Sa vitesse est **reproductible** ; celle de llama.cpp seul dépend de l'état du cache de fichiers de Windows
  (même config : 11,8 puis 24,5 tok/s). Avec beaucoup de RAM libre, le cache OS peut battre WS : ce n'est pas son cas d'usage.
- Réserves : essais uniques ; le limiteur de RAM est approximatif (la RAM "disponible" inclut du cache qui se remplit,
  d'où un budget parfois plus large que la cible) ; à répéter pour mesurer le bruit.

**Vision ajoutée** : (a) **fenêtre mémoire élastique** (cache RAM facile à redimensionner ; le cache VRAM de llama.cpp
est alloué à la création du contexte, le redimensionner = réallouer, donc entre deux tours avec sauvegarde de l'état) ;
elle suit le taux de ratés et la détection de domaine ; (b) **mode "nuit"** pour des modèles de 100 Go à 1 To (0,1-1 tok/s,
file d'attente, sauvegarde régulière de l'état, ETA ; lecture du prompt = tout le modèle par lot, donc le prefill rapide
est la même priorité) ; il demande un gros NVMe (2 To, idéalement PCIe 4) ; (c) cohabitation multi-modèles ;
(d) petits modèles pour PNJ (Gemma 3n, petits MoE) : mémoire et temps avant premier token, pas de streaming d'experts
pour les denses. Le disque est lu à ~1,06 Go/s pendant ces essais alors que le NVMe peut ~2 Go/s : marge d'optimisation.

## 10. Petits modèles (PNJ) et mode CPU seul (2026-11-07)

Modèle : `LFM2-8B-A1B-Q4_K_M.gguf` (Liquid AI, 8,3 Mrd de paramètres, 1,5 Mrd actifs, 5,04 Go, arch `lfm2moe`), prompt
de PNJ français dans `profiles/npc_prompt_fr.txt` (tavernière Maelle). Réponses cohérentes et dans le personnage même aux
plus petits budgets (qualité "correcte", quelques métaphores bancales).

- **Empreinte réelle du processus** (`scripts/squeeze-moe.sh`, sans limiteur, VRAM = usage GPU moins la base du bureau ~1,7 Go) :
  600 Mo cache VRAM / 600 Mo cache RAM / micro-lot 8 : 4,4 tok/s, RAM 1,35 Go, VRAM 1,14 Go, prompt (185 tok) 37 s ;
  plus bas : 100 Mo / 90 Mo / micro-lot 1 : 2,2 tok/s, **RAM 0,83 Go, VRAM 0,63 Go**, prompt 85 s. Génération limitée par
  le disque (0 % de succès du cache RAM, ~1,7 Go/s). Le coût du prompt n'est payé qu'une fois par personnage si l'état
  (KV) est conservé : à vérifier avec une conversation multi-tours.
- **WeightStream est sans perte** : à réglages égaux le texte est identique à llama.cpp seul. Les différences entre lignes
  viennent du micro-lot, de la taille du cache VRAM (llama.cpp change de chemin de calcul quand le cache est minuscule)
  et du prompt (mon script retire le retour à la ligne final avec `$(cat)`, pas `-f`).
- `kMinSlots` de `ExpertStore` abaissé à 24 (repli sur mmap si une couche ne tient pas : correct, mais le repli contourne
  le budget mémoire, voir pic de RAM élevé à très petit cache).
- **Mode CPU seul** (`CUDA_VISIBLE_DEVICES=-1`, `--cache-mib 0` ; i5-9400F 6 coeurs, modèle en RAM) : prompt 39 tok/s,
  génération 15 tok/s, pic de RAM ~8,7 Go (llama.cpp reconditionne les poids Q4_K : copie en plus du mmap).
  Avec **plafond dur** de mémoire de travail (`ws_run_capped --max-mib N -- cmd`, nouvel outil) : 3 Go -> 11,6 tok/s,
  1,5 Go -> 4,0 tok/s (même texte). Verdict provisoire : sur un modèle de 5 Go, llama.cpp CPU + pagination de l'OS tient
  déjà bien ; brancher `ExpertStore` sur le chemin CPU (patch de `ggml_compute_forward_mul_mat_id`) n'est PAS prioritaire.
- **Piège de mesure** : `ws_mem_hog` réduit la RAM "disponible" mais n'empêche pas un processus de prendre la RAM des autres
  programmes (Firefox) : tests indulgents pour llama.cpp seul. Pour un budget réel, utiliser `ws_run_capped`. Les échelles
  Gemma/Qwen du §9 ont été faites avec `ws_mem_hog` : à refaire sous plafond dur pour vérifier (l'avantage de WS devrait
  augmenter, pas diminuer).
- Pistes : moteur maison minimal pour un seul petit modèle (pas de CUDA, ~1 exécutable) comme version embarquée ;
  cache de contexte entre tours ; cache RAM élastique (surtout utile quand l'OS a de la RAM libre).

## 11. Mode CPU streaming et vérification des échelles (2026-11-07)

- **Nouveau** : hook CPU `ggml_cpu_set_expert_fetch` (`ggml-cpu.h/.c`, appelé par le thread 0 dans `ggml_compute_forward_mul_mat_id`
  après le routage ; les noyaux "tiled" sont sautés quand le hook est actif car ils lisent `src0->data`) et option
  `ws_moe_probe --cpu-stream --ws-ram-mib N` (lancer avec `CUDA_VISIBLE_DEVICES=-1 --cache-mib 0`). `WEIGHTSTREAM_NO_PREFETCH`
  désactive le `PrefetchVirtualMemory` de llama.cpp (`llama-model.cpp`).
- LFM2-8B-A1B en CPU streaming avec 300 Mo de cache : 13-17 tok/s (CPU classique : 15-23 tok/s). **Texte identique**
  au CPU classique quand les noyaux tiled sont désactivés des deux côtés (`GGML_CPU_TILED_MM=0`) ; avec tiled actif côté
  classique, le texte diffère légèrement (autre ordre de sommation), ce qui n'est PAS un défaut du streaming.
- **Problème ouvert** : après le chargement, le processus a quand même ~4,2 Go de mémoire PRIVÉE et un working set de
  ~7,7 Go (LFM2) / 9 Go privé et 16,6 Go working set (Gemma 4) alors que les experts devraient rester non touchés dans le
  mapping. Quelque chose du chargement de llama.cpp lit/copie le modèle (pas le prefetch : testé). Piste : lire
  `llama_model::load_tensors` / `load_all_data` (condition `is_default_buft` ligne ~2029 de `llama-model.cpp`, et tout ce
  qui touche les tenseurs experts de l'override `ggml_backend_cpu_buffer_type()`), éventuellement tenseurs "lazy". Tant
  que ce n'est pas résolu le mode "éco" ne réduit pas la mémoire privée.
- **Échelles Gemma 4 : résultats contradictoires selon le limiteur, donc pas concluants.** `ws_mem_hog` seul (§9) : WS
  x2-3 plus rapide. `ws_run_capped` seul (plafond dur du working set, `reports/g4/capped_median.md`) : llama.cpp seul est
  PLUS rapide (23,5 vs 18,2 tok/s à 6 Go/8 Go) car les pages sorties du working set restent dans le cache de fichiers de
  l'OS. Aucun des deux n'émule une vraie petite machine ; il faut les deux ensemble (`CAPPED=1 HOGTOO=1`), lancé dans
  `reports/g4/both_r1|r2`. Ne pas citer les chiffres du §9 comme preuve tant que ce n'est pas tranché.

### 11.1 Mode éco réglé (2026-11-07, suite)

Cause des ~4 Go privés : quand un override envoie des tenseurs vers `ggml_backend_cpu_buffer_type()`, llama.cpp choisit
d'office un buffer "extra" (`CPU_REPACK`, `llama-model-loader.cpp` ~ligne 1252) : copie privée réorganisée de tous les
experts, calculée par ses propres noyaux qui **contournent le hook CPU**. Trouvé avec `WS_MEMTRACE=1` (le probe préfixe
chaque ligne de log par working set / mémoire privée). Correctif : `mp.use_extra_bufts = false` en `--cpu-stream`
(option `--no-repack` pour la référence). `build-ws-tools.ps1 -Suffix _dev -Only moe_probe` compile un probe sous un autre
nom quand un benchmark tient l'exe ouvert.

LFM2-8B-A1B, CPU seul, VRAM 0, texte identique dans les trois cas (`GGML_CPU_TILED_MM=0`), mesuré pendant qu'une échelle
GPU tournait (vitesses à refaire au calme) :

| Mode | Working set max | Privé max | Génération | Prompt (185 tok) |
|---|---|---|---|---|
| llama.cpp sans repack | 4,6 Go (pages du fichier mappé) | 0,2 Go | 11,3 tok/s | 13,9 tok/s |
| WS `--cpu-stream`, cache 300 Mo | **0,9 Go** | 0,5 Go | 2,2 tok/s | 10,6 tok/s |
| WS `--cpu-stream`, cache 1,2 Go | 1,8 Go | 1,4 Go | 4,0 tok/s | 10,9 tok/s |

Limite : le hook CPU fait une lecture par opération (gate, up, down = 3 attentes disque par couche) ; regrouper les trois
tenseurs d'un expert en une seule lecture, et lire la couche suivante pendant le calcul, sont les leviers évidents.

## 12. Projet voisin : Janas (github.com/prabanta-dev/janas), examiné le 2026-11-07

Moteur d'inférence propre en C, sans dépendance, GPL-3 (donc on s'inspire des idées, on ne copie pas le code), "expérimental",
~650 étoiles, un seul portable de test (Core Ultra 9 185H, 32 Go DDR5 81 Go/s, NVMe ~5,7 Go/s, iGPU Arc via Vulkan, NPU).
Experts streamés du NVMe avec `O_DIRECT`, cache d'experts en RAM, Windows supporté (pas de NPU), GPU discrets peu testés.
Annonce Qwen3-Next-80B à 26 tok/s contre 3,0 pour llama.cpp.

Idées utiles et **sans perte** :
1. **Lecture anticipée par le routeur de la couche suivante** : appliquer tôt le routeur de la couche N+1 à l'état courant
   et lire ses experts manquants pendant que la couche N calcule (décodage), et pour le prefill lire les experts que la
   majorité des tokens du bloc utilisera. Activé seulement quand le cache rate beaucoup. N'altère pas le résultat (les vrais
   experts sont relus si la prédiction est fausse). Contraste : turbo-fieldfare annonçait 7 % de réussite pour sa prédiction.
2. **Brouillons spéculatifs** (bloc MTP du modèle pour Qwen3.5/3.6/Next, petit modèle pour Gemma) : 63-89 % acceptés ;
   le texte reste celui du modèle.
3. **Auto-calibrage par machine** (`janas-bench` : threads, GPU/NPU, résultats en cache) : équivalent de notre `ws_specs`.
4. **Tier GPU des experts les plus utilisés** sur carte dédiée ("autant que possible").

À ne PAS reprendre (règle de l'utilisateur) : quand le cache tient moins d'1/5 des experts, Janas **saute les experts
"légers" absents** (Skliar et al. 2025) : c'est avec perte. Leur propre tableau (Qwen3-Next-80B, 2 Go de cache) : tous les
experts 11,0 tok/s / 393 tokens sur 400 conformes à llama.cpp ; méthode actuelle 26,4 tok/s / 380 sur 400. Une partie du
"26 vs 3" vient donc de ce raccourci, et leur disque est ~3x plus rapide que le Samsung 980 de l'utilisateur.

## 13. Intégration des idées de Janas + socle multi-modèle (2026-11-07, Opus) — POINT DE REPRISE POUR SONNET

Les tests en cours (échelle combinée Gemma `reports/g4/both_r1`, 10 essais faits, `both_r2` non commencé) ont été
**arrêtés volontairement** à la demande de l'utilisateur : ils seront à refaire avec les nouveautés ci-dessous.

**Ajouté (tout compile sans avertissement en /W4) :**
- `ExpertStore` : `prefetch(layer, experts)` (lecture asynchrone par le thread de fond, non épinglée, protégée pour ne
  pas évincer ce que les 4 derniers `fetch()` ont servi : `kPrefetchProtect`), `set_group_layer_reads(true)` (un raté lit
  aussi les autres tenseurs de l'expert dans la même couche), `open(path, budget, max_budget)` + `resize()` (réserve
  d'adresses, `MEM_COMMIT`/`MEM_DECOMMIT`), `capacity_bytes()/max_capacity_bytes()/min_capacity_bytes()`, nouvelles stats
  (`prefetch_reads/bytes/hits`, `group_reads`, `resizes`).
- `RouterLookahead` (`src/RouterLookahead.cpp`) : charge les routeurs F32 `blk.N.ffn_gate_inp.weight` (+ `exp_probs_b.bias`
  sigmoïde, + `ffn_gate_inp.scale`) et prédit les experts de la couche N+1 à partir des activations de la couche N
  (un token : top k + extra ; un bloc : vote sur 16 tokens échantillonnés, au plus 4k experts).
- `ExpertBudget` (`src/ExpertBudget.cpp`) : budget RAM partagé entre plusieurs `ExpertStore` (`add`, `focus`,
  `set_total`, rétrécit avant d'agrandir). Conception complète et étapes suivantes : **`Docs/MULTI_MODEL.md`**.
- Hook CPU ggml : la signature passe maintenant **l'op entière** (`ggml_cpu_expert_fetch_t(user, op, experts, n, out)`),
  donc poids (`op->src[0]`), activations (`src[1]`) et routage (`src[2]`).
- `ws_moe_probe` : `--group`, `--lookahead` (blocs de prompt seulement), `--lookahead-decode` (aussi en génération),
  `--lookahead-extra N`, `--elastic-test` (cache réduit de moitié au tiers de la génération, rétabli aux deux tiers),
  ligne de stats `prefetch: ...`. `--lookahead` exige `--cpu-stream` (le hook GPU ne voit pas les activations).

**Vérifié : texte identique** (même empreinte `da3b4ed2...`, LFM2, CPU, `GGML_CPU_TILED_MM=0`) pour stock / stream 300 Mo /
+group / +group+lookahead / 1,2 Go / redimensionnement en pleine génération. Chemin GPU : même texte que llama.cpp seul
avec et sans `--group` (`916b0c7a...`).

**Mesuré (LFM2-8B-A1B, CPU i5-9400F, 60 tokens, 2 passes, `reports/lfm2/v2/`) :**

| Config | Génération | Prompt (185 tok) |
|---|---|---|
| stream 1,2 Go | 5,2 tok/s | 13,5 tok/s |
| + group | 5,3 | 13,2 |
| + group + lookahead (prompt seulement) | 4,1-4,7 (bruit) | **16,0 (+19 %, stable)** |
| + group + lookahead-decode | 4,6-4,8 | 14,0-15,9 |
| stream 300 Mo | 2,45 | |
| 300 Mo + group | **2,85 (+16 %)** | |

Prédiction : 83-91 % des experts lus d'avance servent vraiment. Mais en génération une couche de LFM2 se calcule trop
vite pour que la lecture arrive à temps, et les lectures en trop encombrent le disque : pas de gain. À tester sur un modèle
plus lourd par couche (Qwen3.6, Gemma 4) et sur plus de tokens (60 tokens = trop de bruit).

**Pas fait (à reprendre) :**
1. Brouillons spéculatifs (bloc MTP de Qwen3.6, cf. Janas : 63-89 % acceptés, sans perte) : non intégrés.
2. Lecture anticipée sur le chemin GPU : impossible tel quel (le hook GPU n'a pas les activations) ; il faudrait un hook
   d'observation sur l'entrée FFN dans le graphe.
3. Auto-calibrage par machine (cf. `janas-bench`) : non fait (piste : étendre `ws_specs`).
4. `ws_multi_probe` (deux modèles, un budget) et aiguillage des hooks par modèle : voir `Docs/MULTI_MODEL.md`.
5. Refaire l'échelle Gemma 4 avec le limiteur combiné (`CAPPED=1 HOGTOO=1`), sur 128+ tokens et 3 passes, **en la
   pensant comme une mesure de ressources** : pour chaque budget, le texte est-il identique, quelle VRAM / RAM réelle,
   à quelle vitesse (prix). La question n'est plus "plus rapide que llama.cpp ?" mais "jusqu'à quel ratio de
   ressources en moins ça reste utilisable ?". Le "x2 à x3" de vitesse du §9 n'est pas un objectif.
6. `CMakeLists.txt` toujours pas à jour, et toujours aucun commit git.

## 14. Bracketing ressources de Gemma 4 26B-A4B (2026-11-07, nuit) — `reports/g4/bracket_*`

Mesure de l'objectif réel : **jusqu'où réduire les ressources, texte identique, vitesse = prix**. Prompt de code
(`profiles/code_prompt_fr.txt`), 128 tokens, ubatch 32, une passe, sans limiteur (`scripts/squeeze-moe.sh`), empreinte réelle
du processus : VRAM = usage GPU moins le bureau ; RAM = pic de mémoire de travail (inclut les pages mappées des poids
communs) ; "privée" = pic de mémoire engagée.

**Chemin GPU** (référence : llama.cpp seul, cache VRAM 6 Go, 9,75 Go VRAM / 11,95 Go RAM / 22,7 tok/s) :

| Cache VRAM | Cache RAM WS | VRAM | RAM | Génération | Réponse 40 tok | Texte |
|---|---|---|---|---|---|---|
| llama.cpp seul 2 Go | - | 5,7 Go | 11,95 Go | 16,2 tok/s | 6 s | = |
| 4 Go | 1,5 Go | 7,8 Go | 4,6 Go | 10,5 | 10 s | = |
| 2 Go | 0,7 Go | 5,7 Go | 3,8 Go | 4,6 | 16 s | = |
| **1 Go** | **0,7 Go** | **4,7 Go (÷2,1)** | **3,8 Go (÷3,2)** | **3,1** | **20 s** | **=** |
| 0,5 Go | 0,7 Go | 4,2 Go (÷2,3) | 4,1 Go (÷2,9) | 2,3 | 24 s | ≠ (*) |
| 0,5 Go | 0,3 Go | 4,2 Go | 4,0 Go | 2,0 | 26 s | ≠ (*), repli mmap |

**Chemin CPU seul, VRAM 0** (référence : llama.cpp CPU sans repack, 12,5 Go RAM / 7,0 tok/s ; même texte que lui) :

| Cache RAM WS | RAM | Privée | Génération | Réponse 40 tok | Texte |
|---|---|---|---|---|---|
| 3 Go | 6,7 Go | 4,3 Go | 4,2 tok/s | 16 s | = |
| 1,5 Go | 5,2 Go | 2,8 Go | 2,7 | 21 s | = |
| 0,7 Go | 4,4 Go | 2,0 Go | 1,8 | 30 s | = |
| **0,3 Go** | **4,0 Go (÷3,1)** | **1,6 Go** | **1,8** | **29 s** | **=** |

(*) "=" : même empreinte que la référence du même chemin (`39ff7cd3...` GPU, `99c16047...` CPU). À 0,5 Go de cache VRAM,
llama.cpp lui-même change de chemin de calcul (trop peu d'emplacements pour les micro-lots du prompt) : autre ordre
d'arrondis, texte légèrement différent mais **même modèle, même qualité** (vérifié à l'oeil : réponse C++ complète et
commentée en français, comme la référence). Le repli mmap apparaît à 0,3 Go de cache RAM (une couche du prompt ne tient pas).

**Lecture :**
- **Gemma 4 26B tourne sans GPU avec ~4 Go de RAM** (dont 1,6 Go privés), même texte, ~1,8 tok/s (réponse courte en ~30 s).
- Avec GPU : **÷2 en VRAM et ÷3 en RAM** pour le même texte, à ~3 tok/s. Le plancher VRAM (~4,2 Go) est la partie commune du
  modèle + KV + contexte CUDA ; le plancher RAM (~4 Go) est surtout les poids communs mappés (~2,5 Go) + le runtime.
- Honnêteté : la **réduction de VRAM vient surtout du cache VRAM d'experts de llama.cpp** (upstream) ; llama.cpp seul avec
  2 Go de cache tient déjà en 5,7 Go de VRAM, mais garde ~12 Go de RAM. **L'apport propre de WeightStream est la RAM (÷3)**
  et le mode CPU.
- Sous 0,7 Go de cache RAM la vitesse ne baisse presque plus (1,8 tok/s à 0,7 comme à 0,3 en CPU) : c'est le disque qui
  limite, pas le cache.

**Charge d'engagement de 8-11 Go : fausse alerte, éclaircie le 2026-11-07 (Sonnet).** L'hypothèse `CPU_REPACK` était
fausse : `--no-repack` en mode GPU ne change rien (Gemma 4, 1 Go de cache VRAM / 0,7 Go de cache RAM : commit 6450 Mo
avec ou sans, même texte, `reports/g4/norepack_*`). Le commit suit en fait la formule
`commit ~ VRAM utilisée + cache RAM WeightStream + ~0,7 Go` (vérifiée sur 4 lignes du tableau : 5745+300 -> 6746,
7674+700 -> 9150...) : sous Windows (WDDM) la mémoire GPU allouée est comptée dans la charge d'engagement du processus.
Ce n'est donc pas de la RAM consommée ; **la vraie RAM est `peak_ws_mib`**, la VRAM est `vram_delta_mib`. À ne plus
présenter `peak_commit_mib` comme une consommation en mode GPU (il reste pertinent en mode CPU seul, VRAM = 0).

Suites : plafonds VRAM plus bas (moins de contexte `-c`, KV en q8), garder les poids communs hors du working set (lecture
au lieu de mmap), répétitions (une seule passe ici), même bracketing sur Qwen3.6 et LFM2.

## 15. Deux conversations sur un seul Gemma 4 (2026-11-07, Sonnet) — `reports/g4/seqs/`

`ws_moe_probe --seqs 2 -f prompt1 -f2 prompt2` : un seul modèle chargé (mêmes caches d'experts), une séquence par PNJ,
un token par séquence dans chaque `llama_decode`. Config : cache VRAM 1 Go, cache RAM WeightStream 0,7 Go, ubatch 32,
40 tokens par séquence, Gemma 4 26B-A4B.

| Cas | RAM de travail (pic) | KV (VRAM) | Débit total | Par séquence | Octets lus sur le disque |
|---|---|---|---|---|---|
| 1 PNJ seul (Maelle) | 3,77 Go | 0,88 Go | 3,5 tok/s | 3,5 | 40 Go |
| 2 PNJ proches (Maelle + Gaspard) | 4,05 Go | 1,76 Go | 3,0 tok/s | 1,5 | 83 Go (2 x 40) |
| 2 sujets éloignés (code + Maelle) | 4,06 Go | 1,76 Go | 2,4 tok/s | 1,2 | 74 Go (24 + 40 -> pire) |

Conclusions :
- **Mémoire : le deuxième PNJ ne coûte presque rien** (+0,3 Go de RAM, +0,9 Go de KV). Deux processus indépendants
  auraient coûté 2 x (3,8 Go RAM + ~5 Go VRAM).
- **Vitesse : pas de gain de débit.** Le disque lit environ le double d'experts par pas (8 experts sur 128 par token et
  par couche : très peu de recouvrement entre deux conversations, même sur des PNJ proches). Chaque PNJ parle donc deux
  fois moins vite ; le total reste ~3 tok/s. Mon intuition de départ (lecture partagée) était fausse pour ce modèle.
- **Texte** : la séquence 0 en lot est identique à sa version solo (hash identique) pour le test code+PNJ ; les autres
  séquences divergent de quelques mots de leur version solo (calcul en lot, pas le même ordre d'additions), toujours
  cohérents. Pas de perte de qualité observable, mais pas bit-identique.
- Conséquence pour le jeu : N PNJ simultanés = mémoire quasi constante mais N fois plus lent chacun ; le bon schéma est
  un tour de parole ordonné (un PNJ à la fois, ou lot de 2 si on veut juste économiser la mémoire).
Pistes : plus de cache RAM augmente les recouvrements entre PNJ (non testé) ; un modèle à moins d'experts actifs par
couche partagerait moins encore ; deux contextes sur deux threads ne résoudraient pas la limite disque.

**Suite : cache RAM plus grand (2 PNJ proches, Maelle + Gaspard, cache VRAM 1 Go, 40 tokens)** — `reports/g4/seqs/*_w3000|6000*`

| Cache RAM WS | 1 PNJ seul | 2 PNJ en lot (total / par PNJ) | Lectures disque 2 PNJ vs 2 x solo | RAM pic (2 PNJ) |
|---|---|---|---|---|
| 0,7 Go | 3,5 tok/s | 3,0 / 1,5 tok/s | 83 Go vs 80 Go | 4,05 Go |
| 3 Go | 5,8 tok/s | 5,9 / 2,9 tok/s | 64,8 Go vs 66,8 Go | 6,3 Go |
| 6 Go | 8,8 tok/s | 9,2 / 4,6 tok/s | 29,1 Go vs 31,4 Go | 9,3 Go |

Verdict : le recouvrement d'experts entre deux PNJ existe mais reste faible (3 à 7 % de lectures en moins). Le lot de 2
donne le même débit total qu'un PNJ seul : on partage la mémoire (modèle et caches), pas le temps. Le débit total
dépend du cache RAM, pas du nombre de PNJ. Les textes en lot ne sont pas comparés bit à bit ici (voir plus haut : quelques mots de différence, toujours cohérents).

## 16. Fils de personnages indépendants sur un seul modèle (2026-11-07, Sonnet) — `ws_moe_probe --npc-script`

Besoin exprimé par l'utilisateur : pas la vitesse, mais **faire coexister plusieurs personnages (fils de discussion)
indépendants, en parallèle, sur un même modèle**. `ws_moe_probe --npc-script profiles/npc_script_fr.txt` :
une section `=== nom` par personnage (sa fiche), des blocs `--- round`, et `nom: réplique du joueur`. Chaque
personnage = une séquence llama.cpp (son propre KV, son propre historique, conservés d'un tour à l'autre) ; dans un
round, tous les personnages concernés répondent dans le même lot de décodage, un fil peut sauter un round.
Un fil ne préremplit que sa nouvelle réplique (0,5 s à chaud, hors lecture d'experts).

Résultat (Gemma 4 26B-A4B, cache VRAM 1 Go, cache RAM WS 3 Go, 3 personnages, 3 rounds, `reports/g4/seqs/npcs.out`) :
- les fils sont étanches : Maelle retient « Aldric » (round 3), Gaspard à qui on demande la même chose l'ignore ;
  Isaure, absente du round 2, reprend sans perdre le fil ; chacun garde son ton (bourrue / bougon / poétique) ;
- mémoire : 6,4 Go de RAM de travail, KV des 3 fils 1,3 Go de VRAM (ctx 2048 chacun), contre 3 modèles complets
  si on lançait 3 processus ;
- vitesse (le prix) : 5 à 7 tok/s au total pour les 2-3 fils d'un round, soit ~2 tok/s par personnage.

**Correction importante** : `llama_chat_apply_template` renvoie -1 pour le modèle de chat de Gemma 4 (format Jinja
`<|turn>role ... <turn|>`). Tous les essais antérieurs de `ws_moe_probe` (§14, §15) envoyaient donc le prompt **brut**,
sans mise en forme de chat. Les comparaisons (mêmes entrées, mêmes hashes) restent valides, mais pas la « qualité
de réponse » absolue de ces essais. Le mode `--npc-script` écrit le format Gemma 4 à la main (réflexion désactivée :
`<|turn>user\n...<turn|>\n<|turn>model\n<|channel>thought\n<channel|>`), ce qui n'est donc valable que pour Gemma 4.
Suites : lire le gabarit depuis le GGUF (moteur Jinja) pour les autres modèles ; ajouter / retirer un personnage en
cours de partie ; sauvegarder / restaurer le KV d'un fil sur disque pour les PNJ endormis ; budget par personnage.

## 17. Personnages endormis : plus de personnages que d'emplacements mémoire (2026-11-07, Sonnet)

`ws_moe_probe --npc-script profiles/npc_script5_fr.txt --slots 2 --state-dir <dir>` : 5 personnages, mais seulement
**2 caches KV en mémoire** (les "emplacements" du contexte). Un fil sans emplacement est **endormi** : son cache KV
est écrit dans un fichier (`llama_state_seq_save_file`) et restauré à son réveil (`..._load_file`) ; quand tous les
emplacements sont pris, le fil le moins récemment utilisé s'endort. Le scénario accepte `--- sleep nom` (sommeil
forcé) et `--- leave nom` (le fil disparaît, historique perdu). Un round avec plus de répliques que d'emplacements est
traité par groupes successifs.

Résultat (Gemma 4 26B-A4B, cache VRAM 1 Go, cache RAM WS 3 Go, 7 rounds, `reports/g4/seqs/npcs5.*`) :
- 9 mises en sommeil (36 à 52 Mo chacune, 355 Mo écrits au total, 0,5 s cumulées) et 7 réveils (0,2 s cumulées) :
  le coût est négligeable devant la génération (~6 tok/s au total) ;
- aucun fil ne perd son histoire : Maelle, endormie puis réveillée, redonne « Aldric » ; Brannoc se rappelle le nom
  donné plus tôt ; Lysa, endormie entre deux répliques, parle encore de son chat Pruneau ; les ton restent distincts ;
- mémoire : KV des 2 emplacements = 0,88 Go de VRAM (contre ~2,2 Go pour 5 fils tous vivants à ctx 2048) ; la
  RAM de travail (pic 6,4 Go) est dominée par le cache d'experts, pas par les fils ;
- le nombre de personnages n'est plus limité par la mémoire mais par l'espace disque (~40 Mo par fil à ce stade).
Limites : format de chat Gemma 4 écrit en dur ; pas de pré-réveil en tâche de fond (le réveil est synchrone, 0,03 s) ;
les fils endormis ne sont pas évincés du disque ; contexte par fil 2048 jetons, sans gestion de débordement.
Prochaine étape naturelle : format de chat lu dans le GGUF (moteur Jinja) pour LFM2/Qwen, puis API d'ajout /
retrait de personnages hors scénario (service local), sans toucher au cœur de llama.cpp.

## 18. Fils de personnages sur n'importe quel modèle (2026-11-07, Sonnet)

Le format de chat n'est plus écrit en dur pour Gemma 4 : `ws_moe_probe` utilise le moteur de gabarits Jinja de
llama.cpp (`common_chat_templates_*` de `llama-common.dll`, ajouté à `build-ws-tools.ps1` : include `common` et
`vendor`, lib `llama-common.lib`). À chaque réplique on rend tout l'historique (réflexion désactivée, fiche du
personnage en rôle `system`, repli sur "fiche collée à la 1re réplique" si le gabarit refuse `system`), puis on ne
préremplit que ce qui suit la dernière réponse stockée dans le KV. Si cette réponse n'est pas retrouvée dans le rendu,
le fil est reconstruit depuis son historique (compteur "thread rebuilds" en fin d'exécution : 0 dans tous les essais).

Même scénario (`profiles/npc_script5_fr.txt`, 5 personnages, `--slots 2`, 7 rounds, sommeil forcé de Maelle, départ de
Lysa) sur trois familles de modèles, sorties dans `reports/g4/seqs/npcs5_jinja.*`, `reports/lfm2/npcs5.*`, `reports/q36/npcs5.*` :

| Modèle | Fils | Écrit au sommeil | RAM pic | Mémoire des fils après sommeil |
|---|---|---|---|---|
| Gemma 4 26B-A4B | 5 / 2 emplacements | 355 Mo | 6,4 Go | oui, texte identique à la version à format écrit à la main |
| LFM2-8B-A1B (hybride convolution) | idem | 24 Mo | 2,4 Go | oui (Aldric, Pruneau, le loup) |
| Qwen3.6-35B-A3B (hybride Gated DeltaNet) | idem | 599 Mo | 5,8 Go | oui |

Les caches des modèles hybrides (états récurrents) se sauvegardent et se restaurent comme les caches KV classiques.
Qualité : LFM2 (1 milliard de paramètres actifs) tient moins bien son rôle (réponses plus floues, un personnage se
nomme lui-même Brannoc au lieu de dire son nom au joueur) que Gemma 4 et Qwen3.6, mais reste cohérent et garde la
mémoire de chaque fil. Pas de comparaison bit à bit entre modèles, ça n'aurait pas de sens.
Reste : réveil en tâche de fond, nettoyage des fils endormis, débordement de contexte, service local pour ajouter /
retirer des personnages hors scénario.

## 19. Travaux de fond reprenables (2026-11-07)
`ws_npc_server` : `/api/jobs` (voir `Docs/NPC_SERVER.md`). Journal de jetons + points de reprise KV atomiques + reprise
automatique au démarrage. Validé : kill -9 à 80/120 jetons puis relance = texte identique à un run ininterrompu (T=0) ;
pause/reprise par l'API idem. Pas encore fait : mesure sur un très gros modèle (l'intervalle de point de reprise y coûte
plus cher : KV de plusieurs centaines de Mo), reprise exacte à T>0 (état du générateur aléatoire non enregistré),
travail de fond qui laisse passer le chat (le moteur traite une requête à la fois).

## 20. Dossiers par modèle et pré-caches (2026-11-07)
`ws_npc_server` : données par modèle sous `data/models/<id>/` ; recettes de pré-caches (`data/precaches/`) avec politiques
`startup` / `first_use` / `manual` et `keep`. Prompt de 2361 jetons : 38,9 s -> 1,7 s. Corrections : le réveil d'un fil
dormant se fait avant de décider du préremplissage rapide (sinon reconstruction inutile du contexte). À faire : volet
« Modèles et pré-caches » dans l'interface, test de `keep:false` à l'arrêt propre, migration des anciennes données
(`data/state`, `data/threads.json`, `data/expert_sheets.wssheets` ne sont plus lues).

## 21. Politique de stockage des pré-caches (2026-11-07)
Plafond (défaut 1 Go), conseils d'inactivité, suppression avec aperçu, épinglage, nettoyage au lancement
(`auto_clean`, exceptions : modèle courant, dernier modèle utilisé, épinglés), volet « Modèles et pré-caches ». Voir
`Docs/NPC_SERVER.md`. Seuls les états de pré-caches comptent dans le plafond (pas les états de fils de personnages).
Effacer un pré-cache du modèle courant dont la recette vise un fil de personnage efface aussi l'état de ce fil
(régénéré depuis l'historique).

## 22. Résumé glissant et précision du cache KV (2026-11-07)
Voir `Docs/NPC_SERVER.md` : résumé en tâche de fond (visible/éditable), historique complet conservé ; `--kv-type` (q8_0
-47 %, q4_0 -72 % de KV, texte différent : pas lossless). Pistes non faites : index vectoriel des anciens échanges,
résumé hiérarchique, K en q8_0 et V en f16 (à mesurer séparément), mesure de la VRAM réellement économisée (seule la taille
de l'état enregistré a été mesurée).

## 23. Appels d'outils pour les outils agentiques (2026-11-07)
`/v1/chat/completions` : `tools`/`tool_choice`, messages `tool_calls`/`tool`, sortie analysée en `tool_calls` (voir
`Docs/NPC_SERVER.md`, section « Outils agentiques »). Mode flux avec outils = message complet d'un bloc. Non fait : flux
incrémental des appels, génération contrainte par grammaire, clé de fil stable pour les agents dont le prompt système varie,
test réel avec OpenCode. L'interface affiche maintenant le temps de réponse sous chaque message.

## 24. Profils adaptatifs (2026-11-07)
`partage` et `fond` (fonction `apply_adaptive` dans `tools/npc_server.cpp`) : tailles de caches calculées au chargement
d'après la RAM disponible (`GlobalMemoryStatusEx`) et la VRAM libre (`ggml_backend_dev_memory`). Qwen3-Coder-Next 48,5 Go
re-téléchargé (`C:\llm-models\`) ; Qwen3.6 et Gemma 4 supprimés pour la place (Gemma 4 à retélécharger :
`unsloth/gemma-4-26B-A4B-it-GGUF`). Mesures dans `Docs/NPC_SERVER.md`. Non fait : tenir compte de `n_ctx` dans la réserve de
VRAM (le calcul suppose un petit contexte), test avec OpenCode.

## 25. Qwen3-Coder-Next 48,5 Go : llama.cpp ordinaire vs WeightStream (2026-11-07)
**Sans limite de mémoire** (16 Go de RAM disponible, prompt de code de 200 jetons) : llama.cpp ordinaire `--n-cpu-moe 40`
(fichier mappé, 8 couches d'experts en VRAM) fait 3,6 tok/s à froid puis **11,8 tok/s** (chaud), contre 5,9 tok/s pour
WeightStream « à fond ». Le modèle de 48 Go tourne donc sans WeightStream (le mmap suffit) : il n'est pas « refusé ».
`--cpu-moe` seul : 2,6 puis 3,3 tok/s. Biais : un seul prompt répété (routage identique), CPU non mesuré.
**Sous plafond dur + limiteur** (`CAPPED=1 HOGTOO=1 scripts/ladder-moe.sh`, 64 jetons, `ws_moe_probe`, « stock » = llama.cpp
avec cache VRAM) :

| VRAM cache / RAM dispo | stock | WeightStream (cache RAM) | texte |
|---|---|---|---|
| 6 Go / 8 Go | 1,10 tok/s | 3,63 tok/s (4,5 Go, pic 6,2 Go) | identique |
| 4 Go / 5 Go | 1,22 tok/s | 2,37 tok/s (1,5 Go, pic 3,6 Go) | identique |

Conclusion provisoire : l'avantage de WeightStream apparaît quand la RAM est réellement limitée (x2 à x3), pas quand
l'OS a de la RAM libre pour mettre le fichier en cache. Une seule mesure par ligne ; le comparateur `--n-cpu-moe` n'a pas
été passé sous plafond.

## 26. GGUF en plusieurs fichiers (2026-11-07)
`ExpertStore::open` accepte le premier fichier d'un modèle découpé (`name-00001-of-0000N.gguf`) et ouvre tous les fichiers
(un handle par fichier, `TensorEntry::shard`). Une lecture alignée qui dépasse la fin d'un fichier est acceptée si les octets
utiles sont là (`Pending::need`). `ws_npc_server` compte un modèle découpé comme un seul (taille totale, un seul élément dans
la liste). Test : LFM2-8B-A1B découpé en 4 par `llama-gguf-split` : texte identique au fichier unique (hash `3b81bb463367bde0`),
même pic de mémoire (1513 Mo), plus de repli sur le mmap. `llama-gguf-split` se compile avec
`scripts/build-llama.ps1 -Targets llama-gguf-split`. Pas encore testé sur un très gros modèle (prévu : GLM-4.5-Air Q4_K_M, 68 Go).

### 26.1 GLM-4.5-Air Q4_K_M (68 Go, 2 fichiers, ~12 Md de paramètres actifs) sous plafond de RAM
`CAPPED=1 HOGTOO=1 RSUB=2500 scripts/ladder-moe.sh <modèle> reports/glm_capped2 32` (32 jetons, `ws_moe_probe`, « stock » =
llama.cpp avec cache VRAM) : 8 Go de RAM dispo : stock 0,14 tok/s, WeightStream 0,72 (x5) ; 5 Go : 0,14 contre 0,57 (x4) ; prompt
0,27 contre 1,0 tok/s. Texte identique (hash `c50ad4fb48246596`). Piège : le banc utilise `ws_moe_probe.exe` (sans suffixe) :
le recompiler après un changement de `ExpertStore`, sinon WeightStream retombe en silence sur le mmap (message « fetch failed,
falling back to mmap » dans la sortie). Limite : un cache RAM trop petit pour un lot d'experts (1,5 Go avec ubatch 32 sur ce
modèle) échoue avec « RAM cache too small for one fetch ». Serveur, profil « à fond », sans plafond : 0,72 tok/s. La réserve de
RAM du profil « à fond » comptait la RAM disponible sans la mémoire propre du processus (RAM libre tombée à 0,5 Go) : +2500 Mo.

### 26.2 Chargement progressif, profil « partagé » sur le GLM (2026-11-08)
Cause du « burst » mémoire au chargement d'un gros modèle : llama.cpp appelle `PrefetchVirtualMemory` sur tout le fichier mappé,
et `WEIGHTSTREAM_NO_PREFETCH` n'était posé que pour `--cpu-stream`. Sur le chemin cache GPU les experts (~65 Go sur 68) ne sont
jamais lus depuis le mappage : la variable est maintenant posée dès que le streaming est actif (`ws_npc_server`). Mesure
(profil `partage`, `-c 4096`, garde-fou : arrêt si mémoire « disponible » < 1,5 Go) : avant, disponible tombé à 142 Mo au
chargement (arrêt) ; après, minimum 5141 Mo au chargement et 4802 Mo en génération, 0,80 tok/s, CPU 8,9 % en moyenne (max 15 %),
GPU 34 % (max 47 %), VRAM max 12068 Mo. Le CPU est donc presque inactif : marge pour du calcul d'experts CPU en parallèle.
Réserves : la mémoire disponible a baissé de ~11,5 Go pour un cache de 5,5 Go (le reste = poids non-experts, tampons, KV) alors
que `apply_adaptive` prévoit 2,5 Go de surcoût : sous-estimé pour ce modèle ; la VRAM est presque pleine. Les réserves de
`apply_adaptive` sont maintenant proportionnelles à la RAM totale (25 % partagé, 12,5 % à fond) et le plafond fixe de 20 Go a été
retiré. À ne pas refaire : tests avec limiteur de RAM global (`ws_mem_hog`) + plafond dur sur un gros modèle (a gelé le PC).

## 27. Étude : calcul d'experts sur le CPU en parallèle du GPU (2026-11-08, étude, rien d'implémenté)
**Question :** pendant la génération d'un gros modèle le CPU est à ~9 % et le GPU à ~34 % : peut-on les faire travailler ensemble ?
**Chemin actuel (GPU, `llama-moe-cache.cpp` + patch) :** par couche : le GPU calcule le routage, les identifiants d'experts reviennent
à l'hôte (synchronisation), le cache planifie les ratés, `ExpertStore` lit les experts manquants (RAM ou SSD), ils sont envoyés
en VRAM, puis le GPU calcule tout `mul_mat_id`. Le CPU ne fait que orchestrer.
**Ordre de grandeur sur le GLM-4.5-Air Q4_K_M** (en-têtes du GGUF) : un expert = gate 3,09 + up 3,09 + down 5,84 (Q8_0) = **12,0 Mo** ;
8 experts utilisés par token et par couche, 46 couches MoE : jusqu'à ~4,4 Go lus par token si tout manquait. SSD mesuré : 2,1-2,3
Go/s en lectures aléatoires de taille d'expert (§ matériel) → ~2,0 s par token, soit ~0,5 tok/s sans aucun succès de cache. Mesuré :
0,72-0,80 tok/s, ce qui correspond à ~35 % de succès de cache. **La génération est donc limitée par le débit du SSD** (calcul
indicatif, hypothèse d'un SSD à 2,2 Go/s ; à confirmer par une mesure directe du débit disque pendant la génération).
**Conclusion :** faire calculer des experts par le CPU ne réduit **pas** les octets lus sur le SSD ; le calcul d'un expert est
minuscule devant sa lecture (~140 M multiply-add par couche contre ~96 Mo lus). Gain attendu faible pour ce modèle. Là où le calcul CPU aide
(llama.cpp `--n-cpu-moe` : 11,8 tok/s sur le Qwen 48 Go sans plafond), c'est que les experts RESTENT en RAM (cache de fichiers de
l'OS, 32 Go) et sont calculés sur place sans passer par le PCIe : cela marche quand le modèle (ou son jeu chaud) tient en RAM.
**Pistes qui réduisent réellement les octets lus :** (1) plus de cache RAM (au détriment du partage), (2) meilleure politique
(fréquence, fiches de domaine), (3) décodage spéculatif / lots de tokens (les experts lus servent plusieurs tokens ; gain incertain
avec un MoE), (4) préchargement de la couche suivante pendant le calcul (le SSD est déjà presque toujours occupé : gain limité),
(5) SSD plus rapide (un NVMe PCIe 4 ~ x2-3). Le calcul CPU n'est pertinent que pour les modèles dont le jeu chaud tient en RAM.

### 26.3 Réserve calculée sur la taille réelle des poids non-experts (2026-11-08)
`apply_adaptive` lit les en-têtes du GGUF (`non_expert_bytes`) : surcoût RAM = poids non-experts + 1 Go (GLM : 4,96 Go), surcoût VRAM = 0,8 x
non-experts + 700 Mo. Profil `partage` sur le GLM, 16,8 Go disponibles au départ : caches 2 395 Mo RAM / 4 989 Mo VRAM ; mémoire
disponible minimale 9 026 Mo au chargement et 7 883 Mo en génération (la réserve visée, ~8 Go, est tenue) ; VRAM max 10 798 Mo (1,5 Go de
marge) ; 0,64 tok/s ; GPU 31 % en moyenne. C'est le prix du partage : 0,80 tok/s avant (marge RAM 4,8 Go, VRAM 0,2 Go).

## 28. Régulateur de mémoire (2026-11-08)
`Engine::governor_tick` (`tools/npc_server.cpp`), appelé entre deux `llama_decode` (génération et prefill), s'appuie sur
`ExpertStore::resize`. Mesures sur le GLM-4.5-Air, profil `partage` : marge 4 Go, cache initial 7,4 Go -> 10,4 Go en 9 pas, mémoire
disponible stabilisée vers 4,5 Go (minimum 3,2 Go), 0,74 tok/s ; marge 26 Go (force les pauses) : cache à son plancher de 2 Go,
mémoire disponible ~12,9 Go, 0,59 tok/s (pauses non journalisées). Défaut trouvé : avec une marge de 18 Go le cache calculé
tombait à 700 Mo, trop petit pour une couche du GLM (~1,5 Go) : repli de WeightStream sur le mmap et mémoire disponible tombée
à 536 Mo (arrêt par le garde-fou). Correctif : plancher de 2 Go (`apply_adaptive` et `Governor::floor_cap`). À faire : empêcher
le repli sur le mmap d'avaler la RAM quand un lot dépasse le cache (c'est la vraie cause), journaliser les pauses, tester sur
une vraie variation de charge (un programme lourd qui démarre pendant la génération).

## 29. Vitesses mémoire + priorisation vivante des experts (2026-11-08)
Code : `gear_margin_mib`, `Governor::other_cpu`, `Engine::update_gear` (marge fixée par la vitesse ; auto = CPU des autres programmes, montée instantanée / descente lente), seuil dur
`hard_floor_mib` ; `Engine::live_add/live_tick` (poids décroissants par expert, re-épinglage via `ExpertStore::set_profile`). Test sur Qwen3-Coder-Next 48,5 Go en auto, 300 tokens :
vitesse effective passée de 3 à 3,9 (CPU occupé par d'autres programmes à 41 %), cache RAM de 6,8 à 8,9 Go, 2 re-épinglages, 2606 experts prioritaires, 4,5 tok/s à froid.
Pas mesuré : le gain de vitesse des experts prioritaires (à comparer sur un long travail à froid), le comportement de l'auto sous une charge CPU lourde lancée en cours de génération.

## 30. `/v1/decide` + le décideur v3 en BF16 (2026-11-08)
Endpoint ajouté (`Sampling::peek` lit les logits juste avant l'échantillonnage). Modèle : `surogate/rune-26b-a4b` v3 (Gemma 4 26B-A4B affiné, 128 experts dont 8 actifs, Apache 2.0, dépôt à accès
restreint : fichiers téléchargés à la main par l'utilisateur dans `C:\llm-work\rune`), converti avec `convert_hf_to_gguf.py --outtype bf16` dans un venv propre (`C:\llm-work\venv`, le Python global a
scipy/sklearn cassés par NumPy 2) -> `C:\llm-models\Decider-v3-26B-A4B-BF16.gguf` (50,5 Go). Tourne tel quel avec le streaming d'experts. Mesures (cache RAM ~4 Go, tout le reste lu sur le SSD) :
`letter_mass` 0,999 (lecture fiable) ; 1 question : 33 s à froid, 1,5 s si le même prompt est redemandé (préfixe KV) ; 3 questions sur un nouvel état : 55 s ; ~147 Go lus sur le SSD pour 3 appels.
Le BF16 est la référence exacte mais lent ; Q8/Q4 (~27/16 Go) tiendraient presque en RAM : à produire (`llama-quantize` pas encore compilé) et à comparer aux probabilités du BF16.
Non évalué : justesse des décisions sur des cas réels, sensibilité à la formulation.
Quantifications produites avec `llama-quantize` (compilé via `build-llama.ps1 -Targets llama-quantize`) : `Decider-v3-26B-A4B-Q4_K_M.gguf` (15,6 Go), `Decider-v3-26B-A4B-Q8_0.gguf` (25 Go). Même cas (gobelin, 3 questions), BF16 / Q8 / Q4 :
réponses identiques (Attaquer, danger 3, coincé oui), probabilités à ±0,05-0,08 près (Attaquer 0,54 / 0,52 / 0,50 ; le même cas rejoué avec un préfixe KV différent bouge déjà de ~0,05 : bruit numérique
du même ordre), `letter_mass` > 0,996 partout. Temps (cache RAM par défaut, partagé) : 3 questions 55 s (BF16) / 13 s (Q8) / 3,4 s (Q4, après une première question à 17,5 s à froid).
Un seul cas testé : la justesse sur de vrais cas de jeu reste à évaluer avant de conclure que le Q4 suffit.

## 31. Idées reprises de kimi-k3-in-c (2026-11-16)
Dépôt lu : https://github.com/FareedKhan-dev/kimi-k3-in-c (C99, CPU, un seul modèle MoE de 2,78 T ; chiffres publiés par l'auteur dans `docs/data/`, **non vérifiés ici**).
Ce qui existe déjà chez nous : lots dédupliqués par couche (`plan()` ne garde que les experts distincts du ubatch ; au-delà de 32 jetons le cache est contourné, un gros lot touche presque tout), politique CRF (récence + fréquence) et pas du LRU pur, reprise de conversation (fils qui dorment), échelle mémoire à plafond dur (`ws_run_capped`).
Ce qui est repris : **trace d'accès + simulateur** (`WS_TRACE=<fichier>` écrit [couche, n_jetons, n, experts...] à chaque `plan()` ; `tools/sim_cache.py trace.bin --slots ... --expert-mib 12` compare LRU / LFU / Belady, le plafond optimal). But : savoir de combien une meilleure politique peut encore faire monter le taux de succès AVANT de la coder (piste (2) du §27).
**Fait :** crochet `WS_TRACE` dans `llama-moe-cache.cpp` + patch régénéré ; simulateur testé sur une trace synthétique (Zipf). **Pas fait :** recompilation de llama.dll (un `llama-server` tournait, il verrouille les DLL) et aucune trace réelle enregistrée. À faire : `build-llama.ps1`, `build-ws-tools.ps1`, lancer `ws_npc_server` avec `WS_TRACE=C:\llm-work\trace.bin`, générer ~500 jetons, puis simuler. Leur préfixe de couches épinglées (un parcours cyclique bat LRU) ne concerne que les modèles denses plus gros que la machine : non testé.

## 32. Prefill en « tapis roulant » : lots énormes + lecture séquentielle des couches (2026-11-17)
**Diagnostic.** `--prefill-ubatch 4096` ne faisait rien d'utile : la boucle de prefill de `npc_server` appelait `llama_decode` par paquets de **512** jetons (`n_batch = 512`) quel que soit l'ubatch. Un paquet de 512 jetons touche presque tous les experts de chaque couche (5120 choix sur 512 experts), donc **chaque paquet relit tout le modèle** (~48 Go, 8 paquets pour 4010 jetons = ~390 Go lus, ~1,2 Go/s en lectures par expert de ~0,6 Mo : 318 s). Le « 990 s » du 4096 venait en plus d'un contexte 4096 pour des paquets de 512. Chronomètres (`WS_PROF`, base 1061 jetons) : lecture des experts 65 s, envoi PCIe 11 s, attentes 7 s sur ~105 s.
**Correctif 1 (`npc_server`)** : `n_batch = max(512, ubatch)` et la boucle de prefill avance par `prefill_ubatch` quand le contexte est « boosté » : un prompt de 4010 jetons = **un seul passage** sur le modèle. À lui seul (ancien chemin de lecture, expert par expert) : 75,8 s au lieu de 318 s.
**Correctif 2 (tapis roulant)** : `ExpertStore::bulk_read` (lectures non tamponnées séquentielles de 4 Mo, fenêtre de 24) + dans `llama-moe-cache.cpp` `bulk_upload` : quand un lot utilise au moins la moitié des experts d'un tenseur, le tenseur entier est lu d'un trait par un thread lecteur qui reste 2 tenseurs d'avance (anneau de 3 tampons épinglés de ~330 Mo, ~1 Go de RAM épinglée, rendu au retour en génération), puis `cudaMemcpyAsync` vers la copie du planificateur. Génération et petits lots : inchangés. Option `--bulk-prefill on|off` (défaut on), variable `WS_NO_BULK=1` ; `--prefill-ubatch` défaut passé de 512 à **4096**.
**Mesures** (Qwen3-Coder-Next Q4_K_M, prompt 4010 jetons, `--ws-ram-mib 9000 --cache-mib 7500 --mem-margin-mib 2500`, état de threads neuf à chaque essai) :
| config | prefill | jetons/s |
|---|---|---|
| départ (ubatch 512, paquets de 512) | 318 s | 12,6 |
| un seul passage, lecture par expert (`--bulk-prefill off`, ubatch 4096) | 75,8 s | 52,9 |
| un seul passage + tapis roulant | **34,9 s** (2e essai : 53,9 s, charge de la machine variable) | **115** (74 au 2e essai) |
Le tapis roulant n'attend plus que ~0,8 s les lectures (les 40 Go sont lus à l'avance) : le prefill est maintenant limité par le calcul GPU. Pic RAM du processus ~5,4 Go (contre ~12,5 Go avec la lecture par expert, qui remplit le cache RAM), VRAM du système max 11,6 Go (dont ~1,5 Go pour un autre programme). **Sans perte** : même texte sur le même prompt glouton (« Ce module gère l'orchest… ») pour l'ancien chemin et le nouveau à ubatch égal ; les octets envoyés au GPU sont ceux du fichier. Non fait : comparaison avec llama.cpp pur sur un petit MoE, génération longue de comparaison (8 jetons seulement).
**Pièges** : (1) le dossier de données de `ws_npc_server` garde les fils (KV) entre deux lancements : un prompt qui partage un préfixe avec un précédent n'est plus « boosté » et fausse les mesures, utiliser un `--data-dir` neuf ; (2) `--prefill-ubatch 4096` demande plus de VRAM pendant le prefill (tampons de calcul) : le baisser sur une petite carte ; (3) l'échappement `\n` dans les scripts Python lancés depuis le shell du harnais se perd : utiliser l'outil d'édition.

## 33. Les experts du prefill prédisent-ils ceux du decode ? Mesure (2026-11-17, rien d'implémenté côté moteur)
**Question.** Précharger le cache VRAM avec les experts les plus fréquents pendant la lecture du prompt réduit-il les lectures pendant l'écriture ?
**Protocole.** Qwen3-Coder-Next Q4_K_M (48 couches, 512 experts, 10 par jeton), `ws_npc_server` avec `--data-dir` neuf, prompt 3674 jetons (`index.html` + `style.css` + `game.js` + `README.md` de TEST-PONG-PAIZ + consigne de modification), 300 jetons générés (température 0), un seul passage de prefill. Mesure seulement : nouvelle trace `WS_TRACE_IDS=<fichier>` (dans `sched_copy_experts`, `llama-context.cpp` : tous les choix de routage du lot, jeton par jeton ; le prefill en gros lot ne passe pas par `plan()`, donc `WS_TRACE` n'en voit rien) + `WS_TRACE` existant pour le decode. Analyse : `tools/prefill_vs_decode.py` (lancé depuis le dossier de la trace). Limites : la dernière couche (47) ne voit que le dernier jeton au prefill (lignes de sortie seules), donc 47 couches analysées ; **un seul prompt, un seul domaine (code JS)**, 300 jetons ; taille d'expert supposée 1,9 Mio ; « cache » simulé = une part égale du budget par couche, LRU (pas la politique CRF réelle).

**Part des accès decode qui tombent dans les N experts les plus fréquents du prefill (par couche) :**
| N (par couche) | hasard | prefill, tous les jetons | 256 derniers jetons | pondération croissante | oracle (top du decode lui-même) |
|---|---|---|---|---|---|
| 5 % (25) | 5 % | **37,0 %** | 35,4 % | 37,2 % | 46,1 % |
| 10 % (51) | 10 % | **48,4 %** | 44,9 % | 48,7 % | 61,8 % |
| 25 % (128) | 25 % | **69,1 %** | 63,3 % | 69,4 % | 84,5 % |
| 50 % (256) | 50 % | **88,5 %** | 81,3 % | 88,9 % | 97,7 % |
La corrélation est **loin du hasard** (7x à 5 %) et proche de l'oracle (80 % de sa couverture à 5-10 %). Les 256 derniers jetons font moins bien que tous ; la pondération croissante ne change rien. Une part de cette corrélation est sans doute la popularité générale des experts (ils sont très inégaux), pas du « contexte » : non séparé ici (il faudrait un second prompt d'un autre domaine).

**Taux de miss du decode, cache simulé (LRU par couche) démarré à froid vs préchargé avec le top-fréquence du prefill :**
| budget | slots/couche | miss à froid | miss préchargé (tous) | préchargé (256 derniers) | cache figé sur le top prefill | gain Mo/jeton moyen sur 300 jetons |
|---|---|---|---|---|---|---|
| 1 Go | 11 | 69,20 % | 69,17 % | 69,14 % | 72,8 % | 0,35 |
| **2 Go** | 22 | **50,26 %** | **50,19 %** | 50,10 % | 64,3 % | **0,67** |
| 4 Go | 45 | 35,32 % | 35,14 % | 34,90 % | 53,6 % | 1,64 |
| 7,5 Go (réel) | 86 | 21,48 % | 20,97 % | 20,39 % | 40,4 % | 4,60 |
Un cache LRU se remplit tout seul en quelques jetons : le préchargement ne gagne que sur les ~20 premiers jetons (à 7,5 Go : miss 35,7 % -> 29,4 % sur les 20 premiers, identique ensuite 20,5 % vs 20,4 %). Garder le top du prefill **figé** est nettement pire que LRU (64 % contre 50 % à 2 Go) : même l'oracle statique (top du decode lui-même, 22/couche) ne couvre que 43,6 % des accès contre 49,7 % pour le LRU, le decode est trop mobile pour un contenu fixe.

**Verdict : NON, ne pas implémenter le préchargement par fréquences.** Les experts du prefill prédisent bien ceux du decode (pas du hasard), mais le gain est un coup unique de ~1 à 7 Mo/jeton moyen sur 300 jetons (≈ 0,3 à 2 % des ~200 Mo/jeton lus), absorbé par le LRU/CRF en quelques jetons, et l'ancrage statique perd. Seul cas où cela vaudrait la peine : réponses très courtes (< 20 jetons) après un long prefill (quelques secondes gagnées au mieux). Fichiers : trace brute et sorties dans `C:\llm-work\trace\` (hors dépôt, `ids.bin` 6,9 Mo, `t.bin`, `an.out`). Aucun processus `ws_npc_server`/`llama-server` laissé en vie.

## 34. Décodage spéculatif sans brouillon (prompt-lookup / n-gramme) : mesure (2026-11-17, rien d'implémenté dans la boucle)
**Question.** Pour des tâches de code d'agent (modifs ciblées), chercher les prochains tokens dans le contexte (dernier n-gramme, n = 2..4) puis les vérifier en un seul lot greedy donne-t-il un gain en tokens/s sur ce moteur ? (Sortie identique : en greedy, seuls les tokens vérifiés sont gardés.)

**1. Taux de réutilisation (simulation hors ligne, `tools/spec_lookup_sim.py`, tokenizer du modèle via `tools/tok_ids.cpp`).** Données : TEST-PONG-PAIZ `fc7ba93`->`aa7f7db` (game.js +53/-8, index, README) puis `aa7f7db`->`fb9e946` (1 ligne). Contexte = les 4 fichiers au commit de départ (3061 / 3601 jetons) + sortie déjà écrite ; brouillon = suite du dernier n-gramme le plus récent. (A) = seulement les lignes ajoutées (668 jetons, optimiste sur le « nouveau » : pas de contexte) ; (B) = appel d'outil `edit` JSON avec old_string (copie verbatim du fichier) + new_string (2421 jetons, cas le plus favorable).
| cas | brouillon k | n | jetons/pas (sortie par passage) | taille moyenne du lot de vérif. |
|---|---|---|---|---|
| A | 4 | 2 / 3 / 4 | 1,54 / 1,40 / 1,28 | 3,04 / 2,11 / 1,67 |
| A | 8 | 2 / 3 / 4 | 1,60 / 1,43 / 1,30 | 4,87 / 3,08 / 2,22 |
| B | 4 | 2 / 3 / 4 | 2,15 / 1,96 / 1,78 | 3,53 / 2,80 / 2,36 |
| B | 8 | 2 / 3 / 4 | 2,46 / 2,17 / 1,96 | 5,59 / 4,13 / 3,20 |
Part de jetons acceptés : 22-38 % (A), 44-59 % (B). Le code réellement nouveau (A) donne peu, la copie d'ancien texte (B) beaucoup. Deux seuls commits : peu de données.

**2. Coût de vérification sur le moteur.** Crochet de mesure, inactif par défaut : `WS_GEN_IDS=<fichier>` (journal des ids générés) et `WS_BATCH_TEST=K` + `WS_BATCH_SCRIPT=<ids>` (rejoue la suite greedy connue, K jetons par `llama_decode`, tout « accepté ») dans la boucle de génération de `npc_server.cpp`. Binaire `ws_npc_server_bt.exe`. Prompt 3673 jetons (même que §33), `--data-dir` neuf, 192 jetons greedy, mêmes réglages, un seul essai par K (bruit machine possible, ±5 %) :
| lot K | temps de génération (192 jetons) | ms/jeton | ms/pas | coût d'un pas vs K pas à 1 | experts distincts/couche/pas (sur 10·K) |
|---|---|---|---|---|---|
| 1 | 43,2 s | 225 | 225 | 1,00 | 10 |
| 4 | 39,9 s | 208 | 832 | 0,92 | 27,2 (68 %) |
| 8 | 37,9 s | 197 | 1577 | 0,88 | 44,5 (56 %) |
Les experts de jetons successifs se recouvrent (union de 8 jetons = 56 % de 80), donc les **lectures par jeton baissent d'environ 45 %** à K = 8, mais le **temps par jeton ne baisse que de 12 %** : un lot de 8 coûte ~7 fois un pas, pas ~2. Le pas à 1 jeton n'est donc pas dominé par la latence de lecture seule ; le reste (envois/placement des experts par jeton, calcul par expert) croît avec le nombre de jetons. Non mesuré : octets lus en génération seule (`/health` ne répond pas pendant la génération ; le compteur global est dominé par le prefill, ~27,4 Go dans les 3 essais), et le surcoût d'un brouillon **refusé** (experts de jetons rejetés lus pour rien : le chiffre ci-dessus est un meilleur cas, tout accepté).

**3. Gain net.** Modèle : coût d'un pas de lot b ≈ b × (225 → 197 ms, interpolé), débit = jetons/pas ÷ coût du pas, base 225 ms/jeton (4,4 tok/s).
- Avec le surcoût réel de relecture : cas B k=4 n=2 : 2,15 jetons pour ~750 ms = 0,65x ; B k=8 n=2 : 0,49x ; B k=4 n=4 : 0,79x ; A k=4 n=4 : 0,78x. **Tous les cas sont plus lents que la génération normale** (jetons acceptés par pas < taille du lot vérifié, et le lot coûte presque linéairement).
- Sans surcoût (hypothèse : un pas coûte toujours 225 ms) : 1,3x (A) à 2,5x (B) maximum. Ce n'est pas ce que le moteur fait aujourd'hui.

**4. Verdict : NON, ne pas brancher.** Le décodage par lots est presque linéaire sur ce moteur (-12 % par jeton à K = 8), alors qu'il faudrait un lot quasi gratuit pour que 1,3-2,5 jetons par pas rapportent. Le gain ne deviendrait positif que si le coût par jeton d'un lot chutait fortement (p. ex. lot de 8 à moins de ~3 pas), ce qui demanderait de refaire le chemin de lot en génération (placement/envoi des experts dédupliqués par couche au lieu de par jeton), pas la spéculation elle-même. Pistes si on rouvre : mesurer d'abord la décomposition du temps d'un lot de 4 avec `WS_PROF` ; ne spéculer que quand le brouillon est long (copie d'un bloc, n = 4, brouillon >= 8) pour limiter les rejets.
**Où brancher, si un jour oui** : `tools/npc_server.cpp`, `generate_locked`, boucle `for (int i = 0; ... max_new ...)`, au point où `b.token[0] = id` construit le lot d'un jeton (juste avant `decode_bound(b)`) : chercher dans `th.tokens` (contexte complet) la suite du dernier n-gramme, construire un lot [id, brouillon...] avec `logits=true` partout, échantillonner à chaque position (`llama_sampler_sample(smpl, ctx, j)`, seulement si température 0), accepter tant que le jeton échantillonné égale le brouillon suivant, puis `llama_memory_seq_rm(mem, seq, pos_acceptée, -1)` et tronquer `th.tokens` pour les rejets ; mettre à jour `llama_sampler_accept`, `completion_tokens`, `pending/full`/stop pour chaque jeton accepté (la sortie par flux et la détection de stop passent aujourd'hui par un jeton à la fois). Le crochet `WS_BATCH_TEST` juste avant montre le squelette d'un lot de K jetons (positions, `seq_id`, `th.tokens`).
Fichiers : `tools/spec_lookup_sim.py`, `tools/tok_ids.cpp` (compiler comme `ws_tok_tmp`), `tools/spec_batch_overlap.py` (lancé dans le dossier des traces `t{1,4,8}.bin`) ; traces et journaux bruts dans `C:\llm-work\specbatch\`. Aucun processus `ws_npc_server` laissé en vie.


## 35. Recouvrir lecture et calcul en génération : « lookahead » du routeur (2026-11-17)
**Question.** Réduire le temps par token de la génération (Qwen3-Coder-Next Q4_K_M, 4,3 tok/s au départ) en recouvrant lecture SSD / copie / calcul GPU, sans changer le texte.
**Piste 1 (lectures asynchrones, plusieurs en vol) : déjà acquise, rien à gagner.** `ExpertStore::fetch` lance déjà toutes les lectures manquantes d'une couche d'un coup (`read_all` : chaque `ReadFile` en recouvrement avant la première attente). Le SSD donne ~1,3-2 Gio/s à 4-8 lectures en vol et plafonne à ~2,1 Gio/s (`ws_ssd_probe`) : on lit à ~1,1-1,4 Go/s, donc plus de requêtes n'apportent au mieux que quelques %. Le vrai problème est la dépendance : les ids de la couche N ne sont connus qu'après le calcul de N-1, donc sans prédiction lecture et calcul ne peuvent pas se recouvrir. Mesure WS_PROF (run chaud, 10 tokens) : ~0,95 s dont ~0,55 s de lecture source, ~1000 experts relus du SSD (~650 Mo), GPU vide pendant ces lectures.
**Piste 2 : prédire la couche suivante.** (a) Co-occurrence apprise couche->couche à partir des ids : **inutile** (couvre 2 % des ratés avec 10 candidats sur 512 = hasard ; `C:\llm-work\ovl\pred.py`). (b) **Routeur en avance** : le routeur de la couche N+d (`ffn_gate_inp`, F32) appliqué à l'entrée du routeur de la couche N (le flux résiduel change lentement) : `ggml_mul_mat` + `ggml_argsort_top_k` dans le graphe GPU (`llama-graph.cpp`, `build_moe_ffn`, nœud `moe_look`, calculé dans la même tranche que les ids, coût négligeable), lu avec les ids dans `copy()` (une seule synchronisation). Rappel mesuré (distance 1, K = 10/12/16/20 prédits) : 82/88/94/97 % des experts choisis, **75/84/92/95 % des experts absents de la VRAM** ; distance 2 : 67-75 % à K = 10-12. Les experts prédits et absents de la VRAM sont lus d'avance par le thread de fond de l'`ExpertStore` (`prefetch`, SSD -> cache RAM, protégé contre l'éviction des couches en cours) via le nouveau hook `llama_moe_set_expert_prefetch` ; **rien n'est imposé au routeur** : un expert mal prédit est simplement relu à la demande (lossless).
**Option** : `ws_npc_server --lookahead N[:D]` (N experts prédits, D couches d'avance, défaut D = 1 ; `0` = désactivé, **défaut désactivé**) ; API `llama_moe_set_lookahead(n, distance)`, variable `WS_LOOK` (valeur initiale). Génération seulement, un jeton par lot ; le prefill n'est pas touché.
**Mesures** (prompt 3695 jetons, 200 jetons gloutons, `--ws-ram-mib 9000 --cache-mib 7500 --mem-margin-mib 2500 -c 6144`, `--data-dir` neuf, 2 essais par config, binaire `ws_npc_server_ovl`, ids générés comparés à la référence) :
| config | temps de génération (200 jetons) | ms/jeton | tok/s | sortie identique |
|---|---|---|---|---|
| sans lookahead (5 essais) | 32,3-33,7 s | ~165 | ~6,0 | référence |
| 16:1 | 31,6 / 32,8 s | ~160 | 6,2 | oui |
| 16:2 | 30,6 / 31,6 s | ~156 | 6,4 | oui |
| 16:3 / 16:4 | 30,8 / 32,5 ; 30,8 / 32,4 | ~158 | 6,3 | oui |
| 24:2 (trop de lectures inutiles) | 37,5 / 38,6 s | 190 | 5,3 | oui |
| 12:2 | 29,0 / 29,7 s | 147 | 6,8 | oui |
| 8:2 / 6:2 | 27,3 / 28,4 ; 28,6 / 29,3 s | ~140-145 | ~7 | oui |
| **10:1** | 26,8 / 28,7 s | ~138 | 7,2 | oui |
| **10:2 (recommandé)** | **26,8 / 27,1 / 27,3 s** | **~135** | **7,4** | **oui** |
| 10:3 | 28,3 / 27,9 s | 141 | 7,1 | oui |
Gain mesuré **~19 % de temps de génération** (33,3 -> 27,1 s ; 6,0 -> 7,4 tok/s) à K = 10, D = 2, texte identique (ids et texte comparés sur 200 jetons). Les lectures SSD à la demande passent de ~1000 à ~460 par 10 tokens, 0,59 -> 0,35 s de lecture (le reste est déjà arrivé ou attendu en vol : 0,06 s d'attente). Pics (échantillonnés toutes les 4 s, un essai chacun) : RAM du processus 12,5 Go sans / 12,7 Go avec ; VRAM du système 10,26 / 10,24 Go : **inchangés** (le préchargement réutilise les emplacements du cache RAM existant, aucun tampon en plus). Les chiffres absolus de la ligne de base (~165 ms) sont meilleurs que le « 230 ms » du départ parce que la machine était dans un état plus chaud (cache RAM ~16 Go grandi par le régulateur) : seuls les comparatifs de ce tableau (mêmes conditions, alternés) font foi.
**Pourquoi pas plus** : le plafond est le débit du SSD (~2 Gio/s) et la fenêtre de recouvrement est courte (calcul d'une couche ~0,7 ms contre ~2-3 ms de lecture) ; K trop grand (>= 16) fait lire des experts inutiles qui concurrencent les lectures utiles. **Piste 3 (fil de lecture dédié / plus de requêtes)** non retenue : le fil de préchargement existant lit déjà toutes ses requêtes en vol et le SSD est proche de la saturation.
**Instrumentation ajoutée** (inactive sans `WS_PROF`) : ligne `[ws_prof] store, 10 tokens: ... requêtes, lectures SSD (Mo, s), attentes de préchargement` dans `ExpertStore::fetch`, ligne `[ws_look]` (rappel du lookahead). **Limites** : un seul modèle (Qwen3-Coder-Next), un prompt, 200 jetons, 2 essais par config, bruit machine ~±3 % ; le routeur de Qwen3-Next est un softmax sans biais : pour les modèles à routage par groupes/biais la prédiction sera moins bonne (reste lossless) ; non testé sur Gemma/le décideur/LFM2. Défaut laissé à désactivé tant qu'un second modèle ne confirme pas ; recommandé : `--lookahead 10:2` pour Qwen3-Coder-Next. Scripts et journaux : `C:\llm-work\ovl\` (`run.sh`, `client.py`, `pred.py`).

## 36. Un plus gros cache RAM d'experts accélère-t-il la génération ? Balayage + profils adaptatifs (2026-11-17)
**Conditions.** Comme la section 35 : Qwen3-Coder-Next Q4_K_M, prompt 3695 jetons, 200 jetons gloutons, `--cache-mib 7500 --mem-margin-mib 2500 -c 6144 --slots 1`, `--data-dir` neuf à chaque essai, essais alternés (ordre base/look puis look/base), `WS_PROF=1`, binaire `ws_npc_server_ovl`. **Différence voulue** : `--ws-max-mib` = `--ws-ram-mib`, sinon le régulateur fait grandir le cache tout seul (c'est ce qui rendait la ligne de base de la section 35 plus rapide : cache ~16 Go) et la taille ne serait plus contrôlée. Firefox ouvert. Sortie : ids des 200 jetons identiques entre tous les essais terminés (12 essais) : oui. Lecture SSD/RAM : somme sur la génération des lignes `[ws_prof] store` (requêtes d'experts ; « lues du SSD » = ratés du cache RAM, préchargements compris). Scripts/journaux : `C:\llm-work\ramsw\` (`run.sh`, `sweep.sh`, `arun.sh`, `an.py`).

| --ws-ram-mib | lookahead | génération 200 jetons (2 essais) | tok/s | requêtes lues du SSD (sur 51966) | volume SSD | pic RAM processus | sortie identique |
|---|---|---|---|---|---|---|---|
| 4000 | non | 45,3 / 46,2 s | 4,4 | 97 % | 32 Go | 4,4-4,5 Go | oui |
| 4000 | 10:2 | 40,2 / 40,2 s | 5,0 | 44 % | 14,6 Go | 4,4-4,5 Go | oui |
| 8000 | non | 41,6 / 39,9 s | 4,9 | 84 % | 27,8 Go | 7,0 Go | oui |
| 8000 | 10:2 | 36,5 / 43,8 s (bruité) | 5,0 | 39 % | 13,1 Go | 7,1-7,2 Go | oui |
| 12000 | non | 34,5 / 34,8 s | 5,8 | 72 % | 23,8 Go | 9,6 Go | oui |
| 12000 | 10:2 | 30,9 / 30,3 s | 6,5 | 34 % | 11,3 Go | 9,9-10,0 Go | oui |
| 16000 | - | **non lancé** | | | | | |

Pic RAM = `PeakWorkingSet64` du processus échantillonné toutes les 2 s : il ne compte pas toutes les pages mappées du fichier, donc ~ taille du cache + 0,4 Go (la section 35 donnait 12,5 Go pour un cache de 9 Go : les deux mesures ne s'additionnent pas). VRAM système : ~12,0 Go dans tous les essais (cache VRAM 7500 + Firefox), **inchangée**. **16 Go non lancé** : à 12 Go la RAM disponible du système est descendue à 3,3 Go (6,4-9 Go dans les autres essais), sous la limite de ~4 Go demandée.

**Lecture des chiffres.**
- Le gain de la taille est **réel et continu, sans palier dans la plage testable** : sans lookahead 45,8 -> 40,8 -> 34,7 s (4 -> 8 -> 12 Go), soit ~-24 % au total, ~1,4 s par Go ajouté ; la part de lectures SSD tombe 97 -> 84 -> 72 %. Avec lookahead 40,2 -> ~40 (bruit ±4 s à 8 Go) -> 30,6 s. La courbe n'est pas plate à 12 Go (le cache ne contient que ~30 % des 39,7 Go d'experts) : c'est la RAM de la machine qui plafonne, pas le rendement. Cohérent avec la section 35 (cache ~16 Go grandi par le régulateur : ~27 s avec lookahead).
- Le lookahead gagne **~12 % à 4 Go et à 12 Go** (45,8 -> 40,2 ; 34,7 -> 30,6 s) et divise par ~2 la part des lectures SSD à la demande (97 -> 44 %, 72 -> 34 %) à taille égale : les deux gains **s'additionnent** (12 Go + lookahead = -33 % vs 4 Go sans). Moins que les -19 % de la section 35 (cache plus chaud/plus gros là-bas). À 8 Go l'essai est trop bruité pour trancher (±10 %). Pas de RAM en plus (+0,1-0,4 Go).

**Adaptatif (code lu : `apply_adaptive`, `Engine::governor_tick`, `gear_margin_mib`, `update_gear` dans `tools/npc_server.cpp`).** Un profil `partage`/`fond` fixe au chargement `ws_ram` = min(RAM disponible - marge - RAM propre du processus, 90 % du modèle) (plancher 2 Go) et `ws_max` = min(90 % du modèle, 85 % de la RAM totale). Ensuite le régulateur, appelé **seulement entre deux `llama_decode`** (donc rien ne bouge au repos), toutes les 2 s (0,4 s pendant les 90 premières s) : si la RAM disponible > marge + 10 %, le cache grandit de ~10 % par pas (50 % pendant la montée initiale) ; si elle passe sous max(marge/2, plancher dur 3,5 % de la RAM) il rétrécit d'un coup (x0,8 ou de tout le déficit) et insère des pauses. En mode auto (`partage`) la marge suit l'activité CPU des autres programmes (de ~18 % à ~6,5 % de la RAM totale).
- `partage` mesuré (lookahead 10:2, journal `[governor]`) : départ 4966 Mo -> **monte seul à 10 144 Mo** en 5 pas pendant le prefill (RAM disponible 9,9 -> 4,9 Go), puis la marge auto monte à ~8,2 Go (un autre programme s'active) : **redescend d'un coup à 5994 Mo** (disponible 4,0 Go < plancher 8,2 Go), puis remonte par pas de ~3 % à 7418 Mo (disponible ~6,8 Go). Il monte donc bien quand la place existe et redescend quand elle manque (la « pression » venait de Firefox et du cache disque de Windows ; aucun programme gourmand lancé). **Au repos rien ne bouge** : plus aucune ligne `[governor]` après la génération, le cache reste à ~7,4 Go, RAM non rendue tant qu'on ne génère pas. Résultat : génération 56,5 s (3,5 tok/s) ; **prefill 804 s** (profil lean : micro-lot 4, pas de prefill rapide, KV q8) contre ~26-35 s en profil fixe + prefill rapide. `partage` est le plus lent des profils par conception.
- `fond` : **non terminé**. Départ à 10 519 Mo de cache ; ma sécurité (arrêt si RAM disponible < 2,5 Go) l'a tué pendant le chargement (disponible 2,07 Go, Firefox ouvert). Le profil vise une réserve d'~4 Go pour Windows mais la RAM propre du processus (pages mappées hors cache) est probablement sous-estimée. Pas de mesure de vitesse ; ne pas le lancer sans fermer les programmes voisins.
- **Meilleure vitesse à la fin** : un profil **fixe** bien dimensionné : 12 Go + lookahead = 30,3-30,9 s (6,5 tok/s) contre 56,5 s pour le meilleur adaptatif mesuré (`partage`). Le régulateur est une assurance pour la machine, pas un accélérateur.

**Verdict honnête.** (1) Le gain ne s'arrête pas avant la limite mémoire de la machine : ~1,4 s sur 200 jetons (~3-4 %) par Go de cache en plus jusqu'à au moins 12 Go, pas de palier visible (il en faudrait ~20 Go, impossible ici en gardant 4 Go libres). (2) Lookahead et taille se cumulent : la config la plus rapide **sûre** ici est ~12 Go + `--lookahead 10:2`. (3) **Propositions (aucun défaut changé)** : a) activer `--lookahead 10:2` par défaut pour ce modèle une fois un 2e modèle confirmé (section 35) ; b) `partage`/`fond` : ajouter de l'hystérésis après un rétrécissement (le va-et-vient 10 -> 6 -> 7,4 Go est coûteux : le cache rétréci perd des experts chauds) et monter plus vite au-dessus de marge + 10 % ; un tick au repos pour chauffer le cache pendant les veilles serait un vrai ajout (n'existe pas aujourd'hui) ; c) `fond` : compter les pages mappées du modèle dans la RAM propre, sinon la réserve réelle est inférieure à 4 Go ; d) ne pas rendre les profils plus agressifs avant (c) : à 12 Go il ne reste déjà que 3,3-6 Go libres. **Limites** : un modèle, un prompt, 2 essais par cellule (bruit ±4 s, la ligne 8 Go + lookahead est peu fiable), RAM disponible influencée par Firefox et le cache disque Windows, pas de test avec un vrai programme gourmand (interdit), `fond` non mesuré, 16 Go non mesuré.

## 37. Profil `paliers` : taille du cache RAM décidée une fois par requête (2026-11-17)
**Décision de l'utilisateur** : le moteur ne module pas le cache RAM pendant une génération. Au début de chaque requête il mesure la RAM libre, garde une marge, arrondit vers le bas à un palier et garde cette taille jusqu'à la fin ; la requête suivante peut en prendre un autre. Seule exception : urgence (RAM libre critique) -> pause, jamais de rétrécissement silencieux.
**Code** (`tools/npc_server.cpp`, aucun changement dans llama.cpp : pas de patch à régénérer ; défauts des autres profils inchangés) : `--profile paliers` (`ProfileDef` `autom = 3`, ni lean ni light : prefill rapide `--prefill-ubatch 4096` et micro-lot normal comme les profils fixes ; `--lookahead` reste indépendant ; un `--cache-mib` donné est respecté, sinon calcul VRAM habituel).
- `Engine::paliers_decide` (début de `generate_locked`, donc aussi à la reprise après suspend/rechargement) : `budget = RAM libre - réservé + RAM déjà tenue par le cache - marge`, où `RAM déjà tenue = clamp(working set - (poids hors experts + 1 Go), 0, capacité)` (estimation prudente). Marge = `--mem-margin-mib` ou **4096 Mo** (il ne pilote plus de régulateur ici : `governor_tick` ne fait que `paliers_watch` pour ce profil). Paliers (Mo) : 4000, 6000, 8000, 10000, 12000, 16000, plafonnés par `--ws-max-mib` et par 90 % de la taille du modèle (qui devient le dernier palier s'il est plus bas) ; un palier plancher 2000 n'est utilisé que si même 4000 casserait la marge. **Hystérésis** : on ne descend que si le budget est passé sous le palier en cours (pas de vidage inutile : `resize` ne rejette que les emplacements au-delà de la nouvelle taille) ; on ne monte qu'à un palier P tel que budget >= P + 1000 Mo.
- **Urgence** : `paliers_watch` (appelé entre deux `llama_decode`, au plus 4 fois/s) : 2 lectures consécutives de RAM libre < seuil critique (`--mem-critical-mib`, défaut max(1500 Mo, 3,5 % de la RAM)) lèvent `mem_emergency`. Travail `/api/jobs` : point de reprise (KV + journal), statut `paused`, `pause_reason: "memory_critical"`, `paused_free_mib` ; la reprise (`POST /api/jobs/<id>/resume`) choisit un nouveau palier. Pendant le prefill l'arrêt a lieu entre deux micro-lots (KV du prompt déjà lu sauvegardé). Requête `/v1/chat/completions` ou personnage : arrêt propre, **HTTP 503** `memory_critical: free system RAM fell to X MiB ...`.
- **Visibilité** : ligne `[paliers] free X MiB, cache holds Y, margin M -> budget B MiB: step P MiB (cache was C) [UP|DOWN]` à chaque requête, puis `[gen] ... palier=PMiB free=XMiB` (+ `MEMORY-PAUSE` si urgence) ; `/api/status` -> bloc `paliers` (`palier_mib`, `free_mib` mesuré au début de la requête, `free_now_mib`, `budget_mib`, `margin_mib`, `critical_mib`, `max_mib`, `cache_mib`, `direction`, `ups/downs/emergencies`, `emergency`), lisible même pendant une génération (`paliers_json`, sans verrou moteur) ; les travaux gardent `palier_mib` et `free_mib_at_start`.
- **Test uniquement** : `WS_PAL_FREE_FILE=<fichier contenant un nombre de Mo>` remplace la RAM libre lue (relu à chaque décision et contrôle d'urgence) : simule une RAM libre qui change entre deux messages sans lancer de programme gourmand.

**Mesures** (Qwen3-Coder-Next Q4_K_M, prompt 3695 jetons, 200 jetons gloutons, `--cache-mib 7500 -c 6144 --slots 1 --lookahead 10:2`, `--data-dir` neuf, Firefox ouvert, binaire `ws_npc_server_pal`, scripts/journaux `C:\llm-work\pal\`). Texte des 200 jetons comparé (md5) ; 1 essai par ligne (bruit ±4 s).

| essai | RAM libre vue | palier choisi | prefill | génération 200 jetons | RAM libre min / pic RAM proc. | texte identique |
|---|---|---|---|---|---|---|
| paliers, RAM réelle, msg 1 | 13 499 Mo | **8000** (budget 9403 < 10000) | 28,5 s | 36,5 s (5,5 tok/s) | 4,7 Go / 10,0 Go | oui |
| paliers, RAM réelle, msg 2 (juste après) | 7 676 Mo | 8000 (budget 8125 : on reste) | 24,8 s | 36,9 s | idem | oui |
| paliers simulé, msg 1 | 9 000 | **4000** (DOWN) | 24,1 s | 41,1 s | | oui |
| paliers simulé, msg 2 | 14 000 | **10000** (UP : 11 242 >= 10000 + 1000) | 23,2 s | 38,2 s | | oui |
| paliers simulé, msg 3 | 2 500 | **4000** (DOWN, budget 4291) | 22,3 s | 45,4 s | | oui |
| paliers simulé, msg 4 | 30 000 | 16000 (UP) | | non terminé : mon échantillonneur a tué le serveur (RAM réelle < 2,3 Go : le 30 000 était faux) | | |
| fixe `--ws-ram-mib 12000` | réelle | 12000 | 23,9 s | **31,0 s** (6,5 tok/s) | 3,5 Go / 9,9 Go | oui |
| `partage` (section 36) | réelle | 4966 -> 10 144 -> 5994 -> 7418 (mouvant) | **804 s** | 56,5 s | | - |

Lecture : `paliers` garde un palier fixe pendant la génération (aucune ligne `[governor]`), prefill rapide comme le profil fixe (22-28 s contre 804 s pour `partage`). La vitesse de génération est celle du palier : 4000 -> 41 s, 8000 -> ~37 s, 10000 (cache neuf après une montée) -> 38 s, 12000 fixe -> 31 s. Le palier 8000 réel est ~5 s plus lent que le 12 Go fixe parce que le profil garde 4 Go libres : c'est le prix de la marge. **Urgence** (RAM libre simulée à 1000 Mo) : (a) `/v1/chat/completions` coupé : HTTP 503, message clair, 17,8 s ; (b) un travail `/api/jobs` coupé après 27 jetons : `paused`, `pause_reason memory_critical`, point de reprise écrit ; repris avec 8000 Mo libres : nouveau palier **8000** (au lieu de 16000), 200 jetons terminés.
**Limites.** (1) **La reprise d'un travail ne redonne pas le même texte ici** : le travail repris diverge à partir du jeton ~27 du texte sans interruption (un travail non interrompu est identique au chat : md5 égal), et son préremplissage de reprise a pris 555 s. Cause probable, antérieure à `paliers` : Qwen3-Next est récurrent, `llama_memory_seq_rm` ne peut pas couper d'un jeton, donc `common` retombe à 0 (`reused=0`) et prompt + jetons déjà générés sont relus en micro-lots de 32 (autres arrondis, et lent) ; non corrigé (hors périmètre), à traiter à part. (2) Seuls les tests d'urgence et de changement de palier simulent la RAM libre ; le reste est mesuré. (3) Un essai par ligne, un modèle, un prompt, Firefox ouvert ; le 4e message simulé n'a pas été mesuré. (4) Marge de 4 Go + estimation prudente du cache déjà tenu : le palier peut être plus bas que ce que la machine supporterait (8000 pour 9403 Mo de budget). (5) `generate_sliced` (tâches de fond) re-décide à chaque tranche de 8 jetons (sans effet grâce à l'hystérésis tant que la RAM libre ne change pas). (6) Dépôt PAIZ non touché : PAIZ n'a qu'à ajouter `paliers` à sa liste (`/api/status` -> `profiles` le liste) et lire le bloc `paliers`.

## 38. Reprise d'un travail (`/api/jobs`) exacte et rapide sur modèle récurrent (2026-11-17)
**Cause racine** (3 défauts empilés dans `generate_locked`, `tools/npc_server.cpp`) :
1. **Retour en arrière impossible** : le point de reprise contient prompt + jetons déjà générés (N jetons) ; à la reprise le serveur relisait le journal (N jetons aussi) puis, pour obtenir les logits, forçait `common = N - 1` et coupait le dernier jeton (`llama_memory_seq_rm`). Un état récurrent (Qwen3-Next : couches delta-net) ne peut pas être coupé, même d'un seul jeton : le coupe échouait, tout l'état était jeté (`common = 0`, `reused=0`).
2. **Chemin lent** : la décision du préremplissage rapide (`boost`) était prise AVANT ce rejet, avec `known = N` (prompt « déjà connu ») donc « rien à lire » -> pas de tapis roulant ; les 3700 + n jetons étaient relus en micro-lots de 32 : **555 s** au lieu de ~25 s.
3. **Texte différent** : prompt et jetons générés relus en lots de 32 au lieu de lots de 4096 (prompt) puis un jeton à la fois (génération) : arrondis flottants différents, d'où la divergence au jeton ~27 en température 0. (Boucle de préremplissage : `off += pf_step` ignorait aussi la taille réelle du lot.)

**Correction** (aucun changement dans llama.cpp, pas de patch à régénérer) :
- Chaque point de reprise écrit un fichier annexe `<état>.logits` (logits qui suivent le dernier jeton enregistré, 600 Ko, remplacé atomiquement avec l'état, vérifié par le nombre de jetons). À la reprise d'un état identique au journal, on **ne décode rien** : le jeton suivant est tiré de ces logits avec le même échantillonneur -> exactement la suite du run non interrompu, préremplissage 0 s.
- Arrêt brutal (journal plus long que le point de reprise) : le fil restauré est un préfixe du journal, la queue est rejouée **un jeton à la fois** (comme la génération d'origine).
- Si l'état ne peut pas être utilisé (modèle récurrent, pas de fichier de logits, ou état non préfixe du journal) : repli explicite, journal `[resume] ... the prompt is read again from zero with the fast prefill` ; le prompt est relu avec le **tapis roulant** (mêmes limites de lots que l'original), puis les jetons déjà générés rejoués un par un.
- Journal de succès : `[resume] job:... checkpoint restored exactly (N tokens), no prompt re-read`.

**Mesures** (Qwen3-Coder-Next Q4_K_M, prompt 3695 jetons, 200 jetons gloutons, `--profile paliers --cache-mib 7500 -c 6144 --slots 1 --lookahead 10:2`, `--data-dir` neuf, Firefox ouvert ; scripts/journaux `C:\llm-work\fix\`). Référence = travail non interrompu (md5 du texte) :

| cas | avant (section 37) | après |
|---|---|---|
| pause vers le jeton 47, reprise (même processus) | reprise : préremplissage 555 s, texte différent dès le jeton ~27 | **0,5 s** avant le 1er nouveau jeton, génération des 153 restants 22,4 s, **texte identique** (md5 = non interrompu) ; ids des 200 jetons identiques |
| `taskkill /F` après 61 jetons (point de reprise à 58) puis redémarrage | non mesuré avant | rejeu de 4 jetons : préremplissage **3,6 s**, texte final **identique** (md5) |
| pic RAM processus / VRAM système | 10,0 Go / ~12,0 Go | 7,2 Go (pause), 8,7 Go (kill) / 11,9-12,0 Go : inchangés |

Non-régression **Gemma 4 26B-A4B** (modèle à attention) : travail de 200 jetons, prompt 4284, pause à 48 puis reprise : restauration exacte en 0,0 s, **texte identique octet pour octet** au travail non interrompu (md5 égal).

**Limites / non vérifié.** (1) Le « avant » est celui de la section 37 (555 s, divergence au jeton ~27), pas remesuré avec l'ancien binaire. (2) Le repli (état inutilisable) n'a pas été déclenché en test sur Qwen3-Next : code relu, pas exécuté ; son identité repose sur les mêmes limites de lots que le run d'origine (même `--prefill-ubatch`). (3) Un travail dont le point de reprise date d'avant cette version (pas de `.logits`) prend le repli sur modèle récurrent (lent mais correct). (4) Arrêt brutal testé sur Qwen seulement ; Gemma testé en pause seulement. (5) Pause/reprise pendant le préremplissage (mem_abort) : inchangé, non rejoué ici. (6) Un essai par ligne, un prompt.

## 39. Pause / reprise exacte d'une requête `/v1` en cours (`ws_job`) (2026-11-17)
**Choix** : le corps d'une requête `/v1/chat/completions` en flux peut porter `ws_job` (id choisi par l'appelant) ; le moteur l'exécute alors comme un travail de la section 38 (journal, points de reprise, `/api/jobs/<id>/pause|resume|cancel`) mais **sur la connexion d'origine** : pause = flux gardé ouvert, reprise = le flux continue. Raison : OpenCode ne voit ni erreur ni nouvelle requête, le thread KV de la conversation est conservé (pas de relecture du prompt à chaque étape), et un travail `/api/jobs` classique ne sait ni streamer ni parser les appels d'outils. Détails d'API : `Docs/NPC_SERVER.md`. Code : `Jobs::serve_v1` + pause possible pendant le préremplissage (entre deux micro-lots).
**Mesures** (Qwen3-Coder-Next Q4_K_M, `--profile paliers --cache-mib 7500 -c 6144 --slots 1 --lookahead 10:2`, `--data-dir` neuf, Firefox ouvert, température 0, 100 jetons max, via le relais PAIZ ; scripts/journaux `C:\llm-work\pause\`) :
| essai | résultat |
|---|---|
| texte, pause au jeton 36 puis reprise (même processus) | pause prise en 0,3 s, 4 s à l'arrêt (0 jeton), 1er jeton 0,6 s après la reprise, **texte identique** au run ininterrompu |
| appel d'outil (`write_file`), pause au jeton ~27 puis reprise | appel identique au run ininterrompu |
| `taskkill /F` du moteur au jeton 55 (point de reprise 5 s avant), relance | la connexion d'OpenCode reste ouverte, rattachement 2,2 s après le lancement du moteur, **texte identique** ; une seule réponse |
**Non vérifié** : crash de PAIZ lui-même (la requête d'OpenCode disparaît ; le travail reste `interrupted` mais OpenCode renvoie une requête différente) ; pause pendant un long préremplissage ; prompts de plusieurs milliers de jetons ; RAM critique réelle (le code existe, non déclenché) ; `resume_prefill_s` n'est publié qu'à la fin de la génération reprise.


## 40. Point de reprise de FIN DE PROMPT sur modèle récurrent : le message suivant ne relit que le nouveau (2026-11-17)
(La demande parlait de « section 39 » ; elle existait déjà, d'où 40.)
**Problème** : sur Qwen3-Coder-Next (récurrent) l'état ne se raccourcit pas d'un jeton. L'état conservé après une réponse = prompt + jetons générés ; si le client renvoie la réponse reformatée (OpenCode), ce n'est plus un préfixe de la requête suivante, `generate_locked` jetait tout et relisait ~6 800 jetons (≈ 52 s de prefill en tapis roulant, 55-60 s par message).
**Correction** (`tools/npc_server.cpp`, `generate_locked`, aucun changement dans llama.cpp) : sur modèle récurrent/hybride, dès que le prompt (≥ 512 jetons, sans jetons déjà générés) vient d'être lu, avant tout jeton généré, l'état de la séquence est copié dans `<état>.kv.pe` (écriture atomique ; un seul fichier par fil, remplacé à chaque requête ; ~250 Mo pour 6 800 jetons sur Qwen3-Next ; supprimé avec le fil). À la requête suivante, si l'état du fil doit être coupé (ou n'existe pas), on charge ce point de reprise **seulement s'il est un préfixe strict de la nouvelle requête** (comparaison par jetons) et on ne lit que les jetons au-delà. Sinon repli inchangé (relecture complète, message `[resume] ... read again from zero`). Message de succès : `[resume] ... restarted from the end-of-prompt checkpoint (N tokens), M new tokens to read`. Sert aussi les requêtes `ws_job` (même mécanisme que la section 38 pour la queue rejouée). `WS_NO_PROMPT_END=1` désactive la sauvegarde (mesures « avant »). Les modèles non récurrents (Gemma) ne passent pas par ce code.
**Mesures** (Qwen3-Coder-Next Q4_K_M, `--profile paliers --cache-mib 7500 -c 8192 --slots 1 --lookahead 10:2`, `--data-dir` neuf, requêtes `/v1/chat/completions` en flux, corps ~30 Ko, 13 outils, `ws_job`, température 0, 40 jetons max ; l'historique renvoyé est volontairement reformaté : un espace doublé dans la réponse précédente ; scripts/journaux `C:\llm-work\ckpt\`) :
| message | avant (`WS_NO_PROMPT_END=1`) | après |
|---|---|---|
| 1 (froid, ~6 765 jetons) | 57 s (97 s après, charge variable) | idem (+ écriture du point de reprise) |
| 2 (+37 jetons nouveaux) | **60,8 s** (prefill 52,1 s, reused=0) | **11,2 s** (prefill 5,8 s, reused=6765 ; dont 5 s de génération) |
| 3 (+64 jetons nouveaux) | **54,5 s** (prefill 52,3 s) | **6,1 s** (prefill 5,0 s, reused=6802) |
Textes des 3 tours **identiques** avant/après (glouton). Hors reformatage (historique renvoyé tel quel), l'ancien code réutilisait déjà l'état (message 2 : 10 s, 3 : 5 s) : le gain ne concerne que le cas reformaté. Pic RAM du processus ~6,4 Go (inchangé par rapport aux sections 37-38) ; coût disque : 1 fichier ~250 Mo par fil. **Gemma 4 26B** (mêmes 3 tours reformatés) : pas de fichier `.pe`, pas de message `[resume]`, réutilisation normale (reused=6085, 6142), aucun changement.
**Limites** : (1) l'identité est vérifiée sur ces 3 tours courts (40 jetons) ; relire à partir du point de reprise découpe les lots autrement (1er lot de 4096 + reste vs lots du prompt entier), donc une divergence flottante rare sur de longues générations n'est pas exclue (même nature que n'importe quel multi-tours llama.cpp) ; (2) un seul point de reprise par fil : si le client réécrit le début de l'historique (avant la fin du prompt précédent), repli sur la relecture complète ; (3) le « avant » reformaté est simulé (espace doublé), pas le vrai reformatage d'OpenCode ; (4) cas redémarrage du moteur / fil endormi non rejoué spécifiquement.

## 41. Décoder plusieurs jetons par passe aide-t-il quand le SSD domine ? Mesure (2026-11-18, rien d'implémenté)
**Question.** Pour une nuit de calcul sur un très gros modèle, lire les poids une fois pour K jetons (lot) ou K flux parallèles réduit-il le temps par jeton ? Le §34 l'avait mesuré avec un gros cache (-12 % par jeton à K = 8) ; ici le cache RAM est petit (6 % du modèle) pour que la lecture SSD domine.
**Conditions.** Qwen3-Coder-Next Q4_K_M, même prompt qu'au §34 (3695 jetons), 192 jetons gloutons rejoués par lots de K (`WS_BATCH_TEST=K`, `WS_BATCH_SCRIPT`), binaire `ws_npc_server_ovl`, `--ws-ram-mib 3000 --ws-max-mib 3000 --cache-mib 1500 --mem-margin-mib 2500 -c 6144 --slots 1`, `--data-dir` neuf, un seul essai par K (bruit possible, ±5 % au moins). Scripts/journaux : `C:\llm-work\batchscale\`.
| K | génération (192 jetons) | ms/jeton | tok/s |
|---|---|---|---|
| 1 | 80,7 s | 420 | 2,4 |
| 8 | 103,1 s | 537 | 1,9 |
| 16 | 84,4 s | 439 | 2,3 |
Lu depuis le SSD (compteur cumulé prefill compris) : 57,2 Go (K = 1), 83,7 Go (K = 8), 69,5 Go (K = 16).
**Verdict : pas de gain.** Avec un petit cache, grouper les jetons ne baisse ni le temps ni les lectures (le lot élargit l'union d'experts et fait défiler le petit cache). Le lot rejoue les jetons successifs d'UNE séquence (recouvrement maximal) : des flux indépendants se recouvriraient moins, donc ne feraient pas mieux. Le levier « lot / flux parallèles » ne marche donc pas sur ce chemin MoE ; il ne vaudrait que pour un modèle DENSE (une couche = un seul produit matriciel, lecture partagée par tous les jetons du lot), qu'on ne sait pas streamer couche par couche aujourd'hui.
**À retenir pour les très gros MoE** : à 6 % de cache, la génération tient environ 2,4 tok/s sur un modèle de 48 Go, sans lot. Un MoE de 70-80 Go à cache équivalent ne devrait pas s'effondrer (la lecture par jeton dépend des experts actifs, pas de la taille totale), ordre de grandeur non mesuré : 1-2 tok/s, soit ~15-30 000 jetons en 4 h.
Note : le port 8791 est pris par un autre processus Python de la machine (pas à nous) ; ces essais ont tourné sur 8797.

## 42. gpt-oss-120b, plafond du disque, grille VRAM x RAM sur Gemma, file de tâches PAIZ (2026-11-19)
**gpt-oss-120b MXFP4** (63,4 Go, 36 couches, 5,1 Md actifs), `ws_moe_probe`, cache VRAM 5 Go / RAM 2 Go, `WEIGHTSTREAM_NO_PREFETCH=1` : ~1,5 tok/s, pic mémoire de travail 4,3 Go (8,3 Go avec 6 Go de cache RAM, qui ne servait que 2,8-20 % de succès). Tâche réelle (module Python de dédoublonnage + tests pytest, 35 min) : 6 tests sur 6 passent, logique correcte ; défauts : fonction définie deux fois (ébauche avec `yield` laissée dans le fichier), dossier inexistant -> code de sortie 0. Cache VRAM seul : 5 Go 1,53 tok/s, 7 Go 1,83 (+20 %, texte identique), 9 Go = carte pleine (426 Mo libres), écarté. Rangé sur F: (`LLM/Divers/gpt-oss-120b`, vérification octet par octet interrompue à la demande, taille identique), supprimé de C:.
**Plafond du disque** (Samsung 980 1 To, PCIe 3, lectures de 4 Mio, `nvme-depth.ps1` dans le bac à sable de la session) : 1,14 Gio/s à 1 lecture, 2,04 à 2, 2,18 à 4, **2,22 à 8**, 1,93 à 16, 1,21 à 32. Le moteur lit déjà à 2,05 Gio/s : il n'y a rien à gagner en remplissant mieux le disque. Lectures tamponnées, transfert en cours sur le même disque (limite de la mesure).
**Grille Gemma 4 26B-A4B (variante uncensored Q4_K_M), `reports/g4/dialogue2/summary.tsv`**, prompt de code, 128 jetons, ubatch 32, essais uniques, 16 essais sans erreur ni repli, **texte identique (`f30b1289...`) y compris llama.cpp seul**. La RAM WS compte peu (0,7 Go suffit, pic 2,9 Go) ; le cache VRAM fait la vitesse : 2 Go 3,2 tok/s, 3 Go 9,2, 4 Go 17,0, 5 Go 21,3, 6 Go 25,9 (VRAM +4,6 / 5,6 / 6,6 / 7,8 / 8,7 Go hors bureau). llama.cpp seul à 6 Go : 22,6 tok/s avec 10,3 Go de RAM : à VRAM égale WS est plus rapide et prend 3,6 fois moins de RAM (écart à confirmer : un essai chacun, bruit ~10 %). Profils PAIZ ajoutés : `dialogue` (4000/700), `vif` (5000/700), `tache` (7000/2000 pour les très gros modèles). Réserve : le handoff §14 mesurait 10,5 tok/s à 4000/1500, ici 18,1. **Le tapis roulant n'y est pour rien** (vérifié : `WS_NO_BULK=1` 18,13 et 17,98 tok/s contre 18,05 et 17,59 avec, texte identique ; répétabilité ~3 %, `reports/g4/bulk_off` et `bulk_on`). Restent : autre fichier (uncensored), machine moins chargée, autres changements du moteur depuis le 7/11 : non élucidé.
**Tapis roulant** : mesuré seulement sur Qwen3-Coder-Next (§32), pas encore sur Gemma. Les fiches d'experts (§3) restent négatives (LRU plus rapide). Pas d'astuce de goulot trouvée pour Gemma hors cache VRAM plus gros.
**PAIZ** (dépôt PAIZ-WEIGHTSTREAM) : file de tâches du gros modèle (`src/tasks.js`, une à la fois, persistante, texte en direct, bloc dans la colonne Travail), garde-fou mémoire (pause si RAM disponible < 2 Go ou VRAM libre < 700 Mo, reprise avec marge 3 Go / 1,2 Go, via `ws_job` pause/resume, testé sur faux moteur seulement), Entretien > Restes oubliés, détection des types GGUF NVFP4/Q1_0/Q2_0. Exécutable non reconstruit. Bonsai 27B (Q1_0, 3,5 Gio, 39,5 tok/s) : fort en logique/code, faible en français créatif. Idée notée : appels automatiques de la file par un modèle gratuit OpenCode (pas fait).
**Reste** : mesurer le tapis roulant sur Gemma (prompt de 3 000 jetons), tester une vraie tâche avec pause réelle, choisir un MoE de ~100 Go (GLM-4.5-Air Q4 73 Go proposé), reconstruire l'exécutable.

### 42 bis. Préchauffage du prompt au chargement (PAIZ, 2026-11-19) — mesures Gemma 4 26B-A4B, mode dialogue, dossier de données neuf
**Prompt réel** : la requête brute d'OpenCode fait 6 737 jetons, mais après le proxy de PAIZ (`selectTools` + `trimCodeMode`, sans serveur MCP activé) elle n'en fait que **≈ 1 410-1 560** (5 outils, système de 1 536 caractères). Le moteur lit un prompt froid à ~75-80 jetons/s (GPU occupé à 87 %, CPU 0,3 coeur, disque pas limitant : 0,15 s d'attente de lecture sur 89 s ; même problème que « prefill ~50 tok/s vs 263 » de novembre, non résolu).
**Requête brute 6 737 jetons** : à froid 86 s avant le premier mot ; salutation de chauffe 88 s (aucun effet) ; chauffe avec le début de prompt (105 s) puis premier message 12,3 s (le moteur réutilise le début commun même si le message diffère) ; redémarrage du moteur sur le même dossier de données : 13,3 s (l'état du prompt survit au redémarrage).
**Prompt réel 1 412 jetons** : à froid 33,2 s (2e message 7,7 s) ; chauffe 25,4 s puis premier message 10,7 s. Gain perçu : 33 -> 11 s pour le premier message si la chauffe se fait pendant que l'utilisateur configure OpenCode ; si l'utilisateur écrit tout de suite, le total est le même (≈ 50 s).
**Implémenté** (`src/warm.js`, `src/engine.js`, `src/proxy.js`, test `test/warm.mjs`) : le proxy garde le début de prompt (messages système + outils) de la dernière vraie requête avec outils, par modèle (`warm-prefix.json`) ; au chargement (après `/api/resume`, avant `loadedAt`, donc dans la barre de chargement, onglets WeightStream et Travail) PAIZ rejoue ce début avec un message minimal et 1 jeton. Exclus : modèles > 40 Go, réglage `engine.warm=false`, aucun début connu (premier usage d'un modèle : la chauffe commence après la première vraie requête). Non fait : liste d'experts chauds restaurée au chargement (point 2, gain estimé ~6 s), pas testé de bout en bout dans l'application (exécutable non reconstruit).

## 43. Gemma 26B : cache de fenetre reduit, 1 conversation, grille RAM/VRAM (2026-11-19)

**Cause de la lenteur du jour** : `ws_npc_server` gardait un cache KV de fenetre pleine (`swa_full` = vrai par defaut de llama.cpp) pour chaque conversation : 2 x 16 k jetons = ~4 Go de VRAM de trop, carte pleine a 12 Go, decodage 6-8 tok/s. Nouvelle option `--swa-full 0|1` (defaut du serveur : 1 ; PAIZ passe 0). Mesure (2 conversations, texte identique sur 548 car.) : VRAM 11,9 -> 7,7 Go, 6,4 -> 9-10 tok/s ; avec le cache d'experts monte a 7 Go : 21 tok/s a 10,7 Go. Reutilisation du debut de prompt et alternance de conversations : OK (3-4 s). Perdu : la reprise d'une conversation sauvegardee apres redemarrage du moteur (relue en 17-27 s). KV q8_0 : -0,5 Go seulement et le texte change au 175e caractere : ecarte.

**1 conversation (`--slots 1`), cache d'experts -> decodage** (prompt unique rejoue, optimiste) : 4 Go 13 tok/s (7,4 Go VRAM), 5 Go 22 (8,3), 6 Go 33 (9,1), 7 Go 43 (10,2), 8 Go 52 (11,1).

**Grille RAM / VRAM sur 2 prompts a temperature 0 (1 conversation)** : eco 0,7/0,5 : 1,9 tok/s ; normal 3/1 : 5,0 ; RAM 8 + VRAM 0,7 : 9,3 (RAM de la machine : 2,3 Go restants) ; RAM 12 + VRAM 0,7 : 9,1 (0,5 Go restant, dangereux) ; confort 8/5 : 25,8 (VRAM 8,6 Go) ; dialogue 0,7/4 : 10,1 (VRAM 7,3 Go, RAM ~3 Go) ; `--cpu-stream` RAM 3 : 4,0 ; RAM 8 : 10,9 (VRAM 3,8 Go). Texte identique partout SAUF `--cpu-stream` (differe, coherence non verifiee). Les deux a RAM 4 Go : cpu-stream 4,7 tok/s, cache VRAM 0,7 Go 5,8. Conclusion : la VRAM fait la vitesse ; la RAM aide jusqu'a ~8 Go puis plafonne.

**PAIZ** : file de taches (2e conversation ouverte a la demande), prechauffage, chargement auto du dernier modele, profils dialogue/vif/rapide/discret. Prochaine etape decidee : grille de modes « Ou (GPU d'abord / CPU-RAM d'abord / adaptatif) x Combien (discret / sobre / vif / rapide) », supprimer le curseur Vitesse, mode auto (RAM a chaud, VRAM par redemarrage) plus tard.

**Deux moteurs en meme temps (2026-11-19)** : Gemma 4 26B « leger » (RAM 0,7 / cache VRAM 1,5 Go, 1 conversation, cache de fenetre reduit) + Qwen3-Coder-Next Q4_K_M (48,5 Go, deplace de l'ecurie F: vers C:\llm-models\Qwen3-Coder-Next, 21 min, verifie ; `-c 8192`, RAM 2 / cache VRAM 1,5 Go), deux `ws_npc_server` sur deux ports. VRAM totale 8,3 Go (dont ~1,2 Go Windows/Firefox), RAM disponible machine 9,4 Go (sur 32). Gemma seul 3,7 tok/s ; Qwen (Gemma au repos) 3,1 tok/s, premier mot 8 s ; les deux generent en meme temps : Qwen 2,4 + Gemma 2,9 tok/s. Reste ~4 Go de VRAM : marge pour monter les caches. Non verifie : qualite des textes de Qwen, prompts longs / agent de code, texte identique.

**Partage de la VRAM Gemma + Qwen3-Coder-Next (grille, 2026-11-19, tok/s ; Gemma seul / Qwen seul / en meme temps ; VRAM totale incl. ~1,1 Go Windows+Firefox)** : Gemma 1,5 + Qwen 1,5 Go de cache : 3,7 / 3,4 / G 2,9 Q 2,4 (8,4 Go) ; 1,5 + 3 : 3,6 / 4,8 / G 3,1 Q 3,3 (9,9) ; 1,5 + 4,5 : 3,7 / 6,5 / G 3,3 Q 5,0 (11,4, trop juste) ; 2,5 + 1,5 : 5,1 / 3,8 / G 4,2 Q 2,9 (9,3) ; 2,5 + 3 : 5,2 / 4,9 / G 4,4 Q 3,7 (10,9) ; 4 + 1,5 : 10,8 / 3,6 / G 6,7 Q 3,3 (10,9). Recommande : Gemma 4 Go + Qwen 1,5 Go (discussion vive, tache de fond lente, ~1,4 Go de marge). La charge se partage sans quota fixe : chacun reprend toute la vitesse quand l'autre se tait (non releve seconde par seconde).

## 44. Mesurer la « perte négligeable » : divergence KL contre la référence sans perte (2026-11-21)

**Décision du propriétaire (2026-11-21)** : sans perte reste le défaut et l'argument de tête, mais un mode avec perte est permis à condition d'être une option explicite, étiquetée à part, qui dit ce qui est perdu, sur quels réglages et pourquoi (vitesse). Il faut donc une mesure de perte. Étalon proposé : la perte déjà acceptée du Q4_K_M par rapport au BF16 (§30).
**Outil** : `llama-perplexity` du llama.cpp vendoré, construit avec `scripts/build-llama.ps1 -Targets llama-perplexity` (`--save-all-logits ref.kld` puis `--kl-divergence-base ref.kld --kl-divergence`). Il lit le modèle comme llama.cpp ordinaire : valable pour tout changement de modèle ou de réglage de llama.cpp (le streaming d'experts est sans perte, donc sans effet sur la mesure) ; le routage « favorise le cache » (crochets WeightStream) demandera de passer par nos outils. Témoin : même réglage (8 experts) = divergence 0,000000 et 100 % même jeton en tête : la mesure est valide.
**Piège** : Gemma 4 « instruct » donne une perplexité aberrante (~11 000) sur du texte brut (nos docs) alors que Bonsai donne 18,7 : ne pas mesurer sur du texte brut. Corpus retenu : 12 réponses de Gemma lui-même (français + code, température 0,8, 26 Ko, 13 blocs de 512 jetons, ~6 600 jetons ; `selfgen.mjs`).
**Gemma 4 26B-A4B Q4_K_M uncensored, référence = 8 experts, f16 KV** (un seul essai par ligne, `-c 512`, `--n-cpu-moe 17`) :
| réglage | divergence moyenne | médiane | même jeton en tête | PPL / PPL réf. |
|---|---|---|---|---|
| 8 experts (témoin) | 0 | 0 | 100 % | — |
| 7 experts | 0,93 | 0,057 | 76,6 % | ×1,77 |
| 6 experts | 1,56 | 0,145 | 68,4 % | ×2,57 |
| 5 experts | 2,24 | 0,38 | 61,2 % | ×5,4 |
| 4 experts | 3,12 | 1,01 | 52,8 % | ×12,4 |
| 3 / 2 experts | 4,77 / 7,06 | 2,97 / 5,93 | 39,3 % / 27,6 % | ×58 / ×506 |
| KV q8_0 (8 experts) | 0,60 | 0,015 | 83,0 % | ×1,06 |
**Lecture** : réduire le nombre d'experts activés n'est PAS un réglage « négligeable » sur Gemma : dès 7 experts, 23 % des jetons changent de tête et la perplexité fait ×1,8. KV q8_0, que l'on croyait presque gratuit, a une médiane faible (0,015) mais une moyenne tirée par quelques jetons très divergents (moyenne 0,60) : cohérent avec le texte qui change au 175e caractère (§43). Ne pas proposer ces deux réglages comme « perte négligeable » pour Gemma. Reste à tester les réglages plus doux : requantification (Q4 -> Q3/Q2, `llama-quantize --allow-requantize`), routage favorisant le cache, et à comparer à l'étalon Q4_K_M/BF16 ; refaire sur Qwen3-Coder-Next (là le gain serait plus grand car le disque limite). **Limites** : 13 blocs, un seul corpus auto-généré, un essai par réglage, moyenne dominée par une queue de jetons (la médiane est donnée à côté) ; aucune mesure de vitesse ici (à faire avec `ws_npc_server`).

### 44 bis. Requantifier Gemma en Q3 / Q2 : vitesse à VRAM égale et perte (2026-11-21)
**Fichiers** : `llama-quantize --allow-requantize` depuis le Q4_K_M uncensored (pas de source BF16 : les pertes se cumulent, résultat pessimiste par rapport à une quantification faite depuis la source) : Q3_K_M 12,66 Go (-21 %), Q2_K 10,08 Go (-37 %), fabriqués dans le bac à sable (`gemma-Q3_K_M.gguf`, `gemma-Q2_K.gguf`).
**Vitesse** (`ws_npc_server`, `--ws-ram-mib 700 --swa-full 0 -c 4096`, requête de chat en flux, température 0, 160 jetons, décodage hors premier jeton, un essai par case, ~10 % de bruit) :
| cache VRAM | Q4_K_M | Q3_K_M | Q2_K (texte cassé) |
|---|---|---|---|
| 2000 Mo | 4,0 tok/s (VRAM totale 5,2 Go) | 8,8 | 39 |
| 3000 | 6,3 (6,2 Go) | 17,1 (6,2 Go) | 52 |
| 4000 | 9,9 (7,2 Go) | 23,8 (7,2 Go) | 55 |
| 5000 | 14,8 (8,3 Go) | 32,0 (8,2 Go) | 60 |
RAM du processus ~2,9 Go partout. **Q3 va ~2,2 à 2,4 fois plus vite à VRAM égale** : 17,1 tok/s avec 6,2 Go de VRAM totale contre 14,8 tok/s avec 8,3 Go pour le Q4, soit environ 2 Go de VRAM en moins pour une vitesse supérieure.
**Perte** (divergence contre le Q4_K_M, même corpus qu'en 44) : Q3_K_M moyenne 2,16, médiane 0,35, même jeton en tête 61,8 % ; Q2_K moyenne 5,97, médiane 4,98, même jeton 27,4 %. Le **Q2_K produit du texte cassé** (« Here-is a complete C de로 l de de de… ») : inutilisable, ses vitesses ne valent rien. Le Q3_K_M garde un texte cohérent et identique au Q4 sur le début de la réponse testée (« Here is a complete, robust C++ program… »), mais la divergence (comparable à celle de 5 experts, §44) n'est PAS négligeable : à proposer, si on le fait, comme mode avec perte étiqueté, après un test sur tâches réelles (code qui tourne, dialogue en français).
**Réserves** : l'échelle de divergence de ce montage semble gonflée (KV q8_0 donne 0,6 alors qu'on attendrait <0,05 ailleurs) : comparer seulement les valeurs entre elles ; requantification depuis Q4 ; un seul prompt de vitesse, en anglais ; la « perplexité / perplexité de référence » du Q3 (0,95) est incohérente avec sa divergence et ne doit pas être utilisée.
**Piège découvert** : `ws_moe_probe` produit du texte cassé sur ce Gemma (« 고고고… » avec `-f prompt.txt` ; les sorties de la grille du 19/11, §42-43, finissent en « l'e' de l'e'… ») alors que `ws_npc_server` écrit du texte correct. Cause non élucidée (outil, `--ubatch 32` ou prompt) : les vitesses et taux de succès de cache de ces grilles ont été mesurés sur du texte dégénéré, dont le routage des experts diffère de celui d'un texte réel. À refaire avec `ws_npc_server` avant de s'y fier.

### 44 ter. Gemma Q3 contre Q4 sur tâches réelles (2026-11-21, 3 essais par tâche, température 0,7)
**Fonctions Python jugées par tests** (`merge_sorted`, `roman_to_int`, `chunk`, 3 essais chacune) : Q4_K_M **8/9**, Q3_K_M **4/9** (échecs du Q3 : noms de variables inventés `l_b`, `s`, tokens corrompus). **Pong** (« Crée un petit pong fonctionnel en Python ») : Q4 = un `turtle` qui tourne, un texte dégénéré (LaTeX), un pygame avec du LaTeX (`$\text{y}$`) dans le code ; Q3 = un `turtle` avec une seule faute (un « - » parasite en début de ligne), un tkinter coupé par la limite de longueur, un texte dégénéré (🚀🚀🚀…). À 3 essais, les pongs ne se départagent pas ; **le Q4 corrompt lui aussi son code par moments** (ce Gemma uncensored est fragile à température 0,7 : essayer plus bas ou avec l'échantillonnage du modèle top_k 64 / top_p 0,95). **Dialogues en français** : comparaison à l'aveugle par l'utilisateur (3 questions, `reports/comparaison_aveugle_fr.md`, non versionnés) : Q4 préféré 2 fois (finesse des détails, mise en forme plus propre), Q3 préféré 1 fois (le Q4 avait mal compris le sujet : un chat qui ne mange plus, pris pour une perte d'appétit de l'utilisateur). Sur le français le Q3 n'est donc pas clairement moins bon (3 questions, un seul essai chacune) ; son vrai défaut est le code. Conclusion : le Q3 donne ~2,3x de vitesse à VRAM égale (§44 bis) mais dégrade nettement le code ; à proposer seulement comme mode avec perte étiqueté « plus rapide mais instable » (mode `extra-light` de PAIZ), pas pour un assistant de code. Le plantage du serveur Q3 observé une fois pendant la première série (cause inconnue, journal écrasé) ne s'est pas reproduit à la relance.
