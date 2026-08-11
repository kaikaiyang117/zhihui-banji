@echo off
chcp 65001 >nul
title Meimei Workbench v2.3
echo ================================
echo    Mei Mei Wang Workbench v2.3
echo 凯凯小兵为你值守
echo ================================
echo.
echo   默认开启局域网访问
echo   端口冲突时会自动切换端口
echo.
echo   按 Ctrl+C 停止
echo ================================
echo.

cd /d "%~dp0desktop"
echo   由 Electron 启动 Node.js 后端
if not defined MEIMEI_WECHAT_ENABLED set "MEIMEI_WECHAT_ENABLED=true"
if not defined WORKBENCH_BUSINESS_DATE set "WORKBENCH_BUSINESS_DATE=2026-04-15"

echo.
echo Starting...
echo.

set "WORKBENCH_HOST=%WORKBENCH_HOST%"
set "WORKBENCH_PORT=%WORKBENCH_PORT%"
npm run dev -- %*
pause
