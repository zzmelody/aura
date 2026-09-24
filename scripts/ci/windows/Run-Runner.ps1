param(
  [Parameter(Mandatory)] [ValidatePattern('^[A-Za-z0-9_.-]+$')] [string] $Repository,
  [string] $RunnerRoot = 'C:\ci-runners',
  [string] $ProxyUrl = 'http://127.0.0.1:7890'
)

$ErrorActionPreference = 'Stop'
$runnerDir = Join-Path $RunnerRoot $Repository
$runCmd = Join-Path $runnerDir 'run.cmd'
if (-not (Test-Path -LiteralPath $runCmd -PathType Leaf)) { throw "Runner not found: $runCmd" }
$guard = 'C:\ci-control\Assert-CiEnvironment.ps1'
if (-not (Test-Path -LiteralPath $guard -PathType Leaf)) { throw "Runner guard not found: $guard" }

# The proxy carries GitHub traffic; its control files and credentials stay in the daily account.
$env:HTTPS_PROXY = $ProxyUrl
$env:HTTP_PROXY = $ProxyUrl
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
$env:ACTIONS_RUNNER_HOOK_JOB_STARTED = $guard
$statusPath = Join-Path $runnerDir 'launcher-status.json'
while ($true) {
  try {
    & $guard
    [pscustomobject]@{ at = (Get-Date).ToUniversalTime().ToString('o'); state = 'starting' } |
      ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
    Push-Location $runnerDir
    try {
      & $runCmd
      $runnerExitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    $message = "Runner exited with code $runnerExitCode; retrying."
  } catch {
    $message = $_.Exception.Message
  }
  [pscustomobject]@{ at = (Get-Date).ToUniversalTime().ToString('o'); state = 'waiting'; reason = $message } |
    ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
  Start-Sleep -Seconds 30
}
