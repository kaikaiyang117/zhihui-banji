@echo off
setlocal EnableExtensions
chcp 65001 >nul
title 智汇·班记 v2.3
echo ================================
echo    智汇·班记 v2.3
echo 智汇·班记 · 班小助为你值守
echo ================================
echo.
echo   默认开启局域网访问
echo   端口冲突时会自动切换端口
echo.
echo   按 Ctrl+C 停止
echo ================================
echo.

set "PROJECT_ROOT=%~dp0"
cd /d "%PROJECT_ROOT%"
echo   由 Electron 启动 Node.js 后端
if not defined MEIMEI_WECHAT_ENABLED set "MEIMEI_WECHAT_ENABLED=true"
rem 源码调试始终使用 server/dist，不使用打包 bundle。
set "WORKBENCH_USE_BUNDLE="

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
if /I "%WORKBENCH_SKIP_BUILD%"=="1" goto start_desktop

echo 正在构建前端页面...
pushd "%PROJECT_ROOT%frontend"
call "%NODE_DIR%npm.cmd" run build
set "BUILD_EXIT=%ERRORLEVEL%"
popd
if not "%BUILD_EXIT%"=="0" goto build_failed

echo 正在编译 Node.js 后端...
pushd "%PROJECT_ROOT%server"
call "%NODE_DIR%npm.cmd" run build:server
set "BUILD_EXIT=%ERRORLEVEL%"
popd
if not "%BUILD_EXIT%"=="0" goto build_failed

:start_desktop
cd /d "%PROJECT_ROOT%desktop"
if not exist "node_modules\electron\dist\electron.exe" (
  if exist "node_modules\electron\install.js" (
    echo Electron runtime is missing. Repairing it now...
    call "%NODE_BIN%" "node_modules\electron\install.js"
  )
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron runtime is still missing.
  echo Run this command once:
  echo powershell -ExecutionPolicy Bypass -File "%PROJECT_ROOT%scripts\setup-dev.ps1"
  pause
  exit /b 1
)

echo 正在启动前端 Vite 热更新服务...
rem Vite 独立运行在新窗口中，Electron 会通过 --dev-frontend 加载 http://127.0.0.1:5173。
set "VITE_READY="
set "POWERSHELL_BIN=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%POWERSHELL_BIN%" -NoProfile -Command "$client = New-Object System.Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1',5173); exit 0 } catch { exit 1 } finally { $client.Dispose() }" >nul 2>&1
if not errorlevel 1 (
  set "VITE_READY=1"
  goto vite_ready
)

start "Meimei Workbench - Vite HMR" /D "%PROJECT_ROOT%frontend" "%ComSpec%" /d /c ""%NODE_DIR%npm.cmd" run dev"
for /L %%I in (1,1,30) do (
  "%POWERSHELL_BIN%" -NoProfile -Command "$client = New-Object System.Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1',5173); exit 0 } catch { exit 1 } finally { $client.Dispose() }" >nul 2>&1
  if not errorlevel 1 (
    set "VITE_READY=1"
    goto vite_ready
  )
  timeout /t 1 /nobreak >nul
)

:vite_ready
if defined VITE_READY (
  echo Vite 已就绪，前端修改将自动热更新。
) else (
  echo 警告：Vite 未在 30 秒内就绪，Electron 可能回退到静态页面。
  echo 请检查新打开的 Vite 窗口中的错误信息。
)

echo 正在启动源码调试桌面...
echo.
set "WORKBENCH_HOST=%WORKBENCH_HOST%"
set "WORKBENCH_PORT=%WORKBENCH_PORT%"
call "%NODE_DIR%npm.cmd" run dev -- %*
set "APP_EXIT=%ERRORLEVEL%"
if not "%APP_EXIT%"=="0" echo 桌面程序已退出，退出码：%APP_EXIT%
echo Vite 热更新窗口仍在运行，结束调试后请关闭该窗口。
pause
exit /b %APP_EXIT%

:build_failed
echo.
echo 构建失败，未启动桌面程序。
pause
exit /b 1
