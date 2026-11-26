# PAIZ-WeightStream

Un outil, deux fonctions autour des LLM locaux :

1. **PAIZ (distributeur de modèles)** : catalogue multi-disques, tri, doublons, déplacement vérifié, corbeille, liens.
   Le SSD NVMe est la racine **active** (modèles en service) ; les disques lents sont des racines **store** (archives à froid).
2. **WeightStream (moteur)** : sert un GGUF en API **compatible OpenAI** (`ws_npc_server`, experts MoE streamés SSD → RAM → VRAM),
   donc branchable sur **OpenCode** et tout client OpenAI.

Le lien entre les deux : **« invoquer » un modèle** = le sortir de l'archive vers le SSD, lancer le moteur dessus,
et ranger les autres modèles vers les disques lents pour ne pas saturer le disque de travail.

## État (2026-11-13, v0.3.0-dev — fondations)
- Base PAIZ 0.2.0 reprise telle quelle (`src/`, `public/`, `src-tauri/`, tests). Depuis novembre 2026 PAIZ vit dans le dépôt PAIZ (dossier `app/`, le moteur est dans `engine/`).
- `src/engine.js` (nouveau) : lance/arrête `ws_npc_server`, profils eco/normal/confort/cpu, invocation (déplacement → démarrage → rangement),
  génération de la config OpenCode.
- API ajoutée : `GET /api/engine`, `POST /api/engine/summon`, `POST /api/engine/start`, `POST /api/engine/stop`, `GET /api/engine/opencode`.
- Le moteur C++ est dans **`../engine/`** (dossier voisin de `app/`) : PAIZ le trouve tout seul (réglage `engine.dir` / variable `WS_HOME`,
  `engine.exe` pour un autre chemin). Docs du moteur : `../engine/Docs/NPC_SERVER.md`, `../engine/Docs/MULTI_MODEL.md`.

## Utiliser
```powershell
npm start                                   # http://127.0.0.1:7788  (Node >= 24)
# enregistrer les racines (une fois) : le SSD actif et une archive
node src/cli.js add-root ssd C:\llm-models --role active
node src/cli.js add-root archive "D:\Modeles" --role store
node src/cli.js scan
# invoquer un modèle (id du catalogue), le ranger autour, brancher OpenCode
curl -X POST localhost:7788/api/engine/summon -d '{"assetId":12,"profile":"normal","shelve":true}'
curl localhost:7788/api/engine/opencode      # JSON à mettre dans opencode.json
```
Test à blanc prévu avec le Gemma 4 26B-A4B ; le gros Qwen coder (48 Go) sera retéléchargé plus tard pour le vrai test archive → SSD.

## À faire (ordre proposé)
1. **UI** : onglet « ⚡ Moteur » fait (invoquer, profil, rangement, brancher OpenCode, journal) ; reste à tester le flux Invoquer de bout en bout avec un vrai modèle (le test visuel n'a servi qu'au rendu).
2. **Test de bout en bout** : invoquer Gemma 4 depuis une archive, appeler `/v1/chat/completions`, valider avec OpenCode (outils/function calling : à vérifier côté `ws_npc_server`).
3. **Rangement automatique** : politique (taille max du SSD actif, dernier usage) au lieu du simple « tout ranger ».
4. **Packaging** : Tauri embarque PAIZ ; décider si `ws_npc_server.exe` + DLL CUDA sont livrés avec (licences llama.cpp, taille).
5. **Contexte long / OpenCode** : `-c 8192` par défaut est trop court pour un agent de code ; régler `engine.ctx` et mesurer le coût KV.
6. Renommer proprement les restes « mdisp » (CLI, dossier `.mdisp-trash`) en gardant la compatibilité.

## Vérifié le 2026-11-13 (Gemma 4 26B-A4B, ws_npc_server, port 8780)
- **Appels d'outils : OK**, en non-streamé et en streamé (SSE) : `finish_reason: "tool_calls"`, arguments JSON corrects. Premier appel ~45 s (chargement du modèle).
- Défaut mineur : `content` contient `<|channel>thought\n<channel|>` (balise de réflexion vide de Gemma 4) à nettoyer côté moteur.
- Le streaming envoie des commentaires SSE `: ws-working` pendant le préremplissage (ignorés par les clients).
- **OpenCode** : le `opencode.jsonc` de l'utilisateur (`~/.config/opencode/opencode.jsonc`) branche Ollama avec `provider.<id>.npm = "@ai-sdk/openai-compatible"` + `options.baseURL` ;
  `GET /api/engine/opencode` produit exactement la même forme pour le moteur (`http://127.0.0.1:8770/v1`).

## Brancher OpenCode (fait, sans bricolage)
`node src/cli.js opencode` (état) puis `node src/cli.js opencode connect` ; ou `GET /api/engine/opencode/status`, `POST /api/engine/opencode/connect`.
Ajoute le fournisseur `weightstream` dans `~/.config/opencode/opencode.jsonc` (variable `OPENCODE_CONFIG` pour un autre chemin), sans toucher aux autres fournisseurs,
avec sauvegarde `.bak-<date>`. Si le fichier avait des commentaires, ils sont perdus (signalé dans `commentsLost`; la sauvegarde les garde).
Le modèle déclaré est le modèle chaud du moment (sinon `local`) : relancer « connect » après avoir invoqué un autre modèle. Testé sur une copie du fichier réel. À faire : bouton dans l'onglet « Moteur ».

## Interface (2026-11-13) : trois grands onglets
- **⚡ WeightStream** : Moteur (invoquer / état), Tester (chat avec vitesse en jetons/s), Réglages (profil, contexte, slots, KV, port, options), Connexions (OpenCode en un clic + extraits pour client OpenAI, curl, Python, Continue, Open WebUI, Cline).
- **◈ Model Dispenser** : l'ancien PAIZ (catalogue, disques, doublons, scanner, réglages).
- **🩺 Entretien** : santé des disques (Get-PhysicalDisk + compteurs de fiabilité ; USB/droits : état global seulement), « chasse d'eau » des caches d'applis LLM (Hugging Face, torch, whisper, Coqui TTS, llama.cpp… ; Ollama/LM Studio/GPT4All/Jan listés à part, hors chasse d'eau globale), sauvegarde incrémentale d'une racine vers un autre disque (robocopy).
- Sécurité de la chasse d'eau : liste blanche d'emplacements (aucun chemin fourni par le client), confirmation obligatoire côté serveur et dans l'UI, refus si le cache chevauche une racine PAIZ, suppression définitive (pas de corbeille). `PAIZ_FAKE_HOME` redirige les emplacements pour les tests.
- ATTENTION : le cache Hugging Face de cette machine contient les poids de Qwen3-TTS, Kokoro et RealVisXL utilisés par d'autres applis (ComfyUI…) : les vider les fait retélécharger.

## Sécurité des déplacements (vérifié par test, 2026-11-16)
- **Place avant tout :** contrôle préalable (`checkTransferSpace`, route `GET /api/transfer/check`) ; refus HTTP 409 avec un message clair si le disque cible n'a pas la place (taille + marge de 1 %, min 256 Mo). Vaut pour déplacement, déplacement groupé, étagère (ranger ET restaurer), invocation et téléchargement. Un déplacement sur le même disque est un renommage (0 octet requis).
- **Source supprimée seulement après preuve :** SHA-256 complet calculé pendant la copie (source) et RELU sur le disque cible ; taille identique requise ; au moindre écart la copie est effacée et la source reste intacte. Le SHA-256 est enregistré dans le catalogue. Tests : `test/transfer-safety.mjs` (C: vers D:), `test/shelf.mjs`. Non testé : une corruption volontaire (le chemin d'échec n'a pas été déclenché).
## Découvrir (Hugging Face)
Onglet 🔭 : recherche/tri (téléchargements, likes, tendance, récents), fichiers GGUF avec taille et quantification, modèles multi-parties regroupés, contrôle de place par destination, téléchargement avec reprise (.part) et vérification du SHA-256 publié par Hugging Face. `src/hub.js`, `test/hub-download.mjs` (télécharge 1,2 Mo ; ignoré hors ligne).
