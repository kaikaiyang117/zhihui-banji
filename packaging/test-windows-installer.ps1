param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
$ResolvedInstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
$SmokeRoot = Join-Path ([IO.Path]::GetTempPath()) ('meimei-workbench-installer-smoke-' + [guid]::NewGuid().ToString('N'))
$InstallDirectory = Join-Path $SmokeRoot 'installed'
$OldPackagedExe = $env:WORKBENCH_PACKAGED_EXE

try {
  New-Item -ItemType Directory -Force $InstallDirectory | Out-Null
  Write-Host "==> Install Windows installer: $ResolvedInstallerPath"
  $InstallResult = Start-Process -FilePath $ResolvedInstallerPath -ArgumentList @('/S', "/D=$InstallDirectory") -Wait -PassThru
  if ($InstallResult.ExitCode -ne 0) {
    throw "NSIS install failed with exit code $($InstallResult.ExitCode)"
  }

  $InstalledExecutable = Get-ChildItem -LiteralPath $InstallDirectory -Filter '*.exe' -File -Recurse |
    Where-Object { $_.Name -notlike 'Uninstall*.exe' } |
    Select-Object -First 1
  if (-not $InstalledExecutable) {
    throw "Installation completed but the application executable was not found: $InstallDirectory"
  }

  Write-Host "==> Run installed application smoke test: $($InstalledExecutable.FullName)"
  $env:WORKBENCH_PACKAGED_EXE = $InstalledExecutable.FullName
  node desktop/tests/smoke.mjs
  if ($LASTEXITCODE -ne 0) {
    throw "Installed application smoke test failed with exit code $LASTEXITCODE"
  }

  $Uninstaller = Get-ChildItem -LiteralPath $InstallDirectory -Filter 'Uninstall*.exe' -File -Recurse | Select-Object -First 1
  if (-not $Uninstaller) {
    throw "Uninstaller was not found in installation directory: $InstallDirectory"
  }
  Write-Host "==> Run uninstall test: $($Uninstaller.FullName)"
  $UninstallResult = Start-Process -FilePath $Uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
  if ($UninstallResult.ExitCode -ne 0) {
    throw "NSIS uninstall failed with exit code $($UninstallResult.ExitCode)"
  }

  Write-Host 'Windows install, start, exit, and uninstall verification passed.'
} finally {
  if ($null -eq $OldPackagedExe) { Remove-Item Env:WORKBENCH_PACKAGED_EXE -ErrorAction SilentlyContinue } else { $env:WORKBENCH_PACKAGED_EXE = $OldPackagedExe }
  if (Test-Path -LiteralPath $SmokeRoot) {
    Remove-Item -LiteralPath $SmokeRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
