$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw '未找到 Node.js，请先安装 Node.js 22 LTS。'
}

$NodeMajor = [int]((& node -p "process.versions.node.split('.')[0]"))
if ($NodeMajor -ne 22) {
  throw "项目需要 Node.js 22.x，当前主版本为 $NodeMajor。"
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

# Electron 的 npm 包可能已安装，但下载/解压二进制的 postinstall 被环境策略跳过。
# 显式执行一次安装脚本，确保源码启动入口可以找到 electron.exe。
$ElectronInstallScript = Join-Path (Get-Location) 'node_modules\electron\install.js'
$ElectronBinary = Join-Path (Get-Location) 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $ElectronBinary)) {
  if (-not (Test-Path $ElectronInstallScript)) {
    throw 'Electron npm 包未正确安装，找不到 node_modules\electron\install.js。'
  }
  Write-Host 'Electron 二进制文件不存在，正在执行 Electron 安装脚本...'
  & node $ElectronInstallScript
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $ElectronBinary)) {
    throw 'Electron 二进制文件安装失败，请检查 Electron 下载缓存或网络设置。'
  }
}

Write-Host '开发环境准备完成。'
Write-Host "启动：$ProjectRoot\启动工作台.bat"
