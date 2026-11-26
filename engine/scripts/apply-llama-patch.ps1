# Applies the WeightStream hooks to the llama.cpp submodule (third_party/llama.cpp, upstream commit 6c01da62):
# the expert source/observer of the GPU expert cache, the CPU expert fetch hook, WEIGHTSTREAM_NO_PREFETCH and the
# historical byte-reader bridge. Run once after `git submodule update --init`, before scripts/build-llama.ps1.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Llama = Join-Path $Root "third_party\llama.cpp"
$Patch = Join-Path $Root "Docs\patches\llama-weightstream-hooks-6c01da62.patch"
git -C $Llama apply --check $Patch 2>$null
if ($LASTEXITCODE -ne 0) {
    git -C $Llama apply --reverse --check $Patch 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Host "WeightStream hooks already applied" -ForegroundColor Green; exit 0 }
    Write-Host "patch does not apply: is the submodule at 6c01da62?" -ForegroundColor Red
    exit 1
}
git -C $Llama apply $Patch
Write-Host "WeightStream hooks applied to third_party/llama.cpp" -ForegroundColor Green
