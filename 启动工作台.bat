@echo off
title Meimei Workbench v2.3
echo ================================
echo    Mei Mei Wang Workbench v2.3
echo 凯凯小兵为你值守
echo ================================
echo Starting...
cd /d "%~dp0backend"
set "PYTHON=%~dp0.venv\Scripts\python.exe"
if not exist "%PYTHON%" set "PYTHON=python"
if not defined WORKBENCH_BUSINESS_DATE set "WORKBENCH_BUSINESS_DATE=2026-04-15"
echo Business date: %WORKBENCH_BUSINESS_DATE%
"%PYTHON%" run.py --open-browser %*
pause
