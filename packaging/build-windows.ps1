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
if (Test-Path 'build') { Remove-Item -Recurse -Force 'build' }
if (Test-Path 'artifacts') { Remove-Item -Recurse -Force 'artifacts' }

python -m PyInstaller packaging/meimei-workbench.spec --noconfirm --clean

if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
  throw '找不到 Chocolatey，无法安装 Inno Setup。'
}
choco install innosetup --no-progress --yes
$Iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
if (-not (Test-Path $Iscc)) { $Iscc = Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe' }
if (-not (Test-Path $Iscc)) { throw '找不到 Inno Setup 编译器 ISCC.exe。' }

New-Item -ItemType Directory -Force artifacts | Out-Null
& $Iscc "/DMyAppVersion=$Version" 'packaging\installer.iss'
if ($LASTEXITCODE -ne 0) { throw "Inno Setup 构建失败：$LASTEXITCODE" }
Write-Host "Windows 安装包已生成：$ProjectRoot\artifacts"
