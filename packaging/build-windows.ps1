# Windows Electron 构建：Vue build → PyInstaller sidecar → Electron Builder → NSIS 安装包
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$Version = if ($env:APP_VERSION) { $env:APP_VERSION -replace '^v', '' } else { '0.0.0-dev' }

if (-not (Test-Path 'backend/static/index.html')) {
  throw '未找到前端构建产物，请先执行：cd frontend && npm run build'
}

python packaging/create-logo-ico.py --out packaging/logo.ico
if ($LASTEXITCODE -ne 0) { throw "Logo icon generation failed: $LASTEXITCODE" }

if (Test-Path 'dist\MeimeiWorkbench') { Remove-Item -Recurse -Force 'dist\MeimeiWorkbench' }
if (Test-Path 'build\backend-sidecar') { Remove-Item -Recurse -Force 'build\backend-sidecar' }
if (Test-Path 'desktop\dist') { Remove-Item -Recurse -Force 'desktop\dist' }
if (Test-Path 'desktop\release') { Remove-Item -Recurse -Force 'desktop\release' }
if (Test-Path 'artifacts') { Remove-Item -Recurse -Force 'artifacts' }
New-Item -ItemType Directory -Force artifacts | Out-Null

Write-Host '==> 构建 Python sidecar'
$env:MEIMEI_SIDECAR = '1'
python -m PyInstaller packaging/meimei-workbench.spec --noconfirm --clean --distpath dist --workpath build\pyinstaller
if ($LASTEXITCODE -ne 0) { throw "PyInstaller 构建失败：$LASTEXITCODE" }
if (-not (Test-Path 'build\backend-sidecar\MeimeiWorkbench')) {
  throw '未生成后端 sidecar 目录'
}

Write-Host '==> 安装桌面依赖'
Set-Location desktop
if (-not (Test-Path 'node_modules')) { npm ci }
if ($LASTEXITCODE -ne 0) { throw "桌面依赖安装失败：$LASTEXITCODE" }

Write-Host '==> Electron Builder 打包（Windows x64）'
if ($env:WINDOWS_CERTIFICATE_BASE64 -and $env:WINDOWS_CERTIFICATE_PASSWORD) {
  $CertPath = Join-Path $env:RUNNER_TEMP 'meimei-workbench-signing.pfx'
  [IO.File]::WriteAllBytes($CertPath, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE_BASE64))
  $env:CSC_LINK = $CertPath
  $env:CSC_KEY_PASSWORD = $env:WINDOWS_CERTIFICATE_PASSWORD
  Write-Host 'Windows 代码签名已启用。'
} else {
  Write-Warning '未配置 Windows 签名证书，将生成未签名安装包。'
}
npx electron-builder --config electron-builder.yml --win --x64 --publish never
if ($LASTEXITCODE -ne 0) { throw "Electron Builder 构建失败：$LASTEXITCODE" }
Set-Location $ProjectRoot

$Installer = Get-ChildItem 'desktop\dist\MeimeiWorkbench-Setup-Windows-x64.exe' -ErrorAction Stop
Copy-Item $Installer.FullName "artifacts\$($Installer.Name)"
Write-Host "Windows 安装包已生成：$ProjectRoot\artifacts\$($Installer.Name)"
