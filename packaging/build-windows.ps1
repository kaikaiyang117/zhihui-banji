# Windows Electron 构建：前端 build → Node 后端编译 → server-bundle → Electron Builder → NSIS 安装包
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OriginalLocation = (Get-Location).Path
$DesktopPackagePath = Join-Path $ProjectRoot 'desktop\package.json'
$OriginalDesktopPackageBytes = [IO.File]::ReadAllBytes($DesktopPackagePath)
$OriginalAppVersion = $env:APP_VERSION
$OriginalCscLink = $env:CSC_LINK
$OriginalCscKeyPassword = $env:CSC_KEY_PASSWORD
$OriginalWinCscLink = $env:WIN_CSC_LINK
$OriginalCscIdentityAutoDiscovery = $env:CSC_IDENTITY_AUTO_DISCOVERY
$CertPath = $null

try {
  Set-Location $ProjectRoot
  $Version = if ($env:APP_VERSION) { $env:APP_VERSION -replace '^v', '' } else { '0.0.0-dev' }
  $RequireWindowsSigning = $env:REQUIRE_WINDOWS_SIGNING -eq '1'

  if (Test-Path 'dist\MeimeiWorkbench') { Remove-Item -Recurse -Force 'dist\MeimeiWorkbench' }
  if (Test-Path 'build\server-bundle') { Remove-Item -Recurse -Force 'build\server-bundle' }
  if (Test-Path 'desktop\dist') { Remove-Item -Recurse -Force 'desktop\dist' }
  if (Test-Path 'desktop\release') { Remove-Item -Recurse -Force 'desktop\release' }
  if (Test-Path 'artifacts') { Remove-Item -Recurse -Force 'artifacts' }
  New-Item -ItemType Directory -Force artifacts | Out-Null

  Write-Host "==> 构建 Node 后端资源包（Windows x64，version=$Version）"
  $env:APP_VERSION = $Version
  & "$ProjectRoot\scripts\build-node-bundle.ps1"
  if ($LASTEXITCODE -ne 0) { throw "server-bundle 构建失败：$LASTEXITCODE" }
  if (-not (Test-Path 'build\server-bundle\dist\entry.js')) {
    throw '未生成 server-bundle/dist/entry.js'
  }
  if (-not (Test-Path 'build\server-bundle\static\index.html')) {
    throw '未生成 server-bundle/static/index.html'
  }
  if (-not (Test-Path 'build\server-bundle\node_modules\better-sqlite3\prebuilds\win32-x64.node')) {
    throw 'server-bundle 缺少 better-sqlite3 Windows x64 N-API 二进制'
  }
  $VersionFile = Join-Path $ProjectRoot 'build\server-bundle\static\app-version.json'
  $VersionContent = [IO.File]::ReadAllText($VersionFile)
  if ($VersionContent.Length -gt 0 -and [int][char]$VersionContent[0] -eq 0xFEFF) {
    throw 'app-version.json 不能包含 UTF-8 BOM'
  }
  $VersionData = $VersionContent | ConvertFrom-Json
  if ($VersionData.version -ne $Version) {
    throw "app-version.json 版本不一致：期望 $Version，实际 $($VersionData.version)"
  }

  Write-Host '==> 安装桌面打包依赖'
  Set-Location (Join-Path $ProjectRoot 'desktop')
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "桌面依赖安装失败：$LASTEXITCODE" }

  Write-Host "==> 同步桌面应用版本（$Version）"
  $DesktopPkg = Get-Content 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
  $DesktopPkg.version = $Version
  $Json = $DesktopPkg | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText((Join-Path (Get-Location) 'package.json'), $Json, [System.Text.UTF8Encoding]::new($false))

  $HasCertificate = -not [string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_BASE64)
  $HasCertificatePassword = -not [string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PASSWORD)
  if ($HasCertificate -xor $HasCertificatePassword) {
    throw 'Windows 签名证书和密码必须同时配置。'
  }
  if ($HasCertificate) {
    $TempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } elseif ($env:TEMP) { $env:TEMP } else { [IO.Path]::GetTempPath() }
    New-Item -ItemType Directory -Force $TempRoot | Out-Null
    $CertPath = Join-Path $TempRoot 'meimei-workbench-signing.pfx'
    [IO.File]::WriteAllBytes($CertPath, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE_BASE64))
    $env:CSC_LINK = $CertPath
    $env:CSC_KEY_PASSWORD = $env:WINDOWS_CERTIFICATE_PASSWORD
    Remove-Item Env:WIN_CSC_LINK -ErrorAction SilentlyContinue
    Write-Host 'Windows 代码签名已启用。'
  } else {
    Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue
    Remove-Item Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:WIN_CSC_LINK -ErrorAction SilentlyContinue
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    if ($RequireWindowsSigning) {
      throw '正式 Windows 发布必须配置 WINDOWS_CERTIFICATE_BASE64 和 WINDOWS_CERTIFICATE_PASSWORD。'
    }
    Write-Warning '未配置 Windows 签名证书，将生成未签名安装包。'
  }

  Write-Host '==> Electron Builder 打包（Windows x64）'
  & '.\node_modules\.bin\electron-builder.cmd' --config electron-builder.yml --win --x64 --publish never
  if ($LASTEXITCODE -ne 0) { throw "Electron Builder 构建失败：$LASTEXITCODE" }
  Set-Location $ProjectRoot

  $Installer = Get-ChildItem 'desktop\dist\Zhihui-Banji-Setup-Windows-x64.exe' -ErrorAction Stop
  if ($HasCertificate) {
    $Signature = Get-AuthenticodeSignature $Installer.FullName
    if ($Signature.Status -ne 'Valid') {
      throw "Windows 安装包签名校验失败：$($Signature.Status) $($Signature.StatusMessage)"
    }
    Write-Host "Windows 安装包签名校验通过：$($Signature.SignerCertificate.Subject)"
  }
  Copy-Item $Installer.FullName "artifacts\$($Installer.Name)"
  Write-Host "Windows 安装包已生成：$ProjectRoot\artifacts\$($Installer.Name)"
} finally {
  if ($OriginalDesktopPackageBytes) {
    [IO.File]::WriteAllBytes($DesktopPackagePath, $OriginalDesktopPackageBytes)
  }
  if ($CertPath -and (Test-Path $CertPath)) {
    Remove-Item -LiteralPath $CertPath -Force -ErrorAction SilentlyContinue
  }
  if ($null -eq $OriginalAppVersion) { Remove-Item Env:APP_VERSION -ErrorAction SilentlyContinue } else { $env:APP_VERSION = $OriginalAppVersion }
  if ($null -eq $OriginalCscLink) { Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue } else { $env:CSC_LINK = $OriginalCscLink }
  if ($null -eq $OriginalCscKeyPassword) { Remove-Item Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue } else { $env:CSC_KEY_PASSWORD = $OriginalCscKeyPassword }
  if ($null -eq $OriginalWinCscLink) { Remove-Item Env:WIN_CSC_LINK -ErrorAction SilentlyContinue } else { $env:WIN_CSC_LINK = $OriginalWinCscLink }
  if ($null -eq $OriginalCscIdentityAutoDiscovery) { Remove-Item Env:CSC_IDENTITY_AUTO_DISCOVERY -ErrorAction SilentlyContinue } else { $env:CSC_IDENTITY_AUTO_DISCOVERY = $OriginalCscIdentityAutoDiscovery }
  Set-Location $OriginalLocation
}
