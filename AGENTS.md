# AGENTS.md

Guide pour les agents de code (Claude Code, Cursor…) qui travaillent dans ce dépôt.

## Où est quoi

- `app/` : application PAIZ (Node >= 24, Tauri pour l'exe). Tests : `cd app && npm test`. Le serveur est `app/src/server.js`, le relais OpenAI `app/src/proxy.js`, le moteur est piloté par `app/src/engine.js`.
- `engine/` : moteur C++ (ex-« WeightStream »). Son `engine/AGENTS.md` et `engine/README.md` décrivent la partie historique (moteur par pages, obsolète en partie).
- **Lire d'abord `engine/Docs/HANDOFF_2026-11.md`** (sa dernière section est le point de reprise) ; conception multi-modèles : `engine/Docs/MULTI_MODEL.md` ; service de personnages : `engine/Docs/NPC_SERVER.md`.
- `engine/third_party/llama.cpp` est un sous-module épinglé (6c01da62). Les crochets sont un correctif : `engine/Docs/patches/llama-weightstream-hooks-6c01da62.patch` ; après modification, le régénérer avec `git -C engine/third_party/llama.cpp diff > engine/Docs/patches/llama-weightstream-hooks-6c01da62.patch`.
- Le `CMakeLists.txt` racine du moteur ne compile pas tel quel : utiliser `engine/scripts/build-llama.ps1` puis `engine/scripts/build-ws-tools.ps1`.

## But du projet (fixé par le propriétaire) — à lire avant toute mesure

PAIZ ne **court pas après llama.cpp en vitesse**. Il fait tourner les mêmes modèles avec **moins de ressources**, ou sur des machines où ils ne tourneraient pas :

1. petits modèles « corrects » (discussion, PNJ) avec presque rien ;
2. modèles moyens (Gemma 10-15 Go) avec nettement moins de VRAM et de RAM, génération plus lente acceptée, résultat identique ;
3. modèles plus gros que la machine : ils doivent tourner et finir par une réponse cohérente, même lentement.

La métrique principale est donc **les ressources divisées par N pour le même texte** (VRAM crête, RAM crête du processus, CPU) ; la vitesse est le prix payé, jamais l'objectif. **Sans perte par défaut** (jamais moins d'experts, de couches sautées ni rien qui change le texte, sauf demande). Les modes avec perte (ex. version Q3 « extra-light ») ne sont permis que comme options explicites, étiquetées, qui disent ce qui est perdu, sur quels réglages et pourquoi on l'accepte ; jamais mélangés aux chiffres sans perte.

## Règles de travail

- Les modèles vivent sur le NVMe (`C:\llm-models`), **jamais sur `D:`** (disque dur lent).
- Ne jamais tuer un processus par son nom : seulement par PID, et seulement ceux dont on connaît l'origine. Ne jamais lancer de test « hog + cap » (a figé la machine).
- Ne reconstruire l'exe PAIZ que lorsque PAIZ est fermé.
- Moteur : MSVC `/W4 /permissive-` ; garder les changements sans avertissement. Les vérifications d'invariants de débogage (`debug_*`) existent parce que le système a eu de vrais bugs d'éviction : les activer plutôt que les couper.
- `engine/third_party/llama.cpp` est une dépendance : lecture seule, sauf changement qui concerne vraiment les crochets (via le correctif).
