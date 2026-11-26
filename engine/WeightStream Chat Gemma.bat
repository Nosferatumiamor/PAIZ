@echo off

chcp 65001 >nul

setlocal EnableExtensions

title WeightStream Chat — Gemma 4 31B Q8



cd /d "%~dp0"



set "EXE=build-gpu\ws_chat_ui.exe"

set "MODEL=models\gemma-4-31B-it-Q8_0.gguf"

rem Q8 ~30 GiB : moins de couches GPU que Qwen Q4 (VRAM 12 Go)

set "NGL=28"



echo.

echo  ========================================

echo   WeightStream Chat — Gemma 4 31B Q8

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

    pause

    exit /b 1

)



echo.

echo Modele : %MODEL% (~30 GiB Q8_0)

echo GPU layers (-ngl) : %NGL%

echo Demarrage : navigateur immediat, chargement en arriere-plan.

echo Premier chargement : plusieurs minutes (SSD -^> RAM -^> GPU).

echo Laisse cette fenetre ouverte ^(logs + progression^).

echo.



call "%CD%\%EXE%" -m "%MODEL%" --ram-gib 32 -ngl %NGL%

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

