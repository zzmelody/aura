param([Parameter(ValueFromRemainingArguments = $true)][string[]]$TaskArgs)
. "$PSScriptRoot\env.ps1"
Set-Location -LiteralPath $auraRoot
if (!$TaskArgs.Count) { $TaskArgs = @('run', 'dev') }
& $auraNode $auraPnpm @TaskArgs
exit $LASTEXITCODE
