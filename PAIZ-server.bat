@echo off
chcp 65001 >nul
rem PAIZ sans interface : une API compatible OpenAI sur http://127.0.0.1:7788/v1 pour OpenCode, Continue, SillyTavern...
rem   PAIZ-server.bat                       le dernier modele utilise se recharge (si "Charger au demarrage" est coche)
rem   PAIZ-server.bat --model gemma         charge ce modele (nom ou numero, voir : node app\src\cli.js list --category llm)
rem   PAIZ-server.bat --model gemma --mode leger
rem Ctrl+C pour arreter. Ne pas lancer en meme temps que l'application PAIZ (meme port).
where node >nul 2>nul || (echo   Node.js 24 ou plus est necessaire : https://nodejs.org & pause & exit /b 1)
node "%~dp0app\src\cli.js" serve --headless %*
