@echo off
title Meimei Workbench v2.2
echo ================================
echo    Mei Mei Wang Workbench v2.2
echo 凯凯小兵为你值守
echo ================================
echo Starting...
cd /d "%~dp0backend"
start "" http://localhost:5000
python run.py %*
pause
