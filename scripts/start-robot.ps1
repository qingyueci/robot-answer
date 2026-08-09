param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $projectRoot "apps\web"
$url = "http://127.0.0.1:3000"
$node = "C:\Program Files\nodejs\node.exe"

function Test-LocalPort([int]$Port) {
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Wait-LocalPort([int]$Port, [int]$TimeoutSeconds) {
  for ($attempt = 0; $attempt -lt $TimeoutSeconds; $attempt++) {
    if (Test-LocalPort $Port) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

# 启动本地嵌入模型服务。
$ollamaCommand = Get-Command ollama.exe -ErrorAction SilentlyContinue
$ollamaPath = if ($ollamaCommand) {
  $ollamaCommand.Source
} else {
  Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
}
if (-not (Test-Path $ollamaPath)) { throw "未找到 Ollama，请先安装 Ollama。" }

if (-not (Test-LocalPort 11434)) {
  Start-Process -FilePath $ollamaPath -ArgumentList "serve" -WindowStyle Hidden
  if (-not (Wait-LocalPort 11434 30)) { throw "Ollama 启动超时。" }
}

$modelList = (& $ollamaPath list) -join "`n"
if ($modelList -notmatch "nomic-embed-text-v2-moe") {
  & $ollamaPath pull nomic-embed-text-v2-moe
  if ($LASTEXITCODE -ne 0) { throw "记忆嵌入模型下载失败。" }
}

# 启动 Docker Desktop 和本地 Qdrant。
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  $dockerDesktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  if (-not (Test-Path $dockerDesktop)) { throw "未找到 Docker Desktop。" }
  Start-Process -FilePath $dockerDesktop -WindowStyle Hidden
  $dockerReady = $false
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { $dockerReady = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $dockerReady) { throw "Docker Desktop 启动超时。" }
}

$containerExists = docker container inspect robot-qdrant 2>$null
if ($LASTEXITCODE -ne 0) {
  docker run -d --name robot-qdrant --restart unless-stopped `
    -p 127.0.0.1:6333:6333 `
    -v robot_qdrant_data:/qdrant/storage qdrant/qdrant:latest | Out-Null
} else {
  $containerRunning = docker inspect -f "{{.State.Running}}" robot-qdrant
  if ($containerRunning -ne "true") { docker start robot-qdrant | Out-Null }
}
if (-not (Wait-LocalPort 6333 30)) { throw "Qdrant 启动超时。" }

# 已运行时直接打开；否则启动构建好的 Robot 网站。
if (-not (Test-LocalPort 3000)) {
  if (-not (Test-Path (Join-Path $webRoot ".next\BUILD_ID"))) {
    Push-Location $webRoot
    try { npm run build } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "Robot 构建失败。" }
  }

  $next = Join-Path $projectRoot "node_modules\next\dist\bin\next"
  Start-Process -FilePath $node `
    -ArgumentList "`"$next`" start -p 3000" `
    -WorkingDirectory $webRoot `
    -WindowStyle Hidden
  if (-not (Wait-LocalPort 3000 30)) { throw "Robot 网站启动超时。" }
}

# 夜间记忆整理只调用本地治理接口，不会触发聊天模型。
$worker = Join-Path $projectRoot "scripts\nightly-memory-worker.mjs"
$workerRunning = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*nightly-memory-worker.mjs*" } |
  Select-Object -First 1
if (-not $workerRunning) {
  $stateRoot = Join-Path $projectRoot "data\state"
  New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
  Start-Process -FilePath $node `
    -ArgumentList "`"$worker`"" `
    -WorkingDirectory $projectRoot `
    -RedirectStandardOutput (Join-Path $stateRoot "nightly-maintenance.log") `
    -RedirectStandardError (Join-Path $stateRoot "nightly-maintenance.error.log") `
    -WindowStyle Hidden
}

Write-Host "Home Robot已启动：$url" -ForegroundColor Green
Write-Host "夜间记忆整理：每日 23:30" -ForegroundColor DarkGreen
if (-not $NoBrowser) { Start-Process $url }
