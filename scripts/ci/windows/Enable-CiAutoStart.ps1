#Requires -RunAsAdministrator
param(
  [string] $ControlRoot = 'C:\ci-control',
  [string] $CiAccountName = 'AuraCI'
)

$ErrorActionPreference = 'Stop'
trap {
  $_.Exception.Message | Set-Content -LiteralPath (Join-Path $ControlRoot 'autostart-last-error.txt') -Encoding UTF8
  exit 1
}
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $ControlRoot 'repositories.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Missing runner manifest: $manifestPath" }
$parsedManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$repositories = @($parsedManifest | ForEach-Object { $_ })
if ($repositories.Count -eq 0) { throw 'No repositories are registered.' }
$ciUser = Get-LocalUser -Name $CiAccountName -ErrorAction Stop
if (-not $ciUser.Enabled) { throw "CI account is disabled: $CiAccountName" }
$administrators = Get-LocalGroup -SID 'S-1-5-32-544'
if (Get-LocalGroupMember -Group $administrators.Name | Where-Object { $_.SID.Value -eq $ciUser.SID.Value }) {
  throw "CI account must not be an administrator: $CiAccountName"
}
$ciIdentity = "$env:COMPUTERNAME\$CiAccountName"
$launcherPath = Join-Path $ControlRoot 'Run-Runner.ps1'
foreach ($entry in $repositories) {
  if ($entry.owner -ne 'zzmelody' -or $entry.repository -notmatch '^[A-Za-z0-9_.-]+$' -or
      $entry.taskName -ne "Aura-CI-$($entry.repository)" -or
      $entry.directory -ne "C:\ci-runners\$($entry.repository)") {
    throw "Unexpected runner registration: $($entry.repository)"
  }
  $task = Get-ScheduledTask -TaskName $entry.taskName -ErrorAction Stop
  if (($task.Principal.UserId -ine $ciIdentity -and $task.Principal.UserId -ine $CiAccountName) -or
      $task.Principal.LogonType -ne 'Interactive' -or
      $task.Principal.RunLevel -ne 'Limited' -or $task.Actions.Count -ne 1 -or
      $task.Actions[0].Execute -ine 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -or
      $task.Actions[0].Arguments -notlike "*-File `"$launcherPath`" -Repository $($entry.repository)*") {
    throw "Runner task has unexpected principal or action: $($entry.taskName)"
  }
}

foreach ($name in @('Assert-CiEnvironment.ps1', 'Run-Runner.ps1')) {
  Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $ControlRoot $name) -Force
}
foreach ($entry in $repositories) {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $ciIdentity
  Set-ScheduledTask -TaskName $entry.taskName -Trigger $trigger | Out-Null
  $task = Get-ScheduledTask -TaskName $entry.taskName
  if (@($task.Triggers | Where-Object {
    $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and
    ($_.UserId -ieq $ciIdentity -or $_.UserId -ieq $CiAccountName)
  }).Count -ne 1) {
    throw "Logon trigger was not saved: $($entry.taskName)"
  }
  Write-Host "Enabled AuraCI logon startup: $($entry.taskName)"
}
Remove-Item -LiteralPath (Join-Path $ControlRoot 'autostart-last-error.txt') -ErrorAction SilentlyContinue
[pscustomobject]@{
  configuredAt = (Get-Date).ToUniversalTime().ToString('o')
  account = $ciIdentity
  tasks = @($repositories | ForEach-Object { $_.taskName })
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ControlRoot 'autostart-status.json') -Encoding UTF8
