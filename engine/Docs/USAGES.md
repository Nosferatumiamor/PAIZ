# Usages de WeightStream (a lire avant de toucher au moteur)

WeightStream sert **plusieurs usages distincts**. Chacun a sa configuration ; un nouvel usage ne doit jamais degrader les autres.

## Regle de non-regression

- Le chemin de base (un modele, un `ExpertStore`, un cache VRAM llama.cpp, `ws_moe_probe` / `ws_npc_server` sans decider) reste
  celui des usages A, B et C. Tout ce qui sert l'usage D/E (second moteur "decider", phases, bascule VRAM, `/v1/decide`
  groupe, prechargement du cache VRAM) doit etre **optionnel et inactif par defaut**.
- Apres toute modification de `tools/npc_server.cpp`, `ExpertStore` ou du patch llama.cpp : rejouer le controle de la section
  "Controles" ci-dessous (texte identique, memes ordres de grandeur).
- Un usage ne remplace pas un autre : on ajoute un profil nomme, on ne change pas les valeurs des profils existants.

## Les usages

| | Usage | Idee | Config de reference | Etat |
|---|---|---|---|---|
| A | **Petits modeles presque sans ressources** (PNJ, chat) | Plafonds tres bas, vitesse sacrifiee, le reste du PC est tranquille | LFM2-8B-A1B (5 Go) : cache VRAM 100 Mo / cache RAM 90 Mo / micro-lot 1 -> 2,2 tok/s, **RAM 0,83 Go, VRAM 0,63 Go**. 600/600 Mo / micro-lot 8 -> 4,4 tok/s, RAM 1,35 Go, VRAM 1,14 Go. CPU seul : plafond dur 3 Go -> 11,6 tok/s, 1,5 Go -> 4,0 tok/s. `--cpu-stream` cache 300 Mo : working set 0,9 Go (2,2 tok/s). Gemma 4 26B-A4B plafonne : VRAM 4 Go / RAM 4,5 Go -> 9,8 tok/s, pic RAM 4,1 Go (Handoff 9-11) | Mesure, texte identique |
| B | **Modeles moyens, moins de VRAM/RAM, meme resultat** | Gemma 10-17 Go, lent accepte | Gemma 4 26B-A4B : VRAM 6 Go / RAM 8 Go -> 19,6 tok/s (llama.cpp seul 6,6) ; 3 Go / 6 Go -> 9,0 (3,4) ; pic RAM -35 a -50 % | Mesure, mais avec `ws_mem_hog` seul : a reconfirmer sans hog (interdit, a gele le PC) |
| C | **Modele plus gros que la machine** | Tourne et finit sa reponse, sans gonfler la machine | Qwen3-Coder-Next 48,5 Go (reference) : `partage` RAM 7,6 / VRAM 8,1 Go -> 4,6 tok/s, 6,2 Go de RAM libre ; `fond` 11,7 / 9,3 Go -> 5,9 tok/s ; eco 0,7 / 0,5 Go -> 1,1 tok/s ; sortie identique a llama.cpp (`cmp`). GLM-4.5-Air 68 Go : `partage` 0,64 a 0,80 tok/s, x4-x5 vs llama.cpp sous plafond de RAM | Mesure. **Modele Qwen supprime du disque** : ne pas retelecharger sans accord ; la reference est ce tableau (Handoff 4, 24, 25, 26) |
| D | **Chatbot type l'application cliente** : le décideur (decisions) + Gemma (dialogue) + moteur d'images en alternance | Deux modeles qui se partagent RAM/VRAM, la VRAM est liberee pour ComfyUI, reconfiguration pendant que l'utilisateur lit | Gemma `partage` + le décideur RAM 14 000 Mo / VRAM 512 Mo : 3 decisions groupees en 7,6 s, Gemma 14 -> 31,7 tok/s (18,7 pendant que le décideur decide). Phases decide/speak/image, bascule VRAM, `/v1/decide` | Mesure en isole ; integration reelle a faire dans la copie `le client` |
| E | **Jeu video gourmand a cote** (a concevoir) | Le moteur du jeu prend sa VRAM/GPU/CPU ; le décideur + Gemma doivent tenir dans ce qui reste | Pas de chiffres. Variables : VRAM allouee aux modeles (ex. 2-4 Go), threads CPU limites, cache RAM bas, le décideur prioritaire sur de courtes rafales, Gemma lent mais continu, pas de bascule VRAM (le jeu n'en laisse pas) | A faire : profil `jeu`, mesure avec une charge GPU/CPU synthetique (pas de hog memoire) |

Note usage D vs E : la meme paire le décideur + Gemma n'a pas la meme config. En D, le moteur d'images est *a tour de role* (on peut
vider la VRAM pour lui). En E, la charge est *simultanee* et imposee de l'exterieur : il faut plafonner, pas alterner.

## Controles de non-regression (a rejouer apres changement du moteur)

1. **Un seul modele, sans decider** (`ws_npc_server` sans `--decider-model`) : meme sortie texte qu'avant sur un prompt fixe,
   greedy (hash de texte). Modele disponible : Gemma 4 uncensored Q4_K_M (16 Go).
2. **Plafonds bas** (usage A/B) sur Gemma : VRAM 4 Go / RAM 4,5 Go, ordre de grandeur 9-10 tok/s, pic RAM ~4 Go, texte identique
   a la reference. Pas de `ws_mem_hog`.
3. **Plus grand que le cache** (usage C, substitut du Qwen) : cache RAM tres petit (>= plancher 2 Go) sur Gemma pour forcer la
   lecture SSD ; verifier texte identique et absence de repli sur le mmap ("fetch failed, falling back" absent du log).
4. **Quand on veut revalider C pour de vrai** : il faut un modele > RAM (Qwen3-Coder-Next 48 Go ou GLM 68 Go). Decision
   utilisateur, jamais automatique.

## Etat des usages D/E dans le code

Interrupteurs : `-DeciderModel` (sinon aucun second moteur), `-AutoPhase`, `-PhaseRam`, `-NoVramWarm` (scripts/run-npc-server.ps1).
Le mutex de decodage global (`g_decode_mx`) et `bind_hooks()` sont pris aussi en mode un seul modele : c'est le point a
verifier en premier dans le controle 1.

## Resultats des controles (2026-11-09, Gemma 4 26B-A4B uncensored Q4_K_M, `ws_npc_server`, `-c 4096`, 95 jetons, temperature 0.05, seed 7)

Reference = `ws_npc_server_dev4.exe` (build du 8 nov, avant moteur decider/phases/mutex global), nouveau = build actuel. Meme DLL llama.cpp.
Scripts : `C:\llm-work\ctl\run.sh` (jetable).

| Controle | Config | Ancien | Nouveau | Texte |
|---|---|---|---|---|
| 1. Un modele, sans decider | `--profile partage` | 12,3 tok/s | 12,0 tok/s | identique (md5 `5e6d9af7f5`) |
| 2. Plafonds moyens | RAM 4500 / VRAM 4096 Mo | 9,7 / 11,3 / 11,0 tok/s | 8,5 / 10,9 / 12,4 tok/s | identique (6 runs) ; pic working set ~6,6 Go des deux cotes |
| 3. Cache minuscule (SSD) | RAM 2048 / VRAM 512 Mo | 2,9 tok/s | 3,2 tok/s | identique ; aucun repli sur le mmap ; pic working set 9,8 Go des deux cotes |

Conclusion : pas de regression mesurable sur le chemin un-modele (vitesse dans le bruit, texte identique, memes pics).
Reserves : essais courts (95 jetons), un prompt ; le pic de working set de 9,8 Go avec un cache de 2 Go est un probleme deja connu
(poids non-experts + KV + pages mappees), pas introduit ici ; le Qwen 48 Go sera a retester plus tard s'il est retelecharge.

## Prechauffage pendant la frappe (actif par defaut, `--no-typing-warm` pour le couper)

`--typing-warm` / case de l'interface / `POST /api/typing` : voir `Docs/NPC_SERVER.md`. Utile surtout en vitesse basse et pour l'usage D (l'application cliente
sait quand l'utilisateur tape). Desactive par defaut : le chemin de base est inchange. A rejouer apres changement : `C:\llm-work\ctl	yping_test.sh`.

## Empreinte reelle du profil eco sur Gemma 4 26B-A4B (2026-11-09)

Les chiffres des profils (eco 0,7 Go RAM / 0,5 Go VRAM...) sont les tailles des **caches d'experts**, pas l'empreinte du processus.
Mesure en eco (caches 700 / 512 Mo, `-c 4096`, 2 fils) : RAM privee ~5,9 Go, working set 6,7-9,3 Go (pic 10,3 Go au chargement), VRAM ~4,4-5,4 Go,
~2 tok/s (1145 caracteres en 2 min 47 chez l'utilisateur). Pas de repli sur le mmap. Origine des ~5,9 Go prives : non elucidee (poids non-experts,
KV, tampons ?). Decision utilisateur : ne pas viser a les supprimer a tout prix, la vitesse deviendrait insupportable ; a etudier plus tard si un
mode intermediaire est possible. Les etiquettes ont ete corrigees ("caches d'experts") et l'interface affiche la RAM privee.

## Profil `ultra` (ultra leger, tres lent) — 2026-11-09

Origine de l'empreinte d'eco (Gemma 4 26B-A4B, trace `WS_MEMTRACE=1` du probe) : la "RAM privee" (commit) comprend les allocations GPU sous Windows
(poids non-experts 1,6 Go, KV 0,8-1,8 Go, cache VRAM 0,5 Go, tampons de calcul 0,3-0,5 Go) + le cache RAM d'experts (0,7 Go) ; ce n'est pas de la
RAM physique en plus. La RAM physique (working set) montait, elle, a ~10 Go **pendant la lecture du prompt** : des lots de 32 jetons demandent
plus d'experts par couche que le cache RAM (328 emplacements) n'en tient, le hook retombe sur les pages du fichier mappe (cache de fichiers Windows).

| ubatch (cache 700 Mo / 512 Mo VRAM) | Lecture du prompt (183 jetons, probe) | Pic working set |
|---|---|---|
| 4 | ~2,5 jetons/s (0,4 s/jeton) | 2,7 Go (sans fuite) |
| 8 | 4,8 jetons/s | 7,2 Go (fuite partielle) |
| 16 | 18 jetons/s | 11,4 Go |
| 32 (eco actuel) | 23 jetons/s | 11,5 Go |

`--profile ultra` : caches 700 / 512 Mo, `--ubatch 4`, `--prefill-ubatch 0`, contexte 2048, 1 fil, KV q8_0, working set vide apres le chargement et
apres chaque reponse. Mesure serveur (un seul essai) : working set ~0,78 Go, commit ~3,7 Go, VRAM totale ~3,4 Go (bureau compris, ~2,6 Go pour le modele),
generation ~ la meme que l'eco (~2-5 jetons/s), **lecture du prompt ~0,4 s par jeton** (262 s pour 654 jetons avec un long historique, 83 s pour 208 jetons).
Le prompt n'est paye qu'une fois par conversation (KV conserve) et le prechauffage pendant la frappe (`--typing-warm`) le lit pendant que l'utilisateur ecrit.
Non teste : retour d'ultra a un autre profil depuis l'interface (les valeurs d'avant sont restaurees dans le code), ubatch 6, contexte 4096 en ultra.

## Profil `leger` (remplace `eco` dans les menus) — 2026-11-09

`eco` (700 / 512 Mo, lots de 32) trichait : la lecture du prompt passait par le cache de fichiers Windows (working set ~10 Go) et sa vitesse de
generation (~2 jetons/s) etait la meme que celle d'`ultra`, limitee par le SSD (~1 Go d'experts lus par jeton, cache RAM ~2 % de succes). Il reste
dans le code (`hidden`) pour le modele decideur et les anciens reglages, plus dans les menus.

Ce qui fait monter la vitesse, c'est le cache **VRAM** (Gemma 4, 80 jetons, lots de 4, contexte 2048, 1 fil, KV q8, prompt "poeme sur la mer", un essai) :

| Cache RAM / VRAM | Generation | VRAM max (bureau ~0,8 Go inclus) | Working set max |
|---|---|---|---|
| 0,7 / 0,5 Go (`ultra`) | 2,05 jetons/s | 3,4 Go | 2,8 Go (0,8 Go avec le vidage) |
| **1,5 / 1,5 Go (`leger`)** | **4,4 jetons/s** | 4,5 Go | 3,6 Go |
| 2 / 3 Go | 9,8 jetons/s | 5,9 Go | 4,1 Go |
| 3 / 4 Go | 15,6 jetons/s | 6,9 Go | 5,1 Go |

`leger` = 1,5 / 1,5 Go + les memes reglages qu'`ultra` ; lecture du prompt ~4 jetons/s (44 s pour 183 jetons, probe) sans fuite de working set ; des lots de 8 ou 12
ne sont pas plus rapides a cette taille de cache. Resultat dependant du prompt (un poeme repete beaucoup d'experts) : a refaire sur des textes varies.
Le prechauffage a la frappe marche dans tous les profils (rafale de RAM seulement avec la regulation, donc pas en `leger`/`ultra`) ; son effet est limite par
la lecture du prompt : en `ultra` 0,4 s par jeton, en `leger` ~0,25 s.

## Profils `equilibre` et `vif` (2026-11-09)

Meme famille que `leger` (lots de 4, 1 fil, KV q8, vidage du working set), contexte 4096. Gemma 4, prompt "poeme sur la mer", 80 jetons, un essai, via `--profile` :

| Profil | Caches RAM / VRAM | Generation | VRAM max (bureau ~0,8 Go inclus) | Working set max |
|---|---|---|---|---|
| `ultra` | 0,7 / 0,5 Go | 2,05 jetons/s | 3,4 Go | 0,8 Go (apres vidage) |
| `leger` | 1,5 / 1,5 Go | 4,4 | 4,6 Go | 1,7 Go |
| `equilibre` | 2 / 3 Go | 9,5 | 5,9 Go | 2,2 Go |
| `vif` | 3 / 4 Go | 16,5 | 7,0 Go | 3,1 Go |
| `partage` (adaptatif, 2 fils, contexte 4096, KV f16) | 7,7 / 7,8 Go | 12,2 | 12,0 Go (VRAM pleine) | 9,7 Go |
| `fond` | 13,9 / 8,0 Go | 17,4 | 12,0 Go | 9,2 Go |

`vif` approche `fond` en vitesse (16,5 contre 17,4) avec ~5 Go de VRAM et ~6 Go de RAM de travail en moins. Reserves : prompt de poeme (routage repetitif, a refaire sur
textes varies), un seul essai, contexte 4096 et 1 fil contre 4096 et 2 fils pour partage/fond (la comparaison n'est pas a reglages egaux). Lecture du prompt (probe, 183 jetons) :
equilibre 7,9 jetons/s, vif 11,4 jetons/s, lots de 4 meilleurs que 16 ou 32 dans les deux cas.

## Face a llama.cpp "a l'ancienne" (profil `plain`, sans streaming) — 2026-11-09

Gemma 4 26B-A4B uncensored Q4_K_M, meme prompt (poeme), 80 jetons, un essai chacun, via `ws_npc_server --profile ...` (plain : contexte 4096 x 2 fils, KV f16 ; vif : 4096 x 1 fil, KV q8) :

| | Generation | VRAM max (bureau ~0,8 Go inclus) | RAM de travail max |
|---|---|---|---|
| `plain` (tout charge) | 9,3 jetons/s | 12,0 Go (pleine) | **15,9 Go** |
| `vif` | 16,3 jetons/s | 7,0 Go | 3,1 Go |

Reserves : un prompt repetitif, reglages de contexte differents, prompt court (23 jetons) ; le gain de vitesse vient de la VRAM de 12 Go trop petite pour 15,6 Go de poids (plain deborde sur la RAM).
Le "dont privee" de l'interface comptait la VRAM (commit Windows) : retire. Le prechauffage a la frappe est actif par defaut.

## Correction : comparaison sur 4 prompts varies, et `partage` / `fond` allegés — 2026-11-09

**Correction.** Le tableau "vif approche fond" plus haut comparait seulement le PREMIER prompt (un poeme, caches froids). Sur 4 prompts d'affilee (poeme,
photosynthese, fonction Python, conseils de sommeil ; 80 jetons ; une serie par profil ; `C:\llm-work\ctl\grid2.sh`) les caches se reutilisent et l'ecart est grand :

| Profil (avant la modification) | Generation moyenne (4 prompts) | VRAM max (bureau ~0,8 Go inclus) | RAM de travail max |
|---|---|---|---|
| `ultra` | 1,8 jetons/s | 3,4 Go | 0,9 Go |
| `leger` | 4,0 | 4,3 Go | 1,7 Go |
| `equilibre` | 7,4 | 6,1 Go | 2,2 Go |
| `vif` | 11,8 | 7,3 Go | 3,1 Go |
| `partage` | 30,4 | 11,9 Go | 13,0 Go |
| `fond` | 31,1 | 12,0 Go | 13,8 Go |

`partage`/`fond` gagnent donc bien sur `vif` quand on travaille en continu, au prix de presque toute la VRAM et de 13 Go de RAM.

**Leviers mesures** (RAM fixe 3 Go, lots de 4, 1 fil) : VRAM 4 / 6 / 8 Go -> 12,0 / 19,3 / 26,1 jetons/s en moyenne. A VRAM 6 Go, RAM 3 / 6 / 9 Go -> 19,3 / 19,1 / 22,7 : la RAM
rapporte peu, la VRAM beaucoup. Mais a 11,9 Go de VRAM utilisee (carte pleine) la vitesse retombe (18,7 contre 25,6 avec 8,2 Go de cache : le pilote pagine vers la RAM systeme).

**Modifications** (`partage` / `fond`) :
1. Reglages "lean" : lots de 4, pas de prefill rapide, KV q8 (contexte 4096 et 2 fils conserves).
2. Comptage de la VRAM corrige : `apply_adaptive` ne tenait pas compte du KV (1,76 Go en f16 pour 2 x 4096 jetons sur Gemma 4, 0,93 Go en q8) ; `partage` annoncait ~1,5 Go libres
   et n'en laissait que ~0,3. Reserve minimale de 500 Mo pour ne jamais saturer la carte.

Resultat (4 prompts) : `partage` 25,6 jetons/s (avant 30,4), VRAM max 10,0 Go (avant 11,9) -> laisse ~2,2 Go ; `fond` 31,6 jetons/s (avant 31,1), VRAM max 11,0 Go (avant 12,0), RAM 13,3 Go.
`fond` : meme vitesse avec 1 Go de VRAM en moins et sans saturer la carte ; `partage` perd ~16 % de vitesse pour laisser la VRAM qu'il promet. Pas de gain de vitesse pur : le plafond de ce
modele est la taille des caches (le fichier fait 15,6 Go, la VRAM 12). Non teste : prompts longs (lots de 4 a la lecture), contexte avec 2 fils pleins, autres modeles.

## Gamme confirmee sur 6 prompts varies (2026-11-10)

Prompts : histoire, recette, JavaScript, role de tavernier (~150 jetons), traduction, informatique ; 60 jetons chacun ; une serie par profil ; `grid3.sh`.

| Profil | Generation moyenne | Lecture du prompt de ~150 jetons | VRAM max | RAM de travail max |
|---|---|---|---|---|
| `leger` | 3,8 jetons/s | 33 s | 4,3 Go | 1,7 Go |
| `equilibre` | 6,4 | 15 s | 6,1 Go | 2,2 Go |
| `vif` | 9,5 | 9,5 s | 7,0 Go | 3,1 Go |
| `partage` | 28,6 | 2,8 s | 10,2 Go | 13,4 Go |
| `fond` | 33,6 | 1,9 s | 11,2 Go | 14,6 Go |

`ultra` non remesure (1,8 jetons/s sur 4 prompts la veille). Meme ordre et memes ordres de grandeur que sur 4 prompts ; les prompts qui s'ecartent du premier sont plus lents en `vif`/`equilibre` (traduction, informatique : 6-7 jetons/s).
