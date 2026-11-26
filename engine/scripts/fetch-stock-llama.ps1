# Second moteur de PAIZ : télécharge llama.cpp « standard » récent (Windows, CUDA 12.4) dans engine\stock-llama\.
# Il sert aux modèles que notre moteur patché ne connaît pas encore (ex. Inkling 2 Mini, architecture inkling2_loop).
# Usage :  .\scripts\fetch-stock-llama.ps1 [-Tag b12686]
param([string]$Tag = 'b12686')
$ErrorActionPreference = 'Stop'
$dest = Join-Path (Split-Path $PSScriptRoot -Parent) 'stock-llama'
$tmp = Join-Path $env:TEMP "stock-llama-$Tag"
New-Item -ItemType Directory -Force $dest, $tmp | Out-Null
$base = "https://github.com/ggml-org/llama.cpp/releases/download/$Tag"
foreach ($f in @("llama-$Tag-bin-win-cuda-12.4-x64.zip", 'cudart-llama-bin-win-cuda-12.4-x64.zip')) {
  $zip = Join-Path $tmp $f
  if (-not (Test-Path $zip)) { Write-Host "Téléchargement de $f ..."; Invoke-WebRequest "$base/$f" -OutFile $zip }
  Expand-Archive -Path $zip -DestinationPath $dest -Force
}
Remove-Item -Recurse -Force $tmp
if (-not (Test-Path (Join-Path $dest 'llama-server.exe'))) { throw 'llama-server.exe introuvable après extraction.' }
Write-Host "Moteur secondaire prêt : $dest"
