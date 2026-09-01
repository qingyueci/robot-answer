[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot "apps\web\.env.local"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
  throw "APPDATA 环境变量为空，未写入桌面配置。"
}

$targetDirectory = Join-Path $env:APPDATA "Home Robot\config"
$target = Join-Path $targetDirectory ".env.local"
$temporary = Join-Path $targetDirectory ".env.local.$PID.tmp"
$backup = Join-Path $targetDirectory ".env.local.backup-$timestamp"

if (-not (Test-Path -LiteralPath $source)) {
  throw "未找到本机 Robot 配置：$source"
}

New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash

if (Test-Path -LiteralPath $target) {
  $targetHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
  if ($sourceHash -eq $targetHash) {
    Write-Output "DESKTOP_CONFIG_INSTALLED=PASS"
    Write-Output "RESULT=UNCHANGED"
    Write-Output "TARGET=$target"
    Write-Output "BACKUP=NONE"
    return
  }
}

try {
  [System.IO.File]::Copy($source, $temporary, $true)
  $temporaryHash = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash
  if ($temporaryHash -ne $sourceHash) {
    throw "桌面配置临时副本校验失败。"
  }

  if (Test-Path -LiteralPath $target) {
    [System.IO.File]::Replace($temporary, $target, $backup, $true)
    $backupResult = $backup
  } else {
    [System.IO.File]::Move($temporary, $target)
    $backupResult = "NONE"
  }
} finally {
  if (Test-Path -LiteralPath $temporary) {
    Remove-Item -LiteralPath $temporary -Force
  }
}

$installedHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
if ($installedHash -ne $sourceHash) {
  throw "桌面配置安装后校验失败。"
}

Write-Output "DESKTOP_CONFIG_INSTALLED=PASS"
Write-Output "RESULT=UPDATED"
Write-Output "TARGET=$target"
Write-Output "BACKUP=$backupResult"
