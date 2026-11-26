# Plusieurs modèles semi-chargés : conception (2026-11-07)

Objectif de l'utilisateur : garder plusieurs modèles **partiellement** en mémoire et passer de l'un à l'autre sans
tout recharger. Cas visés :

- des LLM spécialisés qui se relaient dans une conversation (code, discussion, traduction...) ;
- un LLM à côté d'un générateur d'autre chose (image dans `D:\005-GIT\l'application cliente`, plus tard audio...) ;
- des PNJ de jeu : petit modèle "tiède" qui ne garde presque rien tant qu'il ne parle pas.

Règle constante : **aucune perte**. Ce qu'on fait varier, c'est où sont les poids (VRAM / RAM / disque), jamais
les poids eux-mêmes ni le nombre d'experts utilisés.

## Ce qui existe déjà (socle posé le 2026-11-07)

| Brique | Rôle | Fichier |
|---|---|---|
| `ExpertStore::open(path, budget, max_budget)` | réserve l'espace d'adresses pour `max_budget`, n'engage que `budget` | `src/ExpertStore.cpp` |
| `ExpertStore::resize(bytes)` | agrandit ou rétrécit le cache d'experts d'un modèle ; rétrécir évince les emplacements en trop et **rend leur mémoire à Windows** (`MEM_DECOMMIT`). Entre deux tours seulement | idem |
| `ExpertStore::prefetch(layer, experts)` | lecture en arrière-plan (sert à la lecture anticipée, et servira à réchauffer un modèle avant qu'on lui donne la main) | idem |
| `ExpertBudget` | un budget RAM commun à plusieurs `ExpertStore` : le modèle "au premier plan" reçoit tout ce que les autres ne gardent pas comme plancher "tiède" ; `focus()` bascule, `set_total()` déplace toute la fenêtre | `src/ExpertBudget.cpp` |
| `ws_moe_probe --elastic-test` | rétrécit le cache à moitié puis le rétablit **en pleine génération** : texte identique vérifié (LFM2, CPU) | `tools/moe_probe.cpp` |

`ExpertBudget::apply()` rétrécit d'abord, agrandit ensuite : la somme des caches ne dépasse jamais le budget,
même pendant une bascule.

## Ce qui manque, par ordre

1. **Outil de démonstration à deux modèles** (`ws_multi_probe`, à écrire) : charger deux MoE dans le même
   processus (ex. Qwen3.6-35B-A3B pour le code + Gemma 4 26B-A4B ou LFM2 pour la discussion), chacun avec son
   `ExpertStore` sous un même `ExpertBudget`, alterner les tours, mesurer : temps de bascule (`focus()`), vitesse
   du premier tour après bascule, comparée à un rechargement complet. Vérifier que chaque modèle produit le même
   texte qu'en solo.
2. **Aiguillage des points d'accroche par modèle.** `llama_moe_set_expert_source` (GPU) et
   `ggml_cpu_set_expert_fetch` (CPU) sont globaux au processus. Deux options :
   - simple : l'orchestrateur, qui fait les `llama_decode` l'un après l'autre, pointe l'accroche sur la source du
     modèle actif avant chaque appel ;
   - générale (modèles en parallèle) : un aiguilleur qui associe le **pointeur** du tenseur (`op->src[0]` côté CPU,
     `reads[i].tensor` côté GPU) au bon `ExpertStore`. Les noms de tenseurs sont les mêmes d'un modèle à l'autre
     (`blk.3.ffn_up_exps.weight`), donc on ne peut pas aiguiller par nom : enregistrer les pointeurs vus pendant le
     premier tour de chaque modèle (ou ajouter à llama.cpp une API qui énumère les tenseurs d'un modèle).
3. **Cache VRAM redimensionnable.** Le cache d'experts VRAM de llama.cpp (`--moe-cache-mib`,
   `src/llama-moe-cache.cpp`) est alloué à la création du contexte et le graphe référence sa taille. Le changer =
   recréer le contexte : sauvegarder l'état (`llama_state_seq_get_data`), recréer avec une autre `moe_cache_size`,
   restaurer. À faire entre deux tours. Les parties communes de chaque modèle (attention, embeddings : ~1,6 Go pour
   Qwen3.6, ~2,5 Go pour Gemma 4) et leurs caches KV restent en VRAM tant que le modèle est "tiède".
4. **Modèle non-LLM (image) à côté.** Un modèle de diffusion est dense (tous ses poids à chaque étape) : le
   streamer depuis le disque à chaque étape serait trop lent. Le rôle de WeightStream y est d'**arbitrer** :
   `set_total()` rétrécit les caches des LLM quand l'image démarre, les rétablit après. ComfyUI garde déjà son
   modèle en RAM ; pour l'application cliente le gain structurel reste un LLM MoE qui cohabite avec SDXL (voir HANDOFF §7 item 9).
5. **Politique** : choisir les planchers "tièdes" (les experts les plus utilisés, fiches d'experts du §3) ;
   réchauffer en tâche de fond un modèle dont on prévoit le tour (détection de domaine : 30/30 et 18/18 au §4) ;
   rendre la mémoire au système quand rien ne tourne.

## Pièges connus

- `resize()` ne doit jamais chevaucher un `fetch()` : pas de redimensionnement pendant un `llama_decode`.
- Rétrécir sous le besoin d'une couche fait retomber l'accroche sur le mmap (correct mais lent, et le mmap
  remplit alors la mémoire de travail) : garder chaque cache au-dessus de `min_capacity_bytes()` et, en pratique,
  au-dessus de ce qu'un micro-lot demande (sinon pic de RAM, voir HANDOFF §10).
- Mesurer avec un plafond réaliste : `ws_mem_hog` seul et `ws_run_capped` seul faussent les comparaisons dans
  des sens opposés (HANDOFF §11) ; les combiner (`CAPPED=1 HOGTOO=1 scripts/ladder-moe.sh`).
