param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
$RequireSigning = $env:REQUIRE_SIGNING -eq '1'
$CertificateBase64 = $env:WINDOWS_CERTIFICATE_BASE64
$CertificatePassword = $env:WINDOWS_CERTIFICATE_PASSWORD

if ([string]::IsNullOrWhiteSpace($CertificateBase64)) {
  if ($RequireSigning) { throw '发布版本必须配置 WINDOWS_CERTIFICATE_BASE64。' }
  Write-Warning '未配置 Windows 代码签名证书，跳过签名（将生成未签名安装包）。'
  exit 0
}
if ([string]::IsNullOrWhiteSpace($CertificatePassword)) {
  throw '已配置 Windows 代码签名证书，但缺少 WINDOWS_CERTIFICATE_PASSWORD。'
}

$CertificatePath = Join-Path $env:RUNNER_TEMP 'meimei-workbench-signing.pfx'
[IO.File]::WriteAllBytes($CertificatePath, [Convert]::FromBase64String($CertificateBase64))
$SignTool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
if (-not $SignTool) {
  $SignTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $SignTool) { throw '找不到 signtool.exe。' }

& $SignTool sign /fd SHA256 /f $CertificatePath /p $CertificatePassword /tr 'http://timestamp.digicert.com' /td SHA256 $InstallerPath
if ($LASTEXITCODE -ne 0) { throw "Windows 安装包签名失败：$LASTEXITCODE" }
& $SignTool verify /pa /all $InstallerPath
if ($LASTEXITCODE -ne 0) { throw "Windows 安装包签名校验失败：$LASTEXITCODE" }
