@echo off
rem Same as WeightStream.bat but always asks which model and resource profile to use.
setlocal EnableExtensions
title WeightStream
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\run-npc-server.ps1" -Ask %*
if errorlevel 1 pause
