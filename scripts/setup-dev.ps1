$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PythonCommand = if ($env:WORKBENCH_PYTHON) { $env:WORKBENCH_PYTHON } else { 'python' }
$VenvDir = Join-Path $ProjectRoot '.venv'

if (-not (Get-Command $PythonCommand -ErrorAction SilentlyContinue)) {
  throw "未找到 $PythonCommand，请先安装 Python 3.11+。"
}

$PythonVersion = & $PythonCommand -c "import sys; print('.'.join(map(str, sys.version_info[:2])))"
$VersionParts = $PythonVersion.Split('.') | ForEach-Object { [int]$_ }
if (($VersionParts[0] -lt 3) -or (($VersionParts[0] -eq 3) -and ($VersionParts[1] -lt 11))) {
  throw "项目需要 Python 3.11+，当前版本为 $PythonVersion。"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw '未找到 Node.js，请先安装 Node.js 20+。'
}

$NodeMajor = [int]((& node -p "process.versions.node.split('.')[0]"))
if ($NodeMajor -lt 20) {
  throw "项目需要 Node.js 20+，当前主版本为 $NodeMajor。"
}

Set-Location $ProjectRoot
& $PythonCommand -m venv $VenvDir
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install -r 'backend\requirements.txt'

Set-Location (Join-Path $ProjectRoot 'frontend')
npm ci
$ApproveScriptsHelp = npm approve-scripts --help 2>&1
if ($LASTEXITCODE -eq 0) {
  npm approve-scripts esbuild
}

Write-Host '开发环境准备完成。'
Write-Host "启动：$ProjectRoot\启动工作台.bat"
