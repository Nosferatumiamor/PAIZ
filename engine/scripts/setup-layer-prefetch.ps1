param(
    [switch]$SkipTorch
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Venv = Join-Path $Root "python\.venv"
$Req = Join-Path $Root "python\layer_prefetch\requirements.txt"
$Upstream = Join-Path $Root "python\layer_prefetch\_upstream"

Set-Location $Root

if (-not (Test-Path $Venv)) {
    Write-Host "[setup] Creation venv python\.venv ..."
    & py -3 -m venv $Venv
}

$Py = Join-Path $Venv "Scripts\python.exe"
$Pip = Join-Path $Venv "Scripts\pip.exe"

if (-not $SkipTorch) {
    Write-Host "[setup] PyTorch CUDA (cu121) - peut prendre plusieurs minutes ..."
    & $Py -m pip install --upgrade pip
    & $Pip install torch --index-url https://download.pytorch.org/whl/cu121
}

Write-Host "[setup] llm-layer-prefetch (local) + deps ..."
& $Pip install -r $Req

Write-Host "[setup] Verification imports ..."
& $Py (Join-Path $Root "python\layer_prefetch\verify_imports.py")

Write-Host "Done. Lance: WeightStream Layer Prefetch.bat"
