# WeightStream — Roadmap

Document vivant. Priorités ordonnées : **d’abord prouver le streaming**, ensuite l’offload dynamique.

## Cible matérielle de référence

| Ressource | Valeur |
|-----------|--------|
| GPU | RTX 3060 — 12 GiB VRAM |
| RAM | 32 GiB système |
| Stockage | SSD NVMe |
| Modèles visés | 30–50 GiB (GGUF quantisé) |

Objectif produit : **+30 % à 2×** d’utilisation effective du hardware via tiering SSD → RAM → VRAM, pas la perfection algorithmique.

---

## Phase 1 — Streaming de poids (en cours)

**But :** faire tourner un modèle plus gros que la VRAM (et idéalement que la RAM utile) sans figer la machine.

| Jalon | Statut |
|-------|--------|
| Pages 32 MiB + `read_at()` branché sur cache RAM | Fait |
| Équivalence SSD (`ws_read_equiv` @ 32 GiB, sans éviction) | Fait |
| Config réaliste 32 GiB RAM par défaut | Fait |
| Intégration llama.cpp (byte reader, `ws_infer`) | En cours |
| Garde-fou saturation mémoire système | En cours |
| Modèle 40–50 Go stable sur config référence | À faire |
| Bug éviction @ 8 GiB cache (corruption heap) | Gelé — priorité basse |

**Hors scope Phase 1 :** coalescing SSD réactivé, ASan complet, optimisations micro.

---

## Phase 2 — Politiques d’exécution (API seulement)

**But :** préparer l’architecture sans implémenter l’algo dynamique.

```cpp
enum class ExecutionPolicy {
    GpuOnly,        // tout sur GPU si possible (comportement -ngl élevé)
    CpuOnly,        // debug / fallback
    HybridStatic,   // = llama.cpp : N premières couches GPU, reste CPU
    HybridDynamic,  // réservé — scheduler décide à la volée (Phase 3)
};
```

Livrables Phase 2 :

- `ExecutionPolicy` dans `Config.h`
- Branchement minimal : `GpuOnly` / `HybridStatic` délèguent à `-ngl` llama
- `HybridDynamic` = stub (log + fallback `HybridStatic`)
- Doc du contrat **data scheduler** vs **compute scheduler**

**Critère de passage vers Phase 3 :** `ws_infer` charge + génère sur Qwen 32B @ 32 GiB avec `-ngl 35` sans crash système.

---

## Phase 3 — Offload dynamique (WeightStream 2.0)

**But :** WeightStream devient un **runtime scheduler** à deux axes :

| Axe | Question |
|-----|----------|
| **Data** | Où sont les poids ? SSD / RAM / VRAM |
| **Compute** | Où tourne le calcul ? GPU / CPU |

### Ce que llama.cpp fait aujourd’hui

Décision **figée au chargement** :

```text
Couches 0..N-1 → GPU
Couches N..fin → CPU
```

Simple, efficace, mais pas adaptatif.

### Ce que WeightStream pourrait faire

Le scheduler connaît déjà : pages, prefetch, profil `.wsprofile`, pression mémoire.

Décision **à la volée**, guidée par le profil (on sait que layer 22 → 23 → 24 arrive) :

```text
Couche X :
  coût transfert GPU = T_pcie
  coût calcul CPU   = T_cpu
  coût calcul GPU   = T_gpu
  → choisir le min sous contrainte VRAM/RAM
```

Exemples :

- LayerNorm petite : transfert GPU 8 ms, CPU 5 ms → **CPU**
- Matmul Q4 grosse : CPU 80 ms, GPU 4 ms → **GPU**

### Nuances importantes

1. **Granularité** : les pages VTMM (32 MiB) ≠ les couches. Le placement compute se fait au niveau **couche / tensor / op ggml**, pas page.
2. **Intégration llama** : le byte reader suffit pour le streaming de poids ; l’offload dynamique demandera probablement des hooks plus haut niveau (backends / graphe).
3. **KV cache** : la pression mémoire en génération change la donne ; la policy doit l’intégrer.
4. **Mesures** : un modèle de coût fiable demande du profiling (PCIe, kernels) — gros chantier, pas MVP.

### Tiers de calcul (vision long terme)

```text
Tier 0 : GPU
Tier 1 : CPU (AVX2 / kernels ggml)
Tier 2 : CPU lent / quant spécialisé
```

À traiter après le placement GPU/CPU de base ; ggml gère déjà une partie des kernels CPU.

---

## Phase 4 — Production / polish (lointain)

- Cache thermique HOT/WARM/COLD (RFC-0002)
- Coalescing SSD stable + réactivation
- Multi-modèles, plusieurs consommateurs
- Métriques exportables (Prometheus, etc.)
- **PAIZ multiplateforme (Linux / macOS)** — noté le 2026-11-19, à faire après la stabilisation des modes. Tauri sait déjà afficher l'interface sur Linux (WebKitGTK) et macOS (WKWebView) ; `npm start` marche déjà dans un navigateur. Les vrais verrous :
  1. isoler dans un petit module les appels propres à Windows côté PAIZ (RAM disponible via PowerShell/CIM, suivi des processus enfants, chemins `C:llm-models` / `D:` en dur, lancement de programmes) et utiliser des chemins configurables (premier pas, utile même sans multiplateforme : audit en liste) ;
  2. construire le moteur (`ws_npc_server` et outils) avec CMake au lieu de `cl.exe` + scripts PowerShell, d'abord en CPU seul (portable) ;
  3. GPU : CUDA sous Linux, Metal sous macOS (les hooks d'experts en VRAM sont écrits pour CUDA : à réécrire pour Metal) ;
  4. packaging par système (.deb/AppImage, .dmg).
- **Machines sans GPU NVIDIA (ex. Surface Pro 2 : i5-4200U, 4/8 Go de RAM, SSD SATA, Intel HD 4400)** — moteur CPU seul + `--cpu-stream`. Gemma 26B-A4B (≈ 4 Md de paramètres actifs, ≈ 2 Go lus par jeton) pourrait y finir une réponse cohérente avec 8 Go de RAM (estimation 0,3 à 1 tok/s, non mesurée) ; pas avec 4 Go. À mesurer d'abord en simulation sur le PC actuel (moteur CPU, 2 cœurs, RAM plafonnée avec `ws_run_capped`), avant tout travail de packaging.

---

## Principes de priorisation

1. **Data avant compute** — pas d’offload dynamique tant que le tiering SSD→RAM→VRAM n’est pas démontré en inférence réelle.
2. **Lent mais vivant** — préférer ralentir (throttle, eviction) à saturer la RAM et freezer Windows.
3. **API avant algo** — enums et stubs pour ne pas bloquer l’évolution sans livrer la complexité.
4. **Concept, pas perfection** — un benchmark convaincant sur 32B @ 3060 vaut mieux qu’un scheduler théorique.

---

## Outils UX (Phase 1)

| Outil | Rôle |
|-------|------|
| `ws_specs` | Détecte CPU / RAM / GPU et estime la taille de modèle atteignable |
| `ws_chat_ui` | Micro-interface web : chat, console, jauge RAM, curseur quota garde-fou |

Vision long terme : faire tourner de petits modèles (Gemma ~1–4 Go) sur du matériel très limité (eeePC, tablette) via streaming SSD agressif + garde-fou adaptatif.

---

## Références

- `Docs/WeightStream RFC-0001` … `RFC-0004` — vision architecture
- `README.md` — build et outils
- `scripts/run-realistic.ps1` — validation rapide (~3 min)
- `scripts/run-chat-ui.ps1` — interface de test locale

- **Variantes de moteur : ce que fait Jan (janhq/jan, relevé le 2026-11-19, README + Makefile + build.rs lus, licence « non déclarée » côté GitHub : on reprend des idées, pas du code)** — llama.cpp compilé en bibliothèque dans un petit programme (`jan-llama-worker`), pas de moteurs à télécharger séparément. `JAN_ENGINE_VARIANT` = liste de jetons (`cpu`, `vulkan` par défaut, `cuda12`, `cuda13`, `rocm`/`hip`, `metal`, combinables : `cuda13-hip-vulkan`). **Vulkan est inclus dans toutes les variantes** comme repli si le runtime CUDA/ROCm manque ou est trop vieux. Backends chargés à l'exécution (`GGML_BACKEND_DL`) et CPU multi-versions (`GGML_CPU_ALL_VARIANTS` : un module par micro-architecture, ggml choisit le meilleur au lancement) : un seul installateur sert tous les processeurs. CUDA 12 et 13 sont des builds séparés (GPU couverts différents). Diagnostic matériel intégré (les tests d'opérations de llama.cpp, par appareil : « le modèle est mauvais » ou « le noyau de cette machine est cassé ? »). À reprendre pour nous : (1) variantes `cuda` (streaming complet) / `vulkan` / `cpu` (`--cpu-stream`) du moteur, choisies au démarrage selon le matériel détecté, repli automatique ; (2) CPU multi-versions pour les machines sans AVX2 comme la Surface Pro 2 ; (3) un test matériel rapide avant le premier chargement. Réserve : nos crochets de streaming (ExpertStore, feuilles d'experts) supposent CUDA, le chemin Vulkan/Metal reste à écrire.
