@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WeightStream Layer Smoke — keep-hot + GPU reel

cd /d "%~dp0"

set "EXE=build-gpu\ws_layer_smoke.exe"
set "MODEL=models\Qwen2.5-32B-Instruct-Q4_K_L.gguf"

echo.
echo  Layer smoke — keep-hot entre tokens + CUDA reel
echo.

if not exist "%MODEL%" (
    echo Modele introuvable: %CD%\%MODEL%
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\build-gpu.ps1" ws_layer_smoke
if errorlevel 1 exit /b 1

echo.
"%EXE%" "%MODEL%" --preset chat --rounds 2 --verbose-layers
exit /b %ERRORLEVEL%
