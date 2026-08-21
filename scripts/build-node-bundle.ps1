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
Write-Host '==> 构建前端产物'
Set-Location frontend
npm ci
npm run build
if ($LASTEXITCODE -ne 0) { throw "前端构建失败：$LASTEXITCODE" }
Set-Location $ProjectRoot

Write-Host '==> 编译 Node 后端'
Set-Location server
npm ci --ignore-scripts
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
npm ci --omit=dev --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw "生产依赖安装失败：$LASTEXITCODE" }
Set-Location $ProjectRoot
Copy-Item -Recurse 'server\dist\*' 'build\server-bundle\dist\'
Copy-Item -Recurse 'backend\static\*' 'build\server-bundle\static\'
$VersionJson = @{ version = $Version } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText(
  (Join-Path $ProjectRoot 'build\server-bundle\static\app-version.json'),
  $VersionJson + "`n",
  [System.Text.UTF8Encoding]::new($false)
)

Write-Host "server-bundle 完成：$ProjectRoot\build\server-bundle"
