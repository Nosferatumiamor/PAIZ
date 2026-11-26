# Lance l'UI de test (navigateur local)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

& "$Root\scripts\build-gpu.ps1" ws_chat_ui ws_specs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$Model = Join-Path $Root "models\Qwen2.5-32B-Instruct-Q4_K_L.gguf"
if (-not (Test-Path $Model)) {
    Write-Host "Modèle introuvable: $Model" -ForegroundColor Red
    exit 1
}

Set-Location $Root
& "$Root\build-gpu\ws_chat_ui.exe" -m $Model --ram-gib 32 -ngl 35
