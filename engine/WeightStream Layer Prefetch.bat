@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WeightStream Layer Prefetch — 7B gpu_first

cd /d "%~dp0"

set "VENV=python\.venv\Scripts\python.exe"
set "MODEL=models\qwen2.5-7b-instruct"
set "REPO=Qwen/Qwen2.5-7B-Instruct"
set "ERR=0"

echo.
echo  ========================================
echo   WeightStream - Layer Prefetch PoC
echo  ========================================
echo.
echo  Profil gpu_first : GPU pilote, VRAM max ^(3060 12 Go + 32 Go^).
echo  Modele : Qwen2.5-7B-Instruct ^(~15 Go 1ere fois^)
echo  RAM preload une fois, puis disque ignore — PCIe/RAM alimente le GPU.
echo.

if not exist "%VENV%" goto do_setup
goto after_setup

:do_setup
echo [setup] Premiere installation ^(PyTorch + layer-prefetch^)
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-layer-prefetch.ps1"
if errorlevel 1 (
    echo Echec setup.
    set "ERR=1"
    goto done
)

:after_setup
if not "%ERR%"=="0" goto done
if not exist "%VENV%" (
    echo Python venv introuvable : %CD%\%VENV%
    set "ERR=1"
    goto done
)

echo [model] Verification des shards safetensors
call "%VENV%" python\layer_prefetch\stream_chat.py --model-dir "%MODEL%" --repo "%REPO%" --download-only --download
if errorlevel 1 (
    echo Echec telechargement ou modele incomplet.
    set "ERR=1"
    goto done
)

if not "%ERR%"=="0" goto done

echo.
echo Demarrage chat interactif ^(7B gpu_first^)
echo.

call "%VENV%" python\layer_prefetch\stream_chat.py --model-dir "%MODEL%" --repo "%REPO%" --chat --progress --profile gpu_first --temperature 0.7
set "ERR=%ERRORLEVEL%"

:done
echo.
if not "%ERR%"=="0" echo Arret avec erreur ^(code %ERR%^).
pause
exit /b %ERR%
