@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
set "EXE=PAIZ-WeightStream.exe"

rem 1) Build local (npm run tauri:build:exe)
if exist "%ROOT%src-tauri\target\release\%EXE%" (
  start "" "%ROOT%src-tauri\target\release\%EXE%"
  exit /b 0
)

rem 2) Installation NSIS par utilisateur
if exist "%LOCALAPPDATA%\PAIZ-WeightStream\%EXE%" (
  start "" "%LOCALAPPDATA%\PAIZ-WeightStream\%EXE%"
  exit /b 0
)
if exist "%LOCALAPPDATA%\Programs\PAIZ-WeightStream\%EXE%" (
  start "" "%LOCALAPPDATA%\Programs\PAIZ-WeightStream\%EXE%"
  exit /b 0
)

rem 3) Pas de build : on le dit au lieu d'ouvrir un navigateur
echo.
echo   PAIZ-WeightStream n'est pas encore compile.
echo   Lance : npm run tauri:build:exe   (dans %ROOT%)
echo   Pour la version web de secours : node src\cli.js serve
echo.
pause
