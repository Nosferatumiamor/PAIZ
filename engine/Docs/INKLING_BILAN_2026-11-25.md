# Inkling 2 Mini : bilan du 2026-11-25

**Décision : Inkling tourne sur le llama.cpp standard (b12686) seul, via `app/src/stockengine.js`. Le portage du streaming d'experts est mis de côté, rien n'est supprimé.**

## Ce qui est en place
- Second moteur choisi par l'architecture du GGUF (`inkling2_loop`), Gemma/Qwen restent sur le moteur WeightStream, inchangé.
- Réglages : `--cpu-moe --no-op-offload` (VRAM ~3,3 Go), `--reasoning-budget 0 --reasoning-effort minimal`. ~7 tok/s en génération libre.
- Plafond de RAM par `ws_run_capped` = plafond de **working set** seulement. Windows garde les pages retirées dans son cache : ce n'est pas « tourne avec N Go de RAM ».

## Le portage (branche `claude/port-inkling-streaming-71a01b`, commit `29cef9b`, local, non poussé)
Hooks WeightStream portés sur b12686 (fichier `llama-wsx.cpp`, deux patchs dont un contournement MSVC 2019).
Mesures avec purge du cache Windows (1 881 jetons de prompt) : texte identique ; à 4 Go le standard ne finit pas en 300 s, le portage en 197 s ; à 8 Go préfill à égalité (limité par le CPU), génération 3,4 -> 4,2 tok/s.
Contre : lit ~5x plus d'octets que le standard (~100 Go contre 21 Go) : lectures seulement, pas d'usure, mais charge le disque et pénaliserait un disque lent. Gain faible dès 8 Go. Cause de l'écart 335 vs 210 Mio/jeton non élucidée. Chiffres bruités (mesures uniques).

## Reporté
- Profil optionnel « RAM très courte » : seulement après validation sur une vraie machine à RAM courte et des runs répétés (éviction LRU vs aléatoire).
- Re-mesure Gemma/Qwen sous plafond dur + purge du cache Windows (les anciens paliers utilisaient `ws_mem_hog`, indulgent). Idées non testées : niveau « victime » via le cache Windows, plus de lectures parallèles pour les petits experts.
- Infobulles UI du moteur stock, installateur (+~700 Mo pour le moteur stock, `ws_run_capped.exe`), test Pong pour Inkling.
