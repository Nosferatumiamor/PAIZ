# Mesurer sans se tromper

Méthode reprise du skill *inference-optimisation* (sybil-solutions, licence MIT), adaptée à notre but : **moins de
ressources pour le même texte**, la vitesse étant le prix payé, pas l'objectif.

## 1. Le plafond d'abord

```powershell
node engine\scripts\ceiling.mjs C:\llm-models\gemma-4-26B-A4B-it-uncensored-Q4_K_M.gguf --vram-gbs 360 --pcie-gbs 12 --ssd-gbs 3
```

Le script lit les tailles réelles des tenseurs dans le GGUF. Il en déduit les octets lus par mot :

- les poids denses ;
- la tête de sortie ;
- les experts actifs (top-k ÷ nombre d'experts × taille des experts) ;
- le cache KV.

Il en tire les plafonds :

- tout en VRAM ;
- streaming selon le taux de succès du cache d'experts ;
- pire cas, tout depuis le SSD.

Il donne aussi la VRAM minimale du streaming (poids denses + tête + KV).

- **Les débits par défaut sont ceux de la machine de référence** (RTX 3060, PCIe 4.0, NVMe). Mesure les tiens et passe-les en options.
- **Rapporte chaque mesure en % du plafond correspondant.** Exemple : Gemma 4 26B, cache VRAM de 6 Go, 26 mots/s mesurés, contre 37 au plafond à 80 % de succès.
- **Le KV affiché est une borne haute :** la fenêtre glissante (Gemma) n'est pas déduite.

## 2. Règles d'une mesure

1. **Un seul changement par essai,** chacun avec sa propre ligne de commande, dérivée de la meilleure connue.
2. **Au moins 6 mesures par essai :** on garde la médiane. Le bruit d'une mesure à l'autre est de 5 à 10 %.
3. **Encadrer l'essai par deux témoins :** témoin, essai, témoin. L'essai est retenu seulement s'il bat les deux témoins sur la mesure visée, sans dégrader une autre mesure de plus de ~3 %. Un gain surprenant se refait.
4. **Machine stable :** sur secteur, profil d'alimentation fixe, rien d'autre sur le GPU.
5. **Sans perte = texte identique :** génération gloutonne, même graine, texte comparé caractère par caractère. Un résultat « trop rapide » est d'abord soupçonné de produire du texte cassé (voir l'avertissement sur `ws_moe_probe` dans le handoff).
6. **Ne jamais tuer le moteur en plein prefill.** Annuler la requête, attendre, puis arrêter.
7. **Tout noter, échecs compris, avec la raison.** Un résultat négatif évite de refaire l'essai.

**Interdit ici :** les tests « mangeur de mémoire + plafond » (`ws_mem_hog` avec plafond). Ils ont gelé la machine.

## 3. Pièges déjà connus ailleurs, à vérifier chez nous

- **KV quantifié (q8_0) :** il peut être nettement plus lent sur un modèle qui n'a de KV complet que sur peu de couches. Dans llama.cpp, un tel modèle est passé de 45,4 à 27 tok/s. Gemma, avec ses couches à fenêtre glissante, est dans ce cas. À vérifier avant de recommander `kvType` q8_0.
- **Décodage spéculatif (brouillon, MTP) :** dans llama.cpp, il peut faire **moins bien** que sans lui sur des prompts difficiles. Il faut mesurer le taux d'acceptation par profondeur.
- **Prefill :** le découper par étape avant d'optimiser. La taille de morceau échange débit de prefill contre pauses du décodage.
