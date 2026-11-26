---
name: comfyui-workflows
description: Write, check and run ComfyUI workflows (node graphs for image generation) as JSON files. Use when the user wants to create or modify a ComfyUI workflow, pick nodes or models, or send a generation to ComfyUI. Works with ComfyUI idle or in --cpu mode. Tip - for this kind of work a ~15 GB model is enough and leaves VRAM free for ComfyUI.
---

# ComfyUI workflows

You write workflows as JSON files in the **API format**. ComfyUI does not need a model loaded for you to write or check them.
Helper script (Node, no install): `scripts/comfy.mjs` in this skill's folder. Run it with `node <skill folder>/scripts/comfy.mjs <command>`.

## Rules
- Never invent node names or parameters. Get the real list first: `comfy.mjs nodes` (needs ComfyUI running, even in `--cpu` mode, default `http://127.0.0.1:8188`; change with `--host http://127.0.0.1:PORT`). It writes `comfy-nodes.json` in the current folder and prints a compact summary. Use `comfy.mjs models` to list installed checkpoints, LoRA, VAE.
- Always check before giving a file to the user: `comfy.mjs check workflow.json`. Fix every error it reports.
- Do NOT queue a generation on your own. Generation needs the GPU, which this model is using. Ask the user to unload the model (button "Décharger le modèle") first, then `comfy.mjs queue workflow.json`, and afterwards `comfy.mjs free` to release ComfyUI's VRAM.
- Saved workflows of the user are in `<ComfyUI folder>/user/default/workflows/*.json` (editor format: has `nodes` and `links`). List them with `comfy.mjs list <ComfyUI folder>`. The editor format cannot be queued; to change one, rewrite it in API format (below) and tell the user to load it with the ComfyUI menu "Load" (API files load fine).

## API format
An object whose keys are node ids (strings). Each node: `class_type` and `inputs`. An input is either a value (number, string, boolean) or a link `["<source node id>", <output index>]`.

Minimal text-to-image (SD 1.5 / SDXL checkpoint):

```json
{
  "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "model.safetensors" } },
  "5": { "class_type": "EmptyLatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 } },
  "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "a red fox in the snow, photo", "clip": ["4", 1] } },
  "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "blurry, low quality", "clip": ["4", 1] } },
  "3": { "class_type": "KSampler", "inputs": { "seed": 42, "steps": 25, "cfg": 7, "sampler_name": "euler", "scheduler": "normal", "denoise": 1, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0] } },
  "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
  "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "paiz", "images": ["8", 0] } }
}
```

Outputs of `CheckpointLoaderSimple`: 0 = MODEL, 1 = CLIP, 2 = VAE. `ckpt_name` must be a file name returned by `comfy.mjs models`.

Common changes:
- **LoRA**: add `LoraLoader` (inputs `lora_name`, `strength_model`, `strength_clip`, `model`, `clip`); outputs 0 = MODEL, 1 = CLIP. Point the sampler `model` and both text encoders `clip` to it.
- **img2img**: replace `EmptyLatentImage` by `LoadImage` (`image` = file name in ComfyUI's input folder) then `VAEEncode` (`pixels`, `vae`), and set `denoise` below 1 (0.4 to 0.7).
- **Upscale**: `UpscaleModelLoader` + `ImageUpscaleWithModel` between `VAEDecode` and `SaveImage`.
- Custom nodes appear in `comfy-nodes.json` only if installed: check the name there.

## Method
1. `comfy.mjs nodes` and `comfy.mjs models` (once per session).
2. Write the workflow with only nodes found in `comfy-nodes.json`.
3. `comfy.mjs check` until it prints OK.
4. Tell the user where the file is and how to load it, or follow the unload / queue / free routine above if they ask you to run it.
