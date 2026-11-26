# GPU build: Ninja + nvcc (bypasses missing CUDA VS toolset integration)
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$BuildDir = Join-Path $Root "build-gpu"

$VsDev = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
$Cmake = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
$Ninja = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
$Nvcc = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.3\bin\nvcc.exe"
$CudaRoot = "C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v12.3"

if (-not (Test-Path $Nvcc)) { throw "nvcc not found at $Nvcc" }
if (-not (Test-Path $VsDev)) { throw "vcvars64.bat not found" }

$Target = if ($args.Count -gt 0) { $args[0] } else { "ws_infer" }

Write-Host "=== WeightStream GPU build ($Target) ===" -ForegroundColor Cyan

$configure = @(
    "`"$Cmake`" -G Ninja",
    "-S `"$Root`"",
    "-B `"$BuildDir`"",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DWEIGHTSTREAM_CUDA=ON",
    "-DWEIGHTSTREAM_LLAMA=ON",
    "-DGGML_CUDA=ON",
    "-DCMAKE_CUDA_COMPILER=`"$Nvcc`"",
    "-DCMAKE_CUDA_ARCHITECTURES=86",
    "-DCMAKE_MAKE_PROGRAM=`"$Ninja`"",
    "-DCMAKE_PREFIX_PATH=`"$CudaRoot`""
) -join " "

$build = "`"$Cmake`" --build `"$BuildDir`" --target $Target"

cmd /c "`"$VsDev`" && $configure && $build"

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`nDone: $BuildDir\$Target.exe" -ForegroundColor Green
