# Quick validation: RTX 3060 + 32 GiB RAM cache, Qwen 32B (~19.5 GiB payload).
# read_equiv ~3 min. Full ws_infer is manual (load + gen can take 10-30+ min on 32B).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "=== WeightStream realistic validation (quick) ===" -ForegroundColor Cyan

& "$Root\scripts\build-gpu.ps1" ws_read_equiv
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$Model = Join-Path $Root "models\Qwen2.5-32B-Instruct-Q4_K_L.gguf"
$Build = Join-Path $Root "build-gpu"

Write-Host "`nread_equiv 2000 samples @ 32 GiB RAM (no eviction expected)..." -ForegroundColor Yellow
& "$Build\ws_read_equiv.exe" $Model --samples 2000 --seed 42 --ram-gib 32
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`nPASS — streaming cache OK at realistic 32 GiB." -ForegroundColor Green
Write-Host "Full inference (slow, run yourself when needed):" -ForegroundColor DarkGray
Write-Host "  .\build-gpu\ws_infer.exe -m $Model --ram-gib 32 -ngl 35 -n 8 -p Bonjour"
