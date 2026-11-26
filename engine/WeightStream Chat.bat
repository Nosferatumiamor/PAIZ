@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WeightStream Chat

cd /d "%~dp0"

set "EXE=build-gpu\ws_chat_ui.exe"
set "MODEL=models\Qwen2.5-32B-Instruct-Q4_K_L.gguf"

echo.
echo  ========================================
echo   WeightStream Chat
echo  ========================================
echo.

echo [build] Compilation ws_chat_ui...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\build-gpu.ps1" ws_chat_ui
if errorlevel 1 (
    echo.
    echo Echec de compilation.
    pause
    exit /b 1
)

if not exist "%MODEL%" (
    echo Modele introuvable :
    echo   %CD%\%MODEL%
    echo.
    echo Place un fichier .gguf dans le dossier models\ ou edite ce .bat.
    pause
    exit /b 1
)

echo.
echo Demarrage : navigateur immediat, modele en arriere-plan.
echo Laisse cette fenetre ouverte ^(logs + progression^).
echo.

call "%CD%\%EXE%" -m "%MODEL%" --ram-gib 32 -ngl 35
set "ERR=%ERRORLEVEL%"

echo.
if not "%ERR%"=="0" (
    echo Arret avec erreur ^(code %ERR%^).
) else (
    echo Session terminee.
)
pause
if "%ERR%"=="0" (exit /b 0)
exit /b 1
