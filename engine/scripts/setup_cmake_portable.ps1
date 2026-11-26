# Télécharge CMake portable dans tools/cmake/ (non versionné).
# Usage: .\scripts\setup_cmake_portable.ps1
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $repoRoot "tools\cmake"
$cmakeExe = Join-Path $toolsDir "bin\cmake.exe"

if (Test-Path $cmakeExe) {
    Write-Host "CMake portable déjà présent: $cmakeExe" -ForegroundColor Green
    & $cmakeExe --version
    exit 0
}

$version = "3.30.5"
$zipName = "cmake-$version-windows-x86_64.zip"
$url = "https://github.com/Kitware/CMake/releases/download/v$version/$zipName"
$zipPath = Join-Path $env:TEMP $zipName

Write-Host "Téléchargement de CMake $version portable..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $zipPath

$extractDir = Join-Path $env:TEMP "cmake-$version-portable"
if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
Expand-Archive -Path $zipPath -DestinationPath $extractDir

$inner = Get-ChildItem $extractDir -Directory | Select-Object -First 1
New-Item -ItemType Directory -Path (Split-Path $toolsDir) -Force | Out-Null
if (Test-Path $toolsDir) { Remove-Item $toolsDir -Recurse -Force }
Move-Item $inner.FullName $toolsDir

Remove-Item $zipPath -Force
Write-Host "CMake portable installé dans: $toolsDir" -ForegroundColor Green
& $cmakeExe --version
