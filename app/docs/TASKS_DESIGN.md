# Tâches de fond : plans, voies et pilotage (conception, 2026-11-19)

Idée du propriétaire : réfléchir avec Gemma dans la discussion ; quand il y a une tâche à faire, Gemma propose de produire le plan elle-même, de le confier à un plus gros modèle local (Qwen) ou à un modèle distant gratuit (OpenCode) ; le plan arrive dans la barre des tâches **sans partir tout seul**.

## Existant (déjà dans le code)
- File persistante (`src/tasks.js`), une tâche locale à la fois, texte au fil de l'eau, pause automatique si la mémoire baisse.
- Choix du modèle par tâche : modèle de la discussion ou autre `.gguf` local (second moteur lancé à la demande sur le port + 1, dimensionné sur la VRAM libre, déchargé 30 s après la fin).
- Limite « jusqu'à la fin » par défaut, avertissement quand une réponse est coupée.
- Bouton « 📋 En file » sur un message du chat.

## À construire, dans cet ordre
1. **Brouillons** : état `draft`, jamais lancé automatiquement ; lecture, édition, choix du modèle, bouton Lancer. « En file » du chat crée un brouillon.
2. **Barre de tâches** : réordonner par glisser-déposer vertical, supprimer, cases à cocher pour traiter une sélection, boutons ▶ ⏸ ■ au pied (tout ou sélection).
3. **Voies par modèle** : un seul moteur local travaille à la fois (VRAM), un modèle distant peut tourner en parallèle d'un modèle local.
4. **Voie distante** : modèles gratuits d'OpenCode. À étudier : comment les piloter depuis le serveur PAIZ.
5. **Gemma propose** : un outil « créer un brouillon de plan » exposé par le proxy PAIZ ; la réponse de Gemma offre le choix (ici / Qwen / distant).

## Notes
- Découper une tâche en morceaux n'économise pas de VRAM (le contexte relu est le même) ; ce n'est utile que pour la robustesse (points de reprise). Le moteur sait déjà faire pause/reprise exactes.
- Contexte du second moteur : 32 768 jetons ; Qwen3-Coder-Next (hybride) : 4,4 Go à 8 k, 5,0 Go à 32 k, 5,8 Go à 64 k (cache d'experts 1,5 Go).
- Mesure du duo Gemma + Qwen : voir `engine/Docs/HANDOFF_2026-11.md`, section 43.

## Précision du 2026-11-19 (soir) : le plan vient APRÈS la discussion
Chaîne voulue : **discussion → idée notée → plan (brouillon) → tâche**. On brainstorme longtemps avec Gemma, puis « synthétise-moi ça en plan » ; le modèle peut poser 2-3 questions avant de fixer le brouillon.

**Bloc-notes du projet (« To-do »)** : bouton en haut à gauche de la discussion, overlay avec les entrées du projet (titre cliquable + fiche, éditable/supprimable). Ajout : bouton « 📝 Noter » sur un message, demande au modèle (« note ça »), ou le modèle le propose lui-même. Stocké dans PAIZ (par projet), pas dans un fichier du dépôt. À la création d'un plan : panneau « inclure ces idées » (tout / sélection).

**Outils du modèle** (à vérifier) : un petit serveur MCP fourni par PAIZ (`noter_idée`, `proposer_plan`) chargé par OpenCode ; les questions = simple consigne de prompt (« au plus 3 questions, puis `proposer_plan` »).

**Ordre** : 1) bloc-notes manuel + « 📝 Noter » ; 2) brouillons + barre de tâches (ordre, ▶ ⏸ ■, cases) ; 3) outils MCP + « inclure ces idées » ; 4) voie distante (modèles gratuits d'OpenCode).

## Précision du 2026-11-19 (nuit) : rédiger le plan est une tâche, avec son propre modèle
Après la discussion, une fenêtre « Faire un plan » s'ouvre : choix du **modèle qui rédige** (Gemma / Qwen / distant plus tard), contexte transmis (N derniers messages de la discussion, idées cochées du bloc-notes, notes libres) et option « laisser Gemma résumer d'abord » (réduit le contexte envoyé au gros modèle ; coût en temps de lecture non mesuré). Validation => tâche de type `plan` en file (second moteur si Qwen). À la fin : notification + **brouillon** dans la barre de tâches ; l'utilisateur lit, édite, choisit le modèle d'exécution (éventuellement différent de celui qui a rédigé), puis lance.
Types de tâches : `plan` (produit un brouillon) et `exec` (produit le résultat).
