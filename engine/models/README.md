# Modèles locaux

Place ici tes fichiers `.gguf` téléchargés depuis Hugging Face.

**Ne pas committer** les modèles dans git (trop volumineux).

## Recommandations pour tester WeightStream

| Usage | Modèle | Taille ~ | Pourquoi |
|-------|--------|----------|----------|
| **Premier test pipeline** | `ws_generate_synthetic` (outil du repo) | configurable | Aucun DL, valide SSD→RAM→VRAM |
| **Test streaming réel** | [Qwen2.5-32B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-32B-Instruct-GGUF) — fichier `Q4_K_M` | ~18–20 Go | Dépasse les 12 Go VRAM, bon candidat |
| **Test léger / debug** | [Qwen2.5-7B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF) — `Q4_K_M` | ~4–5 Go | Rapide à DL, mais tient en VRAM (peu de streaming) |
| **Gros test** | [Llama-3.1-70B-Instruct-GGUF](https://huggingface.co/bartowski/Llama-3.1-70B-Instruct-GGUF) — `Q4_K_M` | ~40 Go | Exactement le cas d'usage visé |

### Format requis

WeightStream MVP lit uniquement le format **GGUF** (pas safetensors, pas PyTorch).

Sur Hugging Face, cherche des repos avec `GGUF` dans le nom, par exemple :
- `TheBloke/...-GGUF`
- `Qwen/...-GGUF`
- `bartowski/...-GGUF`

### Exemple de téléchargement

```powershell
# Avec huggingface-cli (pip install huggingface_hub)
huggingface-cli download Qwen/Qwen2.5-32B-Instruct-GGUF `
  qwen2.5-32b-instruct-q4_k_m.gguf `
  --local-dir D:\005-GIT\PAIZ\engine\models
```

Ou télécharge manuellement le `.gguf` depuis le navigateur et dépose-le ici.

### Lancer la démo

```powershell
.\scripts\build.ps1
.\build\Release\weightstream_demo.exe models\qwen2.5-32b-instruct-q4_k_m.gguf --vram-mib 12288
```
