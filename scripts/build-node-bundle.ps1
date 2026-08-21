# 构建 Node 后端资源包 build\server-bundle\（供 Electron extraResources 使用，MIG-10）
# 用法：$env:APP_VERSION='1.2.3'; .\scripts\build-node-bundle.ps1
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$NodeMajor = [int]((& node -p "process.versions.node.split('.')[0]"))
if ($NodeMajor -ne 22) {
  throw "打包必须使用 Node.js 22.x，当前主版本为 $NodeMajor。"
}

$Version = if ($env:APP_VERSION) { $env:APP_VERSION -replace '^v', '' } else { '0.0.0-dev' }
$ElectronVersion = $env:ELECTRON_VERSION
if (-not $ElectronVersion -and (Test-Path 'desktop\package.json')) {
  $DesktopPkg = Get-Content 'desktop\package.json' -Raw | ConvertFrom-Json
  $ElectronVersion = $DesktopPkg.devDependencies.electron
}
$ElectronRebuildBin = Join-Path $ProjectRoot 'desktop\node_modules\.bin\electron-rebuild.cmd'
$ElectronBin = Join-Path $ProjectRoot 'desktop\node_modules\.bin\electron.cmd'
if ($ElectronVersion -and (-not (Test-Path $ElectronRebuildBin) -or -not (Test-Path $ElectronBin))) {
  Write-Host '==> 安装锁定的 Electron 打包工具'
  Set-Location (Join-Path $ProjectRoot 'desktop')
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "桌面依赖安装失败：$LASTEXITCODE" }
  Set-Location $ProjectRoot
}

Write-Host '==> 构建前端产物'
Set-Location frontend
if (-not (Test-Path 'node_modules\.bin\vite.cmd')) { npm ci }
npm run build
if ($LASTEXITCODE -ne 0) { throw "前端构建失败：$LASTEXITCODE" }
Set-Location $ProjectRoot

Write-Host '==> 编译 Node 后端'
Set-Location server
if (-not (Test-Path 'node_modules\.bin\tsc.cmd')) { npm ci }
npm run build:server
if ($LASTEXITCODE -ne 0) { throw "后端编译失败：$LASTEXITCODE" }
Set-Location $ProjectRoot

Write-Host "==> 组装 server-bundle（version=$Version）"
if (Test-Path 'build\server-bundle') { Remove-Item -Recurse -Force 'build\server-bundle' }
New-Item -ItemType Directory -Force 'build\server-bundle\dist' | Out-Null
New-Item -ItemType Directory -Force 'build\server-bundle\static' | Out-Null
Copy-Item 'server\package.json' 'build\server-bundle\package.json'
if (Test-Path 'server\package-lock.json') {
  Copy-Item 'server\package-lock.json' 'build\server-bundle\package-lock.json'
}
Set-Location 'build\server-bundle'
npm ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw "生产依赖安装失败：$LASTEXITCODE" }
Set-Location $ProjectRoot
Copy-Item -Recurse 'server\dist\*' 'build\server-bundle\dist\'
Copy-Item -Recurse 'backend\static\*' 'build\server-bundle\static\'
Set-Content -Path 'build\server-bundle\static\app-version.json' -Value ("{`"version`":`"$Version`"}" + "`n") -Encoding UTF8

if ($ElectronVersion) {
  Write-Host "==> 重建 better-sqlite3 为 Electron ${ElectronVersion} ABI"
  & $ElectronRebuildBin -f -w better-sqlite3 -v "$ElectronVersion" -t prod --module-dir (Join-Path $ProjectRoot 'build\server-bundle')
  if ($LASTEXITCODE -ne 0) { throw "Electron ABI 重建失败：$LASTEXITCODE" }
  Write-Host '==> 校验 Electron 原生模块'
  $PreviousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
  $env:ELECTRON_RUN_AS_NODE = '1'
  & $ElectronBin -e "const Database=require('./build/server-bundle/node_modules/better-sqlite3'); const db=new Database(':memory:'); db.close();"
  $ProbeExitCode = $LASTEXITCODE
  if ($null -eq $PreviousElectronRunAsNode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
  else { $env:ELECTRON_RUN_AS_NODE = $PreviousElectronRunAsNode }
  if ($ProbeExitCode -ne 0) { throw "Electron 原生模块校验失败：$ProbeExitCode" }
}

Write-Host "server-bundle 完成：$ProjectRoot\build\server-bundle"
