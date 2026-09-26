<#
.SYNOPSIS
  Set up Ollama on a native Windows host for the Enflite AI platform.

.DESCRIPTION
  Ollama is the platform's primary inference provider (chat + embeddings)
  and runs natively on Windows with GPU support. This script:
    1. Checks whether Ollama is installed (downloads the official installer
       if not),
    2. Pulls the platform's default chat and embedding models,
    3. Verifies the install with `ollama list`.

  After running it, point the backend at this host:
    OLLAMA_BASE_URL=http://localhost:11434
    EMBEDDING_PROVIDER=ollama          (this is already the default)

  The backend never needs to run on the same machine — any host that can
  reach this machine's port 11434 works (add its origin to
  AI_PROVIDER_ALLOWED_ORIGINS if it is not localhost).

  Requires: PowerShell 5.1+, internet access. Installing Ollama needs
  administrator rights; pulling models does not.
#>
[CmdletBinding()]
param(
  [string]$ChatModel = 'llama3.1:8b',
  [string]$EmbeddingModel = 'nomic-embed-text',
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

function Test-OllamaInstalled {
  return [bool](Get-Command ollama -ErrorAction SilentlyContinue)
}

function Install-Ollama {
  $installerUrl = 'https://ollama.com/download/OllamaSetup.exe'
  $installerPath = Join-Path $env:TEMP 'OllamaSetup.exe'
  Write-Host "Ollama not found. Downloading installer from $installerUrl ..."
  Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing
  Write-Host 'Running the Ollama installer (may prompt for elevation)...'
  $proc = Start-Process -FilePath $installerPath -ArgumentList '/S' -Wait -PassThru
  if ($proc.ExitCode -ne 0) {
    throw "Ollama installer exited with code $($proc.ExitCode). Re-run this script with -SkipInstall after installing manually from https://ollama.com/download"
  }
  # The installer adds %LOCALAPPDATA%\Programs\Ollama to the user PATH;
  # refresh it for this session.
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machinePath;$userPath"
  if (-not (Test-OllamaInstalled)) {
    throw 'Ollama installed but `ollama` is not on PATH in this session. Open a new terminal and re-run this script with -SkipInstall.'
  }
}

function Wait-OllamaReady {
  # `ollama pull` starts the server on demand, but an explicit readiness
  # check gives a clearer error when something is wrong.
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-WebRequest -Uri 'http://localhost:11434/api/tags' -UseBasicParsing -TimeoutSec 5
      if ($resp.StatusCode -eq 200) { return }
    } catch { }
    Start-Sleep -Seconds 2
  }
  throw 'Ollama did not answer on http://localhost:11434 within 60s.'
}

if (-not (Test-OllamaInstalled)) {
  if ($SkipInstall) {
    throw 'Ollama is not installed and -SkipInstall was given. Install it from https://ollama.com/download first.'
  }
  Install-Ollama
} else {
  Write-Host 'Ollama is already installed.'
}

Write-Host 'Waiting for the Ollama server...'
Wait-OllamaReady
Write-Host 'Ollama server is up.'

foreach ($model in @($ChatModel, $EmbeddingModel)) {
  Write-Host "Pulling model: $model (this can take a while on first run)..."
  & ollama pull $model
  if ($LASTEXITCODE -ne 0) {
    throw "`ollama pull $model` failed with exit code $LASTEXITCODE."
  }
}

Write-Host ''
Write-Host 'Verifying installed models:'
& ollama list
if ($LASTEXITCODE -ne 0) { throw '`ollama list` failed.' }

Write-Host ''
Write-Host 'Done. Backend configuration for this host:'
Write-Host '  OLLAMA_BASE_URL=http://localhost:11434'
Write-Host '  EMBEDDING_PROVIDER=ollama   (default; no change needed)'
Write-Host ''
Write-Host 'Serving a fine-tuned GGUF later? Create a Modelfile and run:'
Write-Host '  ollama create <name> -f Modelfile'
Write-Host 'then register <name> in the model registry (docs/inference.md).'
