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

set "NODE_BIN=%WORKBENCH_NODE%"
if not defined NODE_BIN (
  for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_BIN set "NODE_BIN=%%N"
)
if not defined NODE_BIN (
  echo 未找到 Node.js，请安装 Node.js 22 LTS。
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%V in ('"%NODE_BIN%" --version') do set "NODE_MAJOR=%%V"
if /I not "%NODE_MAJOR%"=="v22" (
  echo 源码启动必须使用 Node.js 22.x，当前为：%NODE_MAJOR%
  echo 请先切换到项目 .nvmrc 指定的版本，或设置 WORKBENCH_NODE。
  pause
  exit /b 1
)
for %%I in ("%NODE_BIN%") do set "NODE_DIR=%%~dpI"
set "PATH=%NODE_DIR%;%PATH%"
set "WORKBENCH_NODE=%NODE_BIN%"

echo.
echo 正在启动...
echo.

set "WORKBENCH_HOST=%WORKBENCH_HOST%"
set "WORKBENCH_PORT=%WORKBENCH_PORT%"
"%NODE_DIR%npm.cmd" run start -- %*
pause
