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

cd /d "%~dp0backend"

rem --- 端口和主机配置 ---
if not defined WORKBENCH_PORT set "WORKBENCH_PORT=5000"
if not defined WORKBENCH_HOST set "WORKBENCH_HOST=0.0.0.0"

rem --- 查找 Python ---
set "PYTHON_BIN="

rem 1. 优先使用项目 .venv（setup 已校验版本，跳过二次检测）
if exist "%~dp0.venv\Scripts\python.exe" (
    set "PYTHON_BIN=%~dp0.venv\Scripts\python.exe"
    goto :skip_pyver
)

rem 2. 回退到 WORKBENCH_PYTHON 环境变量
if defined WORKBENCH_PYTHON (
    if exist "%WORKBENCH_PYTHON%" (
        set "PYTHON_BIN=%WORKBENCH_PYTHON%"
        goto :skip_pyver
    )
)

rem 3. 回退到系统 PATH 中的 python
for /f "delims=" %%i in ('where python 2^>nul') do (
    set "PYTHON_BIN=%%i"
    goto :check_pyver
)

:check_pyver
if not defined PYTHON_BIN (
    echo 错误：未找到 Python。
    echo 请安装 Python 3.11 或更高版本，或设置 WORKBENCH_PYTHON 指向对应解释器。
    pause
    exit /b 1
)

rem --- 校验系统 Python 版本 >= 3.11 ---
"%PYTHON_BIN%" -c "import sys; v=sys.version_info; ok=v[0]>3 or (v[0]==3 and v[1]>=11); print(v[0],v[1]); exit(0 if ok else 1)" > "%TEMP%\wb_pyver.txt" 2>nul
if errorlevel 1 (
    echo 错误：需要 Python 3.11 或更高版本。
    del "%TEMP%\wb_pyver.txt" 2>nul
    pause
    exit /b 1
)
set "PY_MAJOR="
set "PY_MINOR="
for /f "tokens=1,2" %%a in (%TEMP%\wb_pyver.txt) do (
    set /a PY_MAJOR=%%a
    set /a PY_MINOR=%%b
)
del "%TEMP%\wb_pyver.txt" 2>nul
if not defined PY_MAJOR (
    echo 错误：无法检测 Python 版本，请安装 Python 3.11 或更高版本。
    pause
    exit /b 1
)
echo   Python: %PYTHON_BIN% (%PY_MAJOR%.%PY_MINOR%)
goto :skip_pyver

:skip_pyver
echo   Python: %PYTHON_BIN%

rem --- 微信消息循环（默认开启） ---
if not defined MEIMEI_WECHAT_ENABLED set "MEIMEI_WECHAT_ENABLED=true"

rem --- 开发业务日期 ---
if not defined WORKBENCH_BUSINESS_DATE set "WORKBENCH_BUSINESS_DATE=2026-04-15"
if not "%WORKBENCH_BUSINESS_DATE%"=="" (
    echo   开发业务日期：%WORKBENCH_BUSINESS_DATE%
) else (
    echo   开发业务日期：使用系统日期
)

rem --- 微信状态 ---
if "%MEIMEI_WECHAT_ENABLED%"=="true" (
    echo   已开启微信消息循环自动恢复
) else (
    echo   微信消息循环自动恢复：已关闭
)

echo.
echo Starting...
echo.

set "WORKBENCH_HOST=%WORKBENCH_HOST%"
set "WORKBENCH_PORT=%WORKBENCH_PORT%"
"%PYTHON_BIN%" run.py --open-browser %*
pause
