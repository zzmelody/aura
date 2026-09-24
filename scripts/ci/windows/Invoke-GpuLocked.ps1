param(
  [Parameter(Mandatory)] [string] $FilePath,
  [string[]] $ArgumentList = @(),
  [int] $TimeoutSeconds = 3600
)

$ErrorActionPreference = 'Stop'
$mutex = [System.Threading.Mutex]::new($false, 'Global\AuraPersonalCiGpu')
$held = $false
try {
  $held = $mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))
  if (-not $held) { throw 'Timed out waiting for the shared GPU lock.' }
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
