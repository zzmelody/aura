param(
  [Parameter(Mandatory)] [string] $ConfigFile,
  [int] $TimeoutSeconds = 3600
)
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$config = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
$arguments = [string[]] $config.arguments
$promptFile = [string] $config.promptFile
$mutex = $null
$held = $false
try {
  if ($config.gpuLock) {
    $mutex = [System.Threading.Mutex]::new($false, 'Global\AuraPersonalCiGpu')
    $held = $mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))
    if (-not $held) { throw 'Timed out waiting for the shared GPU lock.' }
  }
  $agent = [string] $config.agent
  if (-not $agent) { $agent = 'codex' }
  if ($agent -eq 'claude') {
    $claude = 'C:\ci-control\tools\claude\claude.exe'
    if (-not (Test-Path -LiteralPath $claude -PathType Leaf)) { throw "Claude Code is missing: $claude" }
    $configDir = Join-Path ([IO.Path]::GetTempPath()) ("claude-ci-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    try {
      $env:CLAUDE_CONFIG_DIR = $configDir
      $env:ANTHROPIC_AUTH_TOKEN = 'sk-MBLKriCsV3Ojfaoeej3d5w'
      $env:ANTHROPIC_BASE_URL = 'https://lumina.tripo3d.com'
      $env:ANTHROPIC_MODEL = 'claude-opus-5[1M]'
      # Without this, a stalled proxy connection hangs the run until the job timeout.
      $env:API_TIMEOUT_MS = '180000'
      Get-Content -LiteralPath $promptFile -Raw -Encoding UTF8 | & $claude @arguments |
        Set-Content -LiteralPath ([string] $config.outputFile) -Encoding UTF8
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
      Remove-Item -LiteralPath $configDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  } else {
    Get-Content -LiteralPath $promptFile -Raw -Encoding UTF8 | & codex @arguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  if ($mutex) { $mutex.Dispose() }
}
