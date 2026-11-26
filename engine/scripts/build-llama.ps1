# Builds the vendored llama.cpp (CUDA, shared libs) into build-llama\ : llama.dll, ggml*.dll and the
# upstream llama-bench / llama-cli / llama-server used as baselines. The WeightStream MoE tools link
# against these DLLs (see build-ws-tools.ps1). A first configure + CUDA build takes ~20-30 min; later
# builds are incremental (only changed llama.cpp sources recompile).
param([string[]]$Targets = @("llama", "llama-bench", "llama-cli", "llama-server"))

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$BuildDir = Join-Path $Root "build-llama"

$VsDev = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
$Cmake = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
$Ninja = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
$Nvcc = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.3\bin\nvcc.exe"

$vars = cmd /c "`"$VsDev`" >nul 2>&1 && set"
foreach ($line in $vars) { if ($line -match '^([^=]+)=(.*)$') { [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2]) } }

# a cache configured from another checkout path (e.g. after moving the repo) cannot be reused
$cache = Join-Path $BuildDir "CMakeCache.txt"
if ((Test-Path $cache) -and -not (Select-String -Path $cache -SimpleMatch -Quiet ("CMAKE_HOME_DIRECTORY:INTERNAL=" + ((Join-Path $Root "third_party\llama.cpp") -replace '\\', '/')))) {
    Write-Host "build-llama was configured for another path, reconfiguring" -ForegroundColor Yellow
    Remove-Item $cache
    Remove-Item (Join-Path $BuildDir "CMakeFiles") -Recurse -Force -ErrorAction SilentlyContinue
}

& $Cmake -G Ninja -S (Join-Path $Root "third_party\llama.cpp") -B $BuildDir -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON `
    -DCMAKE_CUDA_ARCHITECTURES=86 -DCMAKE_CUDA_COMPILER="$Nvcc" -DCMAKE_MAKE_PROGRAM="$Ninja" -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $Cmake --build $BuildDir --target @Targets
exit $LASTEXITCODE
