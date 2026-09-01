[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$AppExePath,

  [int]$ProcessId = 0,

  [string]$LogPath,

  [int]$WaitForExitSeconds = 30,

  [int]$InstallTimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'

function Write-UpdateLog {
  param([string]$Message)
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -LiteralPath $script:ResolvedLogPath -Value "$timestamp $Message"
}

function Stop-WithCode {
  param([int]$Code, [string]$Message)
  try { Write-UpdateLog $Message } catch {}
  exit $Code
}

try {
  $resolvedInstallerPath = [IO.Path]::GetFullPath($InstallerPath)
  $resolvedAppExePath = [IO.Path]::GetFullPath($AppExePath)
  if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    $LogPath = Join-Path $localAppData 'MeimeiWorkbench\updates\windows-updater.log'
  }
  $script:ResolvedLogPath = [IO.Path]::GetFullPath($LogPath)
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($script:ResolvedLogPath)) | Out-Null
  Write-UpdateLog 'Windows updater started.'

  if ([IO.Path]::GetExtension($resolvedInstallerPath) -ine '.exe') {
    Stop-WithCode 10 'Installer is not an executable.'
  }
  if (-not (Test-Path -LiteralPath $resolvedInstallerPath -PathType Leaf)) {
    Stop-WithCode 11 'Installer was not found.'
  }
  if (-not (Test-Path -LiteralPath $resolvedAppExePath -PathType Leaf)) {
    Stop-WithCode 12 'Application executable was not found.'
  }

  if ($ProcessId -gt 0) {
    $exitDeadline = (Get-Date).AddSeconds($WaitForExitSeconds)
    while ((Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $exitDeadline) {
      Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
      Stop-WithCode 13 'The previous application process did not exit before the timeout.'
    }
  } else {
    Start-Sleep -Seconds 2
  }

  Write-UpdateLog 'Installing the verified update package silently.'
  $installerProcess = Start-Process -FilePath $resolvedInstallerPath -ArgumentList @('/S') -PassThru
  if (-not $installerProcess.WaitForExit($InstallTimeoutSeconds * 1000)) {
    try { $installerProcess.Kill() } catch {}
    Stop-WithCode 20 'The installer timed out.'
  }
  if ($installerProcess.ExitCode -ne 0) {
    Stop-WithCode 21 ("The installer exited with code {0}." -f $installerProcess.ExitCode)
  }

  if (-not (Test-Path -LiteralPath $resolvedAppExePath -PathType Leaf)) {
    Stop-WithCode 22 'The application executable was not found after installation.'
  }
  Start-Process -FilePath $resolvedAppExePath | Out-Null
  Write-UpdateLog 'Windows updater completed and relaunched the application.'
  exit 0
} catch {
  try { Write-UpdateLog ("Windows updater failed: {0}" -f $_.Exception.Message) } catch {}
  exit 30
}
