param(
  [Parameter(Mandatory)] [ValidatePattern('^[A-Za-z0-9_.-]+$')] [string] $Repository,
  [string] $RunnerRoot = 'C:\ci-runners',
  [string] $ProxyUrl = 'http://127.0.0.1:7890'
)

$ErrorActionPreference = 'Stop'
$runnerDir = Join-Path $RunnerRoot $Repository
$runCmd = Join-Path $runnerDir 'run.cmd'
if (-not (Test-Path -LiteralPath $runCmd -PathType Leaf)) { throw "Runner not found: $runCmd" }

# The proxy carries GitHub traffic; its control files and credentials stay in the daily account.
$env:HTTPS_PROXY = $ProxyUrl
$env:HTTP_PROXY = $ProxyUrl
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
Push-Location $runnerDir
try {
  & $runCmd
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
