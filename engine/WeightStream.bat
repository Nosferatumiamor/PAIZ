@echo off
rem WeightStream launcher. "WeightStream.bat" = last model and profile; "WeightStream.bat -Ask" = choose again.
setlocal EnableExtensions
title WeightStream
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\run-npc-server.ps1" %*
if errorlevel 1 pause
