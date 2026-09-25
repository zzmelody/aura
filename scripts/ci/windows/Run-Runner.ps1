param(
  [Parameter(Mandatory)] [ValidatePattern('^[A-Za-z0-9_.-]+$')] [string] $Repository,
  [string] $RunnerRoot = 'C:\ci-runners',
  [string] $ControlRoot = 'C:\ci-control',
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
$toolRoot = 'C:\ci-control\tools'
$nodeDir = Join-Path $toolRoot 'node'
$pnpmDir = Join-Path $toolRoot 'pnpm'
$env:PATH = "$nodeDir;$pnpmDir;$env:PATH"
$codexBin = Join-Path $toolRoot 'codex-cli\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin'
if (Test-Path -LiteralPath (Join-Path $codexBin 'codex.exe') -PathType Leaf) {
  $env:PATH = "$(Join-Path $toolRoot 'codex-wrapper');$codexBin;$env:PATH"
}
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
    $updateMirrors = Join-Path $ControlRoot 'Update-Mirrors.ps1'
    if (Test-Path -LiteralPath $updateMirrors -PathType Leaf) {
      & $updateMirrors
    }
  } catch {
    $message = $_.Exception.Message
  }
  [pscustomobject]@{ at = (Get-Date).ToUniversalTime().ToString('o'); state = 'waiting'; reason = $message } |
    ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
  Start-Sleep -Seconds 30
}
