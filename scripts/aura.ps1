param([Parameter(ValueFromRemainingArguments = $true)][string[]]$TaskArgs)
. "$PSScriptRoot\env.ps1"
Set-Location -LiteralPath $auraRoot
if (!$TaskArgs.Count) { $TaskArgs = @('run', 'dev') }
$env:AURA_LAUNCHER_PID = [string]$PID
& $auraPnpmCommand @auraPnpmArguments @TaskArgs
exit $LASTEXITCODE
