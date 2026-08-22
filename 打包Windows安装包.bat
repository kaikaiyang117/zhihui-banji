@echo off
setlocal

rem Double-clickable Windows installer build entry.
cd /d "%~dp0"

set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL_EXE%" (
  echo Windows PowerShell 5.1 was not found.
  echo Please run this script on Windows with PowerShell installed.
  pause
  exit /b 1
)

echo.
echo Building Zhihui-Banji Windows installer...
echo Project: %CD%
echo.

"%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0packaging\build-installer.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo Build completed successfully.
  echo Installer: %~dp0artifacts\Zhihui-Banji-Setup-Windows-x64.exe
) else (
  echo Build failed with exit code %EXIT_CODE%.
)
echo.
pause
exit /b %EXIT_CODE%
