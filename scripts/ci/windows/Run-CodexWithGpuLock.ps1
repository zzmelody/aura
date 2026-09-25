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
  Get-Content -LiteralPath $promptFile -Raw -Encoding UTF8 | & codex @arguments
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  if ($mutex) { $mutex.Dispose() }
}
