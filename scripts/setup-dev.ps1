$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw '未找到 Node.js，请先安装 Node.js 20+。'
}

$NodeMajor = [int]((& node -p "process.versions.node.split('.')[0]"))
if ($NodeMajor -lt 20) {
  throw "项目需要 Node.js 20+，当前主版本为 $NodeMajor。"
}

Set-Location $ProjectRoot
Set-Location (Join-Path $ProjectRoot 'frontend')
npm ci
$ApproveScriptsHelp = npm approve-scripts --help 2>&1
if ($LASTEXITCODE -eq 0) {
  npm approve-scripts esbuild
}
npm run build

Set-Location (Join-Path $ProjectRoot 'server')
npm ci
npm run build:server

Set-Location (Join-Path $ProjectRoot 'desktop')
npm ci

Write-Host '开发环境准备完成。'
Write-Host "启动：$ProjectRoot\启动工作台.bat"
