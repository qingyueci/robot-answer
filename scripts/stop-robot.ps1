param(
  [switch]$IncludeMemoryServices
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$nightlyWorker = Join-Path $PSScriptRoot "nightly-memory-worker.mjs"

$workers = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$nightlyWorker*" }
foreach ($worker in $workers) {
  Stop-Process -Id $worker.ProcessId -Force -ErrorAction SilentlyContinue
}

$listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($listener) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
  if ($process.CommandLine -like "*$projectRoot*" -or $process.CommandLine -like "*next*") {
    Stop-Process -Id $listener.OwningProcess -Force
  }
}

if ($IncludeMemoryServices) {
  $running = docker inspect -f "{{.State.Running}}" robot-qdrant 2>$null
  if ($LASTEXITCODE -eq 0 -and $running -eq "true") {
    docker stop robot-qdrant | Out-Null
  }
}

Write-Host "Robot 网站和夜间记忆整理已停止。" -ForegroundColor Green
