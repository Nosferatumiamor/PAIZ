# Debug diagnostic build: SAFE_MEMCPY bounds checks + no CUDA/llama.
# Optional: pass -UseAsan to also enable /fsanitize=address (needs VS ASan runtime DLL).
param([switch]$UseAsan)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$BuildDir = Join-Path $Root "build-asan"

$VsDev = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
$Cmake = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
$Ninja = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"

if (-not (Test-Path $VsDev)) { throw "vcvars64.bat not found" }

$Target = if ($args.Count -gt 0) { $args[0] } else { "ws_read_equiv" }

Write-Host "=== WeightStream Debug diagnostic build ($Target) ===" -ForegroundColor Cyan

$asanFlag = if ($UseAsan) { "-DWEIGHTSTREAM_ASAN=ON" } else { "-DWEIGHTSTREAM_ASAN=OFF" }

$configure = @(
    "`"$Cmake`" -G Ninja",
    "-S `"$Root`"",
    "-B `"$BuildDir`"",
    "-DCMAKE_BUILD_TYPE=Debug",
    "-DWEIGHTSTREAM_SAFE_MEMCPY=ON",
    $asanFlag,
    "-DWEIGHTSTREAM_CUDA=OFF",
    "-DWEIGHTSTREAM_LLAMA=OFF",
    "-DCMAKE_MAKE_PROGRAM=`"$Ninja`""
) -join " "

$build = "`"$Cmake`" --build `"$BuildDir`" --target $Target"

cmd /c "`"$VsDev`" && $configure && $build"

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`nDone: $BuildDir\$Target.exe" -ForegroundColor Green
if (-not $UseAsan) {
    Write-Host "SAFE_MEMCPY=ON - aborts on first out-of-bounds memcpy" -ForegroundColor Yellow
    Write-Host "For ASan: install VS C++ AddressSanitizer component, then build with -UseAsan" -ForegroundColor DarkYellow
}
