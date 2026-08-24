[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Version,

  [switch]$RunSmokeTest,

  [switch]$RequireSigning
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BuildScript = Join-Path $PSScriptRoot 'build-windows.ps1'
$SmokeScript = Join-Path $PSScriptRoot 'test-windows-installer.ps1'

function Get-ProjectVersion {
  $packagePath = Join-Path $ProjectRoot 'desktop\package.json'
  $package = Get-Content $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
  return [string]$package.version
}

if ([string]::IsNullOrWhiteSpace($Version)) {
  if (-not [string]::IsNullOrWhiteSpace($env:APP_VERSION)) {
    $Version = $env:APP_VERSION
  } else {
    $Version = Get-ProjectVersion
  }
}

$Version = $Version -replace '^v', ''
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') {
  throw "Invalid application version: $Version"
}

if ($RequireSigning) {
  $hasCertificate = -not [string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_BASE64)
  $hasPassword = -not [string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PASSWORD)
  if (-not ($hasCertificate -and $hasPassword)) {
    throw 'RequireSigning needs WINDOWS_CERTIFICATE_BASE64 and WINDOWS_CERTIFICATE_PASSWORD.'
  }
}

$oldAppVersion = $env:APP_VERSION
$oldRequireSigning = $env:REQUIRE_WINDOWS_SIGNING

try {
  $env:APP_VERSION = $Version
  if ($RequireSigning) {
    $env:REQUIRE_WINDOWS_SIGNING = '1'
  }

  Write-Host "Building Zhihui-Banji Windows installer: $Version"
  & $BuildScript
  if ($LASTEXITCODE -ne 0) {
    throw "Windows installer build failed: $LASTEXITCODE"
  }

  $installer = Join-Path $ProjectRoot 'artifacts\Zhihui-Banji-Setup-Windows-x64.exe'
  if (-not (Test-Path $installer)) {
    throw "Installer was not generated: $installer"
  }

  if ($RunSmokeTest) {
    & $SmokeScript -InstallerPath $installer
    if ($LASTEXITCODE -ne 0) {
      throw "Windows installer smoke test failed: $LASTEXITCODE"
    }
  }

  Write-Host "Installer ready: $installer"
} finally {
  if ($null -eq $oldAppVersion) {
    Remove-Item Env:APP_VERSION -ErrorAction SilentlyContinue
  } else {
    $env:APP_VERSION = $oldAppVersion
  }

  if ($null -eq $oldRequireSigning) {
    Remove-Item Env:REQUIRE_WINDOWS_SIGNING -ErrorAction SilentlyContinue
  } else {
    $env:REQUIRE_WINDOWS_SIGNING = $oldRequireSigning
  }
}
