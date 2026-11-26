@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WeightStream Tier — GGUF quant

cd /d "%~dp0"

set "EXE=build-gpu\ws_chat_ui.exe"
set "MODEL=models\Qwen2.5-32B-Instruct-Q4_K_L.gguf"
set "ERR=0"

echo.
echo  ========================================
echo   WeightStream Tier — dernier essai
echo  ========================================
echo.
echo  Logique: modele quant trop gros pour tout garder chaud.
echo  Hot pages VRAM d'abord, cache RAM limite, prefetch fond.
echo  Inference = llama.cpp ^(vitesse normale une fois pret^).
echo.
echo  Place un GGUF quant ~15-20 Go dans models\ ou edite ce .bat.
echo.

if not exist "%MODEL%" (
    echo Modele introuvable: %CD%\%MODEL%
    echo.
    echo Exemple telechargement:
    echo   huggingface-cli download Qwen/Qwen2.5-32B-Instruct-GGUF qwen2.5-32b-instruct-q4_k_l.gguf --local-dir models
    echo   renommer en Qwen2.5-32B-Instruct-Q4_K_L.gguf
    pause
    exit /b 1
)

echo [build] ws_chat_ui...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\build-gpu.ps1" ws_chat_ui
if errorlevel 1 (
    echo Echec compilation.
    pause
    exit /b 1
)

echo.
echo Demarrage chat tier ^(--tier -ngl 35^)...
echo.

call "%EXE%" -m "%MODEL%" --tier -ngl 35 --ram-gib 32
set "ERR=%ERRORLEVEL%"

echo.
if not "%ERR%"=="0" echo Arret code %ERR%.
pause
exit /b %ERR%
