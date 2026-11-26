# ws_npc_server : service local pour personnages (2026-11-07)

Un seul processus charge un modèle et sert : (1) une API **compatible OpenAI** (`/v1/chat/completions`, `/health`,
`/props`, `/v1/models`) pour qu'un client écrit pour `llama-server` (comme l'application cliente) puisse pointer dessus ;
(2) des **fiches de personnages** (prompt système + historique persistant) avec chat par nom ; (3) des **ressources
réglables en marche** ; (4) une petite page web (`http://127.0.0.1:8770/`).

```powershell
.\scripts\build-ws-tools.ps1                      # construit aussi ws_npc_server.exe (httplib compilé une fois)
build-llama\bin\ws_npc_server.exe -m C:\llm-models\gemma-4-26B-A4B-it-UD-Q4_K_M.gguf --ws-ram-mib 3000 --cache-mib 1024 --slots 2 -c 4096
```
Sans `--ws-ram-mib` c'est un llama.cpp ordinaire (n'importe quel modèle, y compris dense : NemoMix) ; avec, les experts
MoE sont streamés depuis le SSD par WeightStream. `--cpu-stream` : experts calculés sur CPU, aucune VRAM d'experts.
Le modèle se charge à la première requête (ou `POST /api/resume`). Options : `--port`, `--data-dir`, `--ubatch`,
`--chat-template-file f.jinja` (comme `llama-server`), `--ws-max-mib` (plafond des redimensionnements du cache RAM). `--profile paliers` : voir section 37 du handoff.

**Lanceur** : double-clic sur `WeightStream.bat` (ou `.\scripts
un-npc-server.ps1`). Premier lancement : menu des modèles de
`C:\llm-models` et choix d'un profil de ressources (Eco / Normal / Confort / CPU seul) ; le choix est mémorisé
(`ws_npc_data\launcher.json`) et les lancements suivants repartent dessus sans question ; `WeightStream.bat -Ask` (ou le raccourci `WeightStream - choisir le modele.bat`) pour
changer. Options : `-Model`, `-Profile eco|normal|confort|cpu`, `-Port`, `-Ctx`, `-Slots`, `-NoBrowser`. Ouvre la page
web quand le service répond ; Ctrl+C l'arrête proprement.

## Principes
- **Fil (thread)** = un cache KV. `--slots N` fils tiennent en mémoire ; les autres **dorment sur disque** (cache KV
  sauvegardé, ~10-50 Mo) et se réveillent à la demande, le moins récent cédant la place. Le cache KV est unifié : les
  états sauvegardés restent valides si on change le nombre d'emplacements.
- **Réutilisation de préfixe** : le client renvoie toute la conversation (comme avec llama-server) ; le service compare
  avec ce que le cache contient et ne préremplit que la suite (champ `timings.cache_n` / `tokens.reused`). Modèles
  hybrides (LFM2, Qwen3.6) : pas de coupe partielle possible, donc réutilisation seulement si la requête prolonge
  exactement le cache ; sinon refaire le préremplissage (correct, plus lent).
- Identité d'un fil pour `/v1/chat/completions` : champ `thread` ou `user` de la requête, sinon empreinte du premier
  message système (un personnage = un cache). Pour `/api/characters/<nom>/chat` : `char:<nom>`.
- Échantillonnage de llama-server reconnu : `temperature, top_k, top_p, min_p, repeat_penalty, presence_penalty,
  frequency_penalty, repeat_last_n, dry_multiplier, dry_base, dry_allowed_length, dry_penalty_last_n,
  dry_sequence_breakers, seed, max_tokens/n_predict, stop`, `stream` (SSE), `enable_thinking` (défaut : non).
- Les requêtes sont traitées une à la fois (pas de lot parallèle dans le service ; le lot de plusieurs personnages
  simultanés reste dans `ws_moe_probe --npc-script`).

## Contexte plein
- **Pendant une réponse** : si le cache KV sait se décaler (modèles à attention : Gemma 4 vérifié), quand le contexte est
  plein les plus anciens échanges sont retirés (la moitié de ce qui suit le prompt système) et la génération continue
  sans s'arrêter ; `tokens.context_shifts` du chat compte les décalages. Vérifié : 700 jetons générés dans un contexte de
  512, 2 décalages, texte cohérent. Le prompt système est conservé. Hybrides/récurrents (LFM2, Qwen3.6) : le cache ne peut
  pas se décaler, la réponse s'arrête au contexte plein (`finish_reason: "length"`) : à confirmer, non testé ici.
- **Avant une réponse** (chat des personnages) : les plus anciens échanges sont retirés de l'historique pour laisser au
  moins `min(1024, n_ctx/4)` jetons libres pour la réponse ; si même le dernier message ne laisse pas cette marge, il est
  tenté avec ce qui reste.
- Un contexte plus grand (`-c`) coûte du KV (Gemma 4 : ~110 Mo pour 1000 jetons par fil).

## Mémoire des personnages : résumé glissant
L'historique complet d'un personnage est toujours conservé. Quand la conversation approche de la taille du contexte
(prompt + réponse > 70 % de `-c`, ou des échanges ont dû être écartés du prompt), le service plie **en tâche de fond** les
plus anciens échanges dans un **résumé** écrit par le modèle chargé lui-même (faits, noms, lieux, relations, promesses, ce
qui reste en suspens ; ~200 mots), en gardant verbatim les derniers échanges (~40 % du contexte). Le résumé est envoyé
au modèle dans le prompt système du personnage (`[Résumé de la conversation précédente]`). Il est visible et modifiable dans
l'interface (volet « Mémoire (résumé) » au-dessus de la discussion, boutons « Enregistrer le résumé » et « Résumer
maintenant »).
- API : `GET /api/characters/<nom>` renvoie `summary` et `summary_upto` (nombre de messages couverts) ; `PUT` accepte
  `summary` ; `POST /api/characters/<nom>/summarize` force un résumé ; `/api/status` -> `memory` {busy, character, queued,
  last_error} ; `reset` efface historique et résumé.
- **Mesuré** (Gemma 4, `-c 1024`, 7 tours) : 3 résumés successifs, `summary_upto` 2 -> 4 -> 8 sur 14 messages, le résumé garde
  les faits des premiers tours (prénom, ville, nom du chien, sœur, budget) ; le prompt reste sous ~700 jetons.
- **En arrière-plan, sans bloquer le chat** : le résumé est produit par petites tranches (64 jetons de prompt, puis 8 jetons
  générés à la fois) ; entre deux tranches, une conversation qui attend le moteur passe devant (`fg_waiting`), puis le résumé
  reprend là où il en était (son cache KV est gardé). Mesuré (Gemma 4, `-c 1024`) : un message envoyé pendant un résumé de
  81 s a répondu en 14,3 s, 8,9 s et 7,8 s (7,1 s sans résumé), au lieu d'attendre la fin du résumé. Le préremplissage du
  résumé se fait sans le « préremplissage rapide » (il aurait bloqué le moteur pendant tout le prompt), donc le résumé lui-même
  est plus lent qu'en bloc ; il avance quand le moteur est libre.
- **Coûts restants** : chaque mise à jour du résumé change le prompt système, donc le cache de préfixe du fil est perdu une
  fois (préremplissage complet au tour suivant) ; un message qui arrive attend au plus une tranche (quelques secondes) ; un
  résumé peut perdre ou déformer un détail : d'où la possibilité de le relire et de le corriger. Pas d'index vectoriel
  (retrouver un souvenir ancien par similarité) : non fait.

## Précision du cache KV (`--kv-type`, ou champ « Cache KV » de l'interface)
`f16` (défaut, sans perte), `q8_0`, `q4_0` (`--kv-type-k` / `--kv-type-v` pour régler K et V séparément ; la
quantification active l'attention flash). Changer la précision recharge le contexte ; les états de fils enregistrés ne
sont valables que pour la précision qui les a produits (empreinte).
- **Mesuré** (Gemma 4, prompt de 2361 jetons, état KV enregistré) : f16 247 Mo, q8_0 131 Mo (-47 %), q4_0 69 Mo (-72 %).
  La vitesse n'a pas changé de façon nette (mesures bruitées). **Le texte change** (température 0) : dès les premiers mots
  avec q8_0 comme avec q4_0 ; ce n'est donc **pas sans perte**, contraire à la règle du projet : option facultative, à
  réserver aux grands contextes ou aux machines justes, pas activée par défaut.

## API
| Appel | Rôle |
|---|---|
| `GET /api/characters`, `GET/PUT/DELETE /api/characters/<nom>` | fiches : `{system, notes}` ; `GET` renvoie aussi l'historique |
| `POST /api/characters/<nom>/chat` `{message, stream?, max_tokens?, temperature?...}` | réplique ; l'historique le plus ancien est élagué si le contexte déborde. `stream:true` : flux d'événements `data: {"delta":...}` puis `{done:true, reply, finish_reason...}` ; fermer la connexion arrête la génération. Sans `max_tokens` la réponse n'est plus coupée (fin naturelle, ou contexte plein : `finish_reason: "length"`) |
| `POST /api/stop` | interrompt la génération de chat en cours (la partie produite est gardée dans l'historique, `finish_reason: "stopped"`) |
| `POST /api/characters/<nom>/reset` | efface l'historique et le cache du fil |
| `GET /api/status` | état, ressources, fils (éveillé / endormi), cache d'experts, RAM du processus, VRAM libre |
| `POST /api/resources` `{slots?, n_ctx?, cache_mib?, ws_ram_mib?}` | cache RAM : sur place ; le reste : nouveau contexte (fils endormis, réveil au besoin) |
| `POST /api/model` `{path?, profile?}` | change de modèle et/ou de mode (`eco`, `normal`, `confort`, `cpu`, `plain`) à chaud : l'ancien modèle est déchargé (fils et fiches d'experts sauvegardés dans son dossier), le nouveau chargé (~12 s mesurés), ses pré-caches construits selon leur politique ; en cas d'échec l'ancien revient. Le choix est écrit dans `<data-dir>/launcher.json` (le lanceur repart dessus). L'interface a le même sélecteur (liste des `.gguf` de `--models-dir`, par défaut le dossier du modèle de départ) |
| `POST /api/suspend` / `POST /api/resume` | décharge le modèle (VRAM et RAM rendues, fils sauvegardés) / le recharge (aussi automatique à la requête suivante) |

Astuce Windows : depuis un shell, un corps JSON avec accents passé en argument (`curl -d '...'`) arrive abîmé ; utiliser
`--data-binary @fichier.json`.

## Fiches d'experts (volet « Experts du modèle » de l'interface)
Pendant le service, chaque expert (couche, numéro) est compté chaque fois que le routeur du modèle le choisit, et
rangé sous un **domaine** : le nom du personnage pour `/api/characters/<nom>/chat`, sinon le champ `domain` de la
requête OpenAI (défaut `general`). Ce sont les `ExpertSheets` de WeightStream (fichier
`<data-dir>/expert_sheets.wssheets`, relu au démarrage si le modèle et ses dimensions sont les mêmes, enregistré tous les
10 échanges, à la suspension et à l'arrêt). Chemin GPU : observateur de llama.cpp (toutes les sélections) ; chemin
`--cpu-stream` : routage lu dans le crochet CPU. Modèle dense : pas de suivi.
- Page web, onglet **Experts du modèle** : choix du domaine (ou tous), carte de chaleur couches x experts, concentration
  (part des usages couverte par les 1 / 5 / 10 / 25 / 50 % d'experts les plus sollicités), tableau des 30 experts les plus
  utilisés (usages, part, **affinité** = combien plus ce domaine les utilise que la moyenne), et, en cliquant une case, la
  **fiche de l'expert** : usages et affinité dans chaque domaine.
- API : `GET /api/experts?domain=`, `GET /api/experts/heatmap?domain=`, `GET /api/experts/expert?layer=&expert=`,
  `POST /api/experts/save`, `POST /api/resources {preheat: true|false}`.
- **Préchauffage** : quand une requête change de domaine (et que ce domaine a au moins 500 observations), ses experts
  les plus utilisés sont épinglés et chargés en tâche de fond dans le cache RAM (`ExpertStore::set_profile`). Son effet
  sur la vitesse n'a pas été remesuré dans le service (mesures antérieures : HANDOFF §3-§4).
- Sur Gemma 4 (30 couches x 128 experts), quelques échanges ne suffisent pas à dessiner de spécialités (carte presque
  uniforme, affinités autour de 1) : il faut des centaines de requêtes par domaine.

## Mesures (Gemma 4 26B-A4B, cache VRAM 1 Go, cache RAM 3 Go, `reports/server_test/`)
- Fil réveillé depuis le disque : 124 à 239 jetons réutilisés, il se souvient (« Aldric »).
- `POST /api/suspend` : RAM du processus 4,6 Go -> 0,5 Go, VRAM libre 6,6 Go -> 11,2 Go, en ~1 s.
  Reprise : ~8 s de chargement du modèle + préremplissage du fil.
- Changement de cache RAM 3000 -> 1500 Mo et de fils 2 -> 3 : < 1 s, sans perte des fils.
- Modèle hybride (LFM2) : le tour suivant d'un personnage réutilise 115 jetons sur 133.
- **Préremplissage rapide** (`--prefill-ubatch 512`, défaut ; `0` = désactivé). Avec le micro-lot économe (`--ubatch 32`)
  le préremplissage va à ~8 jetons/s (2240 jetons : 291 s, pic de mémoire de travail 6 Go), parce que chaque couche relit
  ses experts toutes les 32 jetons. Avec un gros micro-lot, chaque couche lit ses experts une fois pour des centaines de
  jetons : 2240 jetons en 17-32 s (64 à 130 jetons/s) mais le modèle entier passe par la mémoire (pic 13,8 Go). Le service
  fait donc « charge complète puis dégraissage » : pour un prompt à préremplir de plus de 128 jetons il reconstruit le
  contexte avec le gros micro-lot (fils sauvegardés puis restaurés), préremplit, retire le premier jeton, reconstruit le
  contexte en mode économe pour la génération et rend les pages au système (`EmptyWorkingSet`) : mémoire de travail 2,8 Go
  après. Le pic de 13,8 Go est transitoire mais réel : à désactiver sur une machine qui n'a pas ce marge. Les requêtes
  suivantes d'un même fil réutilisent le préfixe (2231 jetons sur 2245 : 2,1 s). Attention : des requêtes sans message
  système partagent le même fil (clé = premier message système) ; passer `thread` pour les séparer.

## Dossiers par modèle et pré-caches
Tout ce qui ne vaut que pour un fichier de modèle (fiches d'experts, états KV des fils, liste des fils) est rangé sous
`<data-dir>/models/<nom>-<empreinte>/` (l'empreinte vient du nom et de la taille du fichier) avec un `model.json`
(chemin, taille, dernière utilisation). Un nouveau modèle repart donc d'un dossier propre ; l'ancien reste jusqu'à purge.
- Gestion du stockage : voir « Stockage des pré-caches » ci-dessous.

Un **pré-cache** est un préfixe (prompt système, fiche de personnage) préempli une fois et gardé sur disque comme état KV.
La **recette** (`<data-dir>/precaches/<nom>.json`) ne dépend pas du modèle ; l'**état** appartient au modèle. Changer de
modèle ne coûte que la reconstruction des états, au moment prévu par la politique de chaque recette :
- `load` : `startup` (le modèle est chargé et l'état construit au lancement du service), `first_use` (à la première
  utilisation du modèle : le service démarre sans charger le modèle), `manual` (seulement sur demande).
- `keep` : `true` (l'état survit à la fermeture du service, défaut) ou `false` (supprimé à l'arrêt).
- `thread` : fil visé ; par défaut la clé que la route OpenAI déduit d'un message système identique, donc une requête
  qui commence par ce système réveille l'état directement.

| Appel | Rôle |
|---|---|
| `PUT /api/precaches/<nom>` `{system, load?, keep?, thread?}` | crée ou modifie une recette |
| `GET /api/precaches` | recettes, état (`ready`/`missing`), taille de l'état, dernière construction |
| `POST /api/precaches/<nom>/build`, `/clear`, `DELETE /api/precaches/<nom>` | construire maintenant / effacer l'état / supprimer la recette |

- **Mesuré** (Gemma 4, prompt système de 2361 jetons) : construction 17 s (préremplissage rapide) ; état de 258 Mo ;
  après redémarrage du service l'état est retrouvé sans reconstruction ; première requête : **1,7 s** de préremplissage
  contre **38,9 s** sans pré-cache. Politique `first_use` vérifiée (rien n'est chargé au lancement, état construit à la
  première utilisation) ; `keep:false` (nettoyage à l'arrêt propre) non testé.
- **Limites** : l'état pèse ~110 Mo pour 1000 jetons sur Gemma 4 (plusieurs états = plusieurs centaines de Mo) ; sur
  les modèles hybrides (LFM2, Qwen3.6) il ne sert que si la requête prolonge exactement le préfixe ; il ne raccourcit
  que le préremplissage, pas le chargement du modèle (~8 s). Un client qui envoie son corps en
  `application/x-www-form-urlencoded` (curl par défaut) reçoit un 413 au-delà de quelques Ko : utiliser
  `Content-Type: application/json` (les clients OpenAI le font).

## Stockage des pré-caches (plafond, inactivité, suppression)
Volet **Modèles et pré-caches** de l'interface (ou l'API) : pour chaque modèle connu, son fichier, son dernier usage,
son dossier WeightStream **avec le chemin** de chaque pré-cache et sa taille, et des conseils.
- `GET /api/models` : `models[]` (`dir`, `precaches[{name,path,bytes}]`, `idle_days`, `pinned`, `model_file_present`,
  `advice[]`), total des pré-caches, plafond, réglages.
- **Suppression avec le modèle** : `DELETE /api/models/<id>` sans `?confirm=1` répond 409 avec ce qui serait supprimé
  (dossier, taille, pré-caches) ; avec `?confirm=1` il supprime le dossier. Seules les données de WeightStream partent
  (fiches d'experts, états, pré-caches), jamais le fichier du modèle ni le modèle en cours. Un modèle dont le fichier a
  disparu est signalé (« fichier absent ») avec la taille récupérable.
- **Modèle inutilisé** : après `precache_ttl_days` (défaut 30) le service conseille de vider ses pré-caches
  (« can be re-generated next time you use this model »). `POST /api/models/<id>/clear-precaches` les vide ;
  `PUT /api/models/<id> {pin:true}` épingle un modèle (exempté de tout nettoyage et de tout remplacement).
- **Plafond** `precache_cap_mib` (défaut 1024, 0 = illimité) : total des états de pré-caches de tous les modèles. Quand
  une construction le dépasserait, rien n'est ajouté : un build automatique (`startup`/`first_use`) reste en
  `blocked_by_cap`, et `POST /api/precaches/<nom>/build` répond 409 avec les **pré-caches remplaçables** (modèles les moins
  récemment utilisés, ni courant ni épinglés) ; `?evict=auto` les remplace. Avant construction la taille est estimée
  (mesure d'un état existant, sinon ~120 Ko par jeton de recette).
- **Durée de vie** : `auto_clean` (défaut non) : au lancement, les pré-caches des modèles inactifs depuis
  `precache_ttl_days` sont vidés, **sauf** le modèle en cours, le **dernier modèle utilisé** (même s'il est ancien) et les
  modèles épinglés. `POST /api/housekeeping` donne le plan sans l'appliquer (`{"apply":true}` l'applique, bouton
  « Nettoyage proposé… »).
- Réglages : `GET/POST /api/settings` (`precache_cap_mib, precache_ttl_days, auto_clean`, enregistrés dans
  `<data-dir>/settings.json`) ; options de lancement `--precache-cap-mib N`, `--precache-ttl-days N`,
  `--auto-clean` / `--no-auto-clean` (prioritaires sur le fichier).
- **Vérifié** (faux modèles anciens, états de 136 Mo) : conseils d'inactivité et de fichier absent ; aperçu de suppression ;
  plan de nettoyage qui épargne l'épinglé et le courant ; plafond 400 Mo : build refusé avec candidats, puis `evict=auto`
  remplace les plus anciens ; `--auto-clean` vide au lancement. Non testé : suppression confirmée via l'interface.

## Appels de fond qui s'effacent devant le dialogue (`"background": true`)
`POST /v1/chat/completions` accepte `"background": true` (réponse non diffusée) : la génération se fait **par tranches** (64 jetons de prompt, puis
8 jetons générés à la fois, sur un fil `bg:<clé>` supprimé à la fin). Entre deux tranches, tout dialogue ou toute décision `/v1/decide` en attente
passe devant ; le travail de fond reprend ensuite (attente bornée à 10 min). Pour les résumés de vieux jours, notes du jour, etc. : un dialogue
n'attend jamais plus d'une tranche. Mesuré (Gemma 4, profil lean) : un dialogue lancé 8 s après le début d'un travail de fond (23 s au total)
répond en 3,7 s. Le texte peut différer légèrement d'un appel normal en décodage glouton (prefill par 64 au lieu de 512 : arrondis différents).
Côté l'application cliente : `llm.background_slices` (défaut vrai) ajoute le drapeau aux appels `background=True`.

## Travaux de fond reprenables (`/api/jobs`)
Pour une longue génération en arrière-plan (modèle lourd, des heures), qui doit survivre à un plantage, une coupure ou une
pause volontaire. Chaque jeton produit est ajouté à un **journal** (`<data-dir>/jobs/<id>/tokens.bin`, vidé à chaque jeton)
et le **cache KV** est enregistré toutes les `checkpoint_s` secondes (défaut 300 ; écriture dans un fichier temporaire puis
renommage atomique : un plantage en cours d'écriture laisse le point précédent intact). La reprise recharge le dernier point
de reprise, ne refait le préremplissage que de la queue du journal, et continue. Les caches d'experts ne sont pas
sauvegardés (ils se reconstruisent depuis le SSD).

| Appel | Rôle |
|---|---|
| `POST /api/jobs` `{name?, messages | prompt, max_tokens, temperature..., checkpoint_s?}` | crée et met en file un travail ; renvoie `{id}` |
| `GET /api/jobs`, `GET /api/jobs/<id>` | état (`queued/running/paused/done/failed/cancelled`), jetons produits, dernier point de reprise, texte (partiel puis final) |
| `GET /api/jobs/<ws_job>/live` | texte en cours d'écriture d'une requête `/v1` **avec outils** (404 sinon) : pour ces requêtes le flux OpenAI est retenu jusqu'à la réponse complète (un appel d'outil n'a de sens qu'entier), cette route permet d'afficher la réponse au fur et à mesure |
| `POST /api/jobs/<id>/pause`, `/resume`, `/cancel` | pause (point de reprise immédiat), reprise, abandon |

Au démarrage, un travail trouvé `running` (le processus est mort) ou `queued` (arrêt propre par Ctrl+C, qui fait un point
de reprise) repart tout seul ; `--no-resume-jobs` les met en pause à la place. Le contexte `-c` doit couvrir le prompt et
tout ce qui sera généré (un travail de plusieurs heures demande un grand `-c`, donc un KV plus gros à enregistrer).
- **Mesuré** (Gemma 4, 120 jetons à température 0, `reports/jobs/`) : processus tué brutalement (`taskkill /F`) à 80 jetons,
  relancé, le travail repart seul de son point de reprise et rend un texte **identique octet pour octet** à celui d'un
  run ininterrompu ; idem après pause à 44 jetons puis reprise par l'API. Point de reprise : 22 Mo à 200 jetons.
- **Limites** : le travail occupe le service (une requête à la fois) : le mettre en pause pour discuter. On perd au plus
  `checkpoint_s` secondes de calcul (le journal garde les jetons, mais le KV doit être recalculé depuis le dernier point,
  ce qui se fait à la vitesse du préremplissage, plus vite que la génération). Hors température 0, le texte repris est
  une continuation valide mais pas identique à celle d'un run sans interruption (l'aléa du tirage repart de la graine).
  Une coupure de courant peut perdre la fin du journal (vidage disque forcé seulement à chaque point de reprise) : on
  retombe alors sur le dernier point, sans incohérence.

### Requêtes `/v1/chat/completions` reprenables (`ws_job`)
Une requête de chat **en flux** qui porte `"ws_job": "<id>"` (lettres, chiffres, `_`, `-`, 80 car. max ; choisi par l'appelant : la
même requête a toujours le même id) est exécutée **comme un travail** : journal des jetons, point de reprise du KV toutes les
`ws_checkpoint_s` secondes (défaut 60), et elle apparaît dans `/api/jobs` (`origin: "v1"`, `attached: true`). Le thread KV reste
celui de la conversation (la réutilisation du début du prompt entre deux étapes d'un agent est conservée).
- `POST /api/jobs/<id>/pause` : la génération s'arrête au prochain jeton (ou entre deux micro-lots du prompt) avec un point de
  reprise ; **la requête reste ouverte** (commentaires `: ws-working` toutes les secondes) ; `status: "paused"`,
  `pause_reason: "user"`. `/resume` repart exactement de là (le flux continue sur la même connexion) ; `/cancel` abandonne et oublie.
  `pausing: true` tant que la pause n'est pas prise. RAM critique (profil `paliers`) : même chose avec `pause_reason:
  "memory_critical"` au lieu du HTTP 503 (en attente d'un `/resume`).
- Connexion perdue (client parti, moteur tué) : le travail reste `interrupted` (ou `paused`) avec son journal. Renvoyer **la même
  requête** (même `ws_job`) le rattache : le texte déjà produit est rejoué (`"ws_skip_chars": N` = octets de texte que le client a
  déjà reçus, non renvoyés), la génération continue exactement (restauration du point de reprise + rejeu de la queue du journal).
  Un travail terminé renvoie sa réponse stockée sans toucher au modèle. `POST /api/jobs/<id>/cancel` sur un travail sans requête
  attachée l'oublie (à faire une fois la réponse livrée). Les travaux `v1` abandonnés sont purgés après 3 jours au démarrage.
- Après un plantage, un travail `v1` n'est PAS relancé tout seul (personne ne l'écoute) : il attend sa requête.
- Mesures : voir `Docs/HANDOFF_2026-11.md` section 39.

## Raccordement avec l'application cliente (lecture seule du code, rien n'a été modifié dans l'application cliente)
l'application cliente parle à `llama-server` en HTTP (`client/llm/client.py`) : `GET /health`, `GET /props` (vision), `POST
/v1/chat/completions` avec `stream` et des paramètres d'échantillonnage (`min_p`, `dry_*`, `repeat_penalty`...), un
seul slot et un verrou à deux priorités. Points de raccord :
1. **Même API** : `llm.base_url` pointé sur ws_npc_server (port 8770), `llm.manage_server=false`. `chat-template-file`
   (`config/templates/mistral-nemo.jinja`) se passe avec `--chat-template-file`. Aucun autre changement.
2. **Arbitre GPU** (`client/images/engine.py` ~l.200-215) : aujourd'hui il tue `llama-server` avant l'image puis le
   relance en tâche de fond (`_reload_llm`, 1 à 2 min à froid) ; avec le service il suffirait d'appeler
   `POST /api/suspend` puis (ou rien : reprise paresseuse) `POST /api/resume` ; les fils (l'application cliente principale, digestion,
   impressions...) sont sauvegardés et réveillés sans repréremplir. Un modèle MoE streamé laisse en plus la possibilité de
   ne pas décharger du tout : réduire `cache_mib` / `ws_ram_mib` via `/api/resources` pendant l'image.
3. **Multi-personnages** : les fiches de `characters/*/` de l'application cliente sont des personnages riches (mémoire SQLite,
   prompt assemblé par `chat/prompt.py`) ; elles resteraient chez l'application cliente, qui enverrait son prompt assemblé avec un
   `thread` par personnage. Les `/api/characters` de ce service servent aux PNJ simples et aux tests.
4. `LlamaServer.stop_any()` / `external_pid()` cherchent un process nommé « llama-server » : à adapter si on veut qu'il
   gère ws_npc_server (nom d'image différent).

## Choix du modèle pour l'application cliente (avis, rien de téléchargé)
- **NemoMix-Unleashed-12B** est dense (Mistral Nemo) : WeightStream n'a rien à streamer ; le service le sert comme un
  llama.cpp ordinaire (utile pour l'A/B), et l'apport restera le suspend/resume rapide et les fils.
- **Mistral-MOE-4X7B-Dark-MultiVerse-24B** (DavidAU, GGUF sur Hugging Face, fusion de quatre Mistral 7B en style Mixtral,
  étiquetée NSFW / fiction) est un MoE au sens de llama.cpp, donc compatible. Mais seulement **4 experts, 2 actifs par
  token** (à vérifier sur la fiche) : on lit la moitié des experts à chaque token, loin de Gemma 4 (8 sur 128) ou
  Qwen3.6 (8 sur 256). Le gain de RAM sera modeste, la lecture disque par token élevée, donc lent en streaming ; et il
  repose sur d'anciens Mistral 7B. À mesurer avant d'y croire.
- La voie plus prometteuse pour « un modèle plus intelligent à ressources limitées » est un **MoE très creux**
  (beaucoup d'experts, peu actifs) avec un bon français et une version non censurée ou ajustée pour le jeu de rôle :
  Gemma 4 26B-A4B donne un très bon français mais est aligné ; Qwen3.6 traduit parfois littéralement.
  Recommandation : tester le service avec NemoMix tel quel (continuité), puis comparer des MoE creux non censurés avec
  le même scénario de personnages (`ws_moe_probe --npc-script`) avant de choisir.

## Outils agentiques (appels d'outils, OpenCode et consorts)

`/v1/chat/completions` accepte `tools`, `tool_choice` et `parallel_tool_calls`, ainsi que les messages `assistant` avec
`tool_calls` et les messages de rôle `tool`. Les messages et outils sont convertis et rendus par le code de llama.cpp
(`common_chat_msgs_parse_oaicompat`, gabarit jinja du modèle) ; la sortie du modèle est analysée par le parseur du gabarit
et renvoyée sous forme `tool_calls` (`finish_reason: "tool_calls"`). Avec `tools`, le mode flux ne diffuse pas le texte au
fil de l'eau : le serveur envoie des commentaires SSE de maintien (`: ws-working`) pendant la génération, puis le message
complet (contenu, `reasoning_content`, `tool_calls`) d'un bloc. `usage` est renvoyé aussi en flux.

Testé (Qwen3.6-35B-A3B, mode normal) : appel `read_file` correct, puis réponse correcte au tour suivant avec le résultat
d'outil (préfixe de 323 jetons réutilisé). Pas testé avec OpenCode lui-même.

À régler côté client (voir la documentation d'OpenCode, fournisseur compatible OpenAI) : URL de base
`http://127.0.0.1:8770/v1`, outils activés pour ce modèle, limites de contexte réalistes, délais longs (le débit est faible).
Côté serveur : un contexte d'agent demande `-c` de 32000 ou plus (le cache KV coûte de la mémoire, voir `--kv-type`), et
une seule requête est traitée à la fois (les autres attendent).

## Profils adaptatifs « partagé » et « à fond » (`--profile`)

Les caches d'experts se calculent au chargement d'après la RAM disponible et la VRAM libre, bornés par la taille du modèle.
- **partagé** : laisse ~8 Go de RAM et ~1,5 Go de VRAM aux autres programmes.
- **à fond** : ne garde qu'environ 4 Go de RAM pour Windows, et ~0,3 Go de VRAM ; fermer les programmes voisins aide.
- Sans GPU utilisable (moins de 2,5 Go de VRAM libre), les experts passent sur le CPU.
- Choisis dans le sélecteur de l'interface, avec `--profile NAME`, ou dans le lanceur. Éditer à la main les tailles repasse en « custom ».

Mesures (Qwen3-Coder-Next 48,5 Go, RTX 3060, prompt de code, 2e passe, `-c 4096`, une seule requête répétée, à froid) :

| Cache RAM / VRAM | tok/s | RAM libre |
|---|---|---|
| 0,7 / 0,5 Go (éco) | 1,1 | 4,4 Go |
| 4 / 2 Go | 2,1 | 9,2 Go |
| 12 / 2 Go | 3,9 | 1,6 Go |
| 4 / 9 Go | 4,5 | 8,3 Go |
| partagé (7,6 / 8,1 Go, calculé avec 15,5 Go dispo) | 4,6 | 6,2 Go |
| à fond (11,7 / 9,3 Go) | 5,9 | 3,5 Go |
| 12 / 10 Go (écrit à la main) | 5,9 | 1,1 Go |
| 16 / 10,5 Go (écrit à la main) | 6,8 | 0,2 Go (machine à bout) |

La VRAM rapporte plus que la RAM. Le cache VRAM de 10 Go laisse ~0,4 Go de VRAM libre sur 12 Go.

## Régulateur de mémoire (marge réglable, `--mem-margin-mib`)

Les profils adaptatifs « partagé » et « à fond » règlent la marge de RAM laissée aux autres programmes (25 % ou 12,5 % de la RAM
totale, modifiable par `--mem-margin-mib N` ou le champ « Marge mémoire (Mo) » de l'interface ; 0 = pas de régulation). Pendant la
génération, entre deux tokens, le serveur mesure la mémoire disponible toutes les 2 s :
- au-dessus de la marge (+10 %) : le cache RAM d'experts grandit d'environ 10 % par pas, tant qu'il reste de la place ;
- entre la moitié de la marge et la marge : il ne bouge pas ;
- sous la moitié de la marge : il se réduit (20 % ou le déficit) jusqu'à un plancher (≈ 2 Go), et de courtes pauses (100 à 400 ms)
  sont insérées entre les tokens pour laisser souffler le système.
Chaque ajustement est écrit dans la console (`[governor] ...`) et l'état est dans `/api/status` (`governor`) ; la page d'état est
bloquée pendant une génération. Le cache VRAM n'est pas régulé (fixé à la création du contexte).

## Vitesses (« gears ») et priorisation des experts

**Vitesses.** Le curseur de l'interface (panneau de ressources, smileys de 😇 « Ange » à 🤬 « Ultra furieux ») dit combien de la machine le modèle peut prendre. Chaque vitesse
fixe la marge de RAM laissée aux autres programmes, en part de la RAM totale : 50 %, 38 %, 27 %, 18 %, 11 %, 6,5 % (vitesses 1 à 6), et la VRAM laissée libre. Case **Auto** : le serveur regarde
le CPU utilisé par les autres programmes (temps CPU du système moins le nôtre) ; plus ils sont occupés, plus il se met en retrait, et quand ils se calment il reprend de la place
progressivement (il recule d'un coup, avance lentement). Quelle que soit la vitesse, un seuil dur (le plus grand de 1,2 Go et 3,5 % de la RAM) déclenche le recul rapide du cache et les
pauses : on ne va jamais jusqu'à étrangler la machine. Option de ligne de commande : `--gear auto|1..6` ; API : `POST /api/resources {"gear": 0..6}` (0 = auto) ; `/api/status` →
`governor.gear`, `gear_eff` (vitesse réelle en auto), `busy` (0 à 1). Profil « partagé » = auto, « à fond » = vitesse 6, sauf choix explicite. Fixer une marge en Mo à la main
désactive les vitesses (le champ « Marge mémoire » n'est envoyé que s'il est modifié).

**Priorisation par l'usage.** En plus des fiches d'experts par domaine, le serveur garde un poids vivant par expert : chaque expert sollicité ajoute un poids croissant avec le temps (les
anciens usages s'effacent, demi-vie ≈ 300 pas de décodage). Pendant une longue tâche sur un même sujet, les mêmes experts reviennent et dominent ; tous les ≥ 100 pas, si l'ensemble
des plus sollicités a changé de plus de 15 %, ils sont épinglés dans le cache RAM (jusqu'à 3/4 des emplacements). Quand la conversation change d'objet, l'ensemble se recompose de lui-même.
Activé par la case « préchauffer… » ; `/api/status` → `live_priority` (`steps`, `repins`, `hot_experts`).

## Décisions : `POST /v1/decide` (une passe, des probabilités, pas de texte)

Pour les « modèles de décision » (le décideur, d1, etc.) comme pour n'importe quel modèle chargé : on envoie un état et une question à choix, le serveur fait **une seule passe** et lit, à la première
position de réponse, la softmax des logits des lettres des options (A, B, C…). Corps : `{state, question, options:[…]}` ou `{state, questions:{nom:{type:"choice"|"noul"|"score",
instructions, options | criteria | scale}}}` ; en option `system`, `temperature` (calibration, 1 par défaut, > 1 aplatit), `abstain_below`, `key` (fil KV réutilisé). Réponse : `results[nom]` avec
`probs`, `answer`, `confidence`, `letter_mass` (part de probabilité réellement portée par les lettres : proche de 1 = la lecture est fiable) et `p_true` (noul) ou `expected` (score).
Les questions sur le même état partagent son préfixe dans le cache KV.

## Deux modèles côte à côte : dialogue + décideur

```powershell
.\scripts\run-npc-server.ps1 -Model C:\llm-models\gemma-4-26B-A4B-it-uncensored-Q4_K_M.gguf -Profile partage `
    -DeciderModel C:\llm-models\Decider-v3-26B-A4B-Q4_K_M.gguf -DeciderProfile normal -NoBrowser
```

(`--decider-model`, `--decider-profile eco|normal|confort|cpu`, `--decider-ctx N` en ligne de commande.) Le second modèle est un second
moteur dans le même processus, avec son propre `ExpertStore` et son propre cache VRAM, aux plafonds **fixes** du profil choisi (pas
de régulateur). `/v1/decide` passe par lui, le reste (chat, personnages, jobs) par le modèle principal. `/api/resume` et `/api/suspend`
chargent/libèrent les deux ; `/api/status` ajoute un bloc `decider`.

Les points d'accroche de llama.cpp sont globaux au processus : chaque `llama_decode` prend un verrou commun et repointe les accroches
sur le `ExpertStore` du moteur qui décode (`Engine::bind_hooks`). Deux générations simultanées (un dialogue de Gemma et des décisions
de le décideur) s'entrelacent donc token par token, sans se mélanger. La mémoire du décideur est retirée de ce que le profil adaptatif du
modèle principal voit comme libre (il prend moins de cache VRAM).

Mesuré (RTX 3060, Gemma Q4 `partage` + le décideur Q4 `normal`) : chargement des deux 20 s ; Gemma seul avec le cache VRAM réduit 12-23 tok/s
(contre 37-51 avec toute la VRAM) ; 3 questions de décision 34-36 s (le décideur n'a que 3 Go de cache pour 15,6 Go d'experts : chaque
passe relit la plupart des experts sur le SSD) ; en simultané le dialogue de 350 tokens met ~2 min au lieu de ~20 s. Le GPU est plein (12,0 / 12,3 Go).

### Phases : un pool de RAM qui glisse vers le modèle qui va travailler

`-AutoPhase` (`--auto-phase`) ou `POST /api/phase {"phase":"decide"|"speak"|"image"|"flat","wait":ms}`. Les deux caches d'experts de RAM
partagent un **pool** ; il glisse par paliers de ~20 % (rétrécir d'abord, entre deux tokens, depuis le thread qui génère) vers le modèle
qui va travailler, l'autre garde un plancher « tiède » (2 Go). Le modèle qui reçoit la place épingle et précharge ses experts les plus
utilisés (fiches d'experts). En mode auto : le pool va au décideur dès qu'une requête `/v1/decide` arrive, au modèle principal quand
elle finit ou quand un chat démarre, et au décideur quand le chat finit (le joueur lit et réfléchit).

Le pool n'est pas fixe : `mémoire disponible + ce que nos caches tiennent déjà - marge du régulateur` (plafonné par `--phase-pool-mib`,
par défaut 60 % de la RAM, 20 Go au plus). Il suit donc les autres programmes et ne se bat pas avec le régulateur de mémoire.

Mesuré (RTX 3060, 32 Go, Firefox ouvert, Gemma Q4 + le décideur Q4) : pool 4,5-8,5 Go à la vitesse auto (~4), 10-13,5 Go à la vitesse 6 ; le
glissement complet prend moins de 25 s (largement dans un temps de lecture) ; Gemma 18-28 tok/s au lieu de 5-16 avec un pool qui ignorait
la marge. **Les décisions de le décideur restent à ~19 s pour 3 questions** : le cache de RAM est chaud (100 % de succès, zéro lecture disque
sur la passe mesurée), le coût est ailleurs : le **cache VRAM d'experts de le décideur est de 1 Go**, chaque passe renvoie donc presque tous les
experts de la RAM vers la VRAM (des milliers de petits transferts). Le levier suivant est le cache VRAM, pas la RAM (recréation de
contexte pendant la lecture : ~1-2 s mesuré).

### Bascule VRAM et questions groupées (2026-11-09)

`-AutoPhase` bascule désormais le **cache VRAM d'experts** (somme des deux = un pool) vers le modèle qui va travailler : recréation du
contexte pendant la lecture (0,6-1,9 s mesuré par modèle, fils en veille sur disque, réveil 0,3-0,4 s). La RAM reste figée aux tailles des
profils (`-PhaseRam` / `--phase-ram-slide` pour la faire glisser aussi). Un chat ou une décision qui arrive attend la fin de la bascule en cours.
`/v1/decide` passe toutes les questions d'un état en **une seule passe** (préfixe commun une fois, `seq_cp`, suffixes de chaque question
dans le même micro-lot) ; réponse : `passes`, `new_tokens`. `--decider-slots` (6), `--decider-ctx` (2048), `--decider-ubatch` (512).

Mesuré (Gemma Q4 + le décideur Q4, RAM de le décideur 14 Go, vitesse 6) :
- décisions (3 questions) : 5,7-6,1 s après une bascule (cache VRAM de le décideur 5,2 Go), 19-23 s sans (1 Go) ;
- **mais Gemma repart avec un cache VRAM vide** après la bascule inverse : 8-10 tok/s (contre ~23 chaud) ; un tour (3 décisions + réponse de
  350 tokens) coûte ~44-54 s avec la bascule contre ~38 s en statique ; la bascule ne gagne que pour des réponses courtes (< ~200 tokens) ;
- regrouper les questions ne change rien au temps (7,6-8,4 s contre 6,4-7,6 s), quelle que soit la taille du micro-lot (32 : 9,9 s, 128 : 10,5 s,
  512 : 7,6-8,4 s) : le préfixe commun était déjà partagé par le fil, et le coût suit les tokens (~18 tok/s de prefill), pas les passes ;
  les probabilités groupées/séparées concordent à 0,06 près ;
- le cache VRAM d'experts de llama.cpp ne sert pas les gros lots (`get_slot_map` renvoie null au-dessus de `max_batch`) : le prefill passe par
  les poids de l'hôte.
Piste : préchauffer le cache VRAM juste après la bascule (API de préchargement dans `llama-moe-cache.cpp`, ~2 s attendu), ce qui supprimerait le démarrage à froid.

#### Correctif (2026-11-09, plus tard) : le partage statique gagne, la bascule VRAM n'est pas nécessaire

Après le regroupement des questions et le micro-lot de 512 du décideur, les 3 décisions de le décideur prennent **6,7-7,7 s même avec 1 Go
ou 512 Mo de VRAM** (23 s avant, quand chaque question faisait ses propres passes en micro-lots de 32) : un gros lot ne passe pas par le
cache VRAM (`get_slot_map` renvoie null au-dessus de 32 tokens), il lit les experts via le cache de RAM. Les mesures « bascule VRAM »
ci-dessus comparaient donc à une référence périmée. Configuration recommandée, sans `-AutoPhase` :

```powershell
.\scripts\run-npc-server.ps1 -Model C:\llm-models\gemma-4-26B-A4B-it-uncensored-Q4_K_M.gguf -Profile partage `
    -DeciderModel C:\llm-models\Decider-v3-26B-A4B-Q4_K_M.gguf -DeciderProfile normal -DeciderRamMib 14000 -DeciderCacheMib 512 -NoBrowser
```

Mesuré : le décideur 7,6 s pour 3 décisions ; Gemma 14 tok/s à froid puis 31,7 tok/s ; 18,7 tok/s pendant que le décideur décide (au lieu de 10-14).

Le **préchargement du cache VRAM** (`llama_moe_cache_preload` dans `llama-ext.h`, `Engine::warm_vram`, appelé après chaque agrandissement
du cache par la bascule ; `--no-vram-warm` pour le couper) fonctionne : 714-777 experts en 1-2,3 s (21 s une fois, RAM froide). Il n'a pas
rendu Gemma plus rapide après une bascule (9 tok/s) : le goulot d'un démarrage à froid est aussi son cache de RAM (62 % de ses lectures
vont au SSD), pas seulement la VRAM. La bascule (`-AutoPhase`) reste disponible (utile pour une phase image), mais n'est plus recommandée.

## Préchauffage pendant la frappe (activé par défaut, `--no-typing-warm` pour le couper)

Quand quelqu'un écrit un message, le moteur se prépare avant l'envoi. L'interface (case « préchauffer pendant la frappe », ou `--typing-warm`,
ou `POST /api/resources {"typing_warm": true}`) envoie `POST /api/typing {character, draft}` toutes les 2 s environ pendant la frappe ; un
client externe (l'application cliente) peut faire pareil. Un fil de fond (`Engine::typing_loop`) fait alors :
1. charge le modèle s'il dort et réveille le fil du personnage ;
2. **petite rafale de RAM** pour le cache d'experts, selon la vitesse : 1,5 Go (ange), 1,1 / 0,8 / 0,55 / 0,38 Go, 0,25 Go (vitesse 6, qui garde
   déjà beaucoup en mémoire) ; jamais sous le seuil dur du régulateur (disponible - plancher - 512 Mo) ; `typing_boost_mib` force une valeur ;
3. précharge les experts du domaine (`warm()`) ;
4. fait passer dans le modèle les **mots terminés** du brouillon (par tranches de 32 jetons, interrompu dès qu'une vraie requête arrive ; réservé aux
   modèles dont le KV peut revenir en arrière, pas aux hybrides/récurrents).
La rafale est rendue à la fin de la réponse ou après `typing_idle_s` (90 s par défaut, `--typing-idle-s`) sans frappe (brouillon jamais envoyé) ;
elle revient à la frappe suivante. Pas de rafale sur les profils à cache fixe (eco/normal/confort), seulement le réveil et le début du message.
Statut : `/api/status` → `typing` (on, boosted, boost_mib, signals, bursts, prefilled_tokens).

Mesures (Gemma 4 uncensored, vitesse 1 « ange », historique d'environ 1 500 jetons, message de ~85 jetons, `reports` non conservés, un essai par ligne) :

| Cas | Sans préchauffage | Avec préchauffage |
|---|---|---|
| Machine chaude, lecture du prompt | 3,6 s puis 1,5 s | 0,4 s |
| Après mise en sommeil du serveur (`/api/suspend`), temps total jusqu'à la fin de la réponse (40 jetons) | 22,1 s (rechargement ~15 s + prompt 6,5 s) | 3,0 s (le chargement se fait pendant la frappe) |

Réserves : un essai par cas ; la frappe simulée est de 1,2 s par mot ; le gain sur la génération elle-même est nul ; non testé avec les autres
vitesses ni avec un vrai navigateur ; le domaine du brouillon n'est pas encore détecté (on utilise celui du personnage).
