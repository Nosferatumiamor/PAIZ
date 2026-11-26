# Build helper — finds CMake even when it's not in PATH.
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Find-CMake {
    if (Get-Command cmake -ErrorAction SilentlyContinue) {
        return (Get-Command cmake).Source
    }

    $candidates = @(
        "${env:ProgramFiles}\CMake\bin\cmake.exe",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2019\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2019\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe",
        (Join-Path $repoRoot "tools\cmake\bin\cmake.exe")
    )

    foreach ($path in $candidates) {
        if (Test-Path $path) { return $path }
    }

    throw "CMake introuvable. Installe-le (winget install Kitware.CMake) ou place une copie portable dans tools\cmake\"
}

$cmake = Find-CMake
Write-Host "Using CMake: $cmake" -ForegroundColor Cyan

$buildDir = Join-Path $repoRoot "build"
$buildType = if ($args -contains "-Debug") { "Debug" } else { "Release" }

if (-not (Test-Path $buildDir)) {
    & $cmake -S $repoRoot -B $buildDir -G "Visual Studio 16 2019" -A x64
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $cmake --build $buildDir --config $buildType
exit $LASTEXITCODE
