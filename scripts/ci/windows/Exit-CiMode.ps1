param(
  [string] $ControlRoot = 'C:\ci-control',
  [int] $MaxWaitMinutes = 60
)

$ErrorActionPreference = 'Stop'
$parsedManifest = Get-Content -LiteralPath (Join-Path $ControlRoot 'repositories.json') -Raw | ConvertFrom-Json
$repositories = @($parsedManifest | ForEach-Object { $_ })
if ($repositories.Count -eq 0) { throw 'No repositories have been registered.' }
$credentialLines = @('protocol=https', 'host=github.com', 'username=zzmelody', '') | git credential-manager get
$passwordLine = $credentialLines | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
if (-not $passwordLine) { throw 'Cannot verify runner busy state without the zzmelody GitHub credential.' }
$accessToken = $passwordLine.Substring(9)
Remove-Variable credentialLines, passwordLine
$headers = @{
  Authorization = "Bearer $accessToken"
  Accept = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent' = 'Aura-CI-control'
}

try {
  $deadline = (Get-Date).AddMinutes($MaxWaitMinutes)
  do {
    $busy = @()
    foreach ($entry in $repositories) {
      $result = Invoke-RestMethod "https://api.github.com/repos/$($entry.owner)/$($entry.repository)/actions/runners?per_page=100" -Headers $headers
      $runner = $result.runners | Where-Object { $_.name -eq $entry.runnerName } | Select-Object -First 1
      if ($runner -and $runner.busy) { $busy += "$($entry.owner)/$($entry.repository)" }
    }
    if ($busy.Count -eq 0) { break }
    if ((Get-Date) -ge $deadline) { throw "Still busy after $MaxWaitMinutes minutes: $($busy -join ', ')" }
    Write-Host "Waiting for active jobs: $($busy -join ', ')"
    Start-Sleep -Seconds 15
  } while ($true)

  foreach ($entry in $repositories) {
    $bin = [IO.Path]::GetFullPath((Join-Path $entry.directory 'bin'))
    $workers = @(Get-CimInstance Win32_Process -Filter "Name = 'Runner.Worker.exe'" | Where-Object {
      $_.ExecutablePath -and [IO.Path]::GetFullPath((Split-Path -Parent $_.ExecutablePath)) -eq $bin
    })
    if ($workers.Count -gt 0) { throw "Runner worker is still active: $($entry.owner)/$($entry.repository)" }
    $task = Get-ScheduledTask -TaskName $entry.taskName
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $entry.taskName }
    $listenerPath = [IO.Path]::GetFullPath((Join-Path $bin 'Runner.Listener.exe'))
    $listeners = @(Get-CimInstance Win32_Process -Filter "Name = 'Runner.Listener.exe'" | Where-Object {
      $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $listenerPath
    })
    foreach ($listener in $listeners) { Stop-Process -Id $listener.ProcessId -Force }
    Write-Host "Stopped $($entry.owner)/$($entry.repository) runner task."
  }
  $offlineDeadline = (Get-Date).AddSeconds(60)
  do {
    $online = @()
    foreach ($entry in $repositories) {
      $result = Invoke-RestMethod "https://api.github.com/repos/$($entry.owner)/$($entry.repository)/actions/runners?per_page=100" -Headers $headers
      $runner = $result.runners | Where-Object { $_.name -eq $entry.runnerName } | Select-Object -First 1
      if ($runner -and $runner.status -ne 'offline') { $online += "$($entry.owner)/$($entry.repository)" }
    }
    if ($online.Count -eq 0) { break }
    if ((Get-Date) -ge $offlineDeadline) { throw "Runner process remains online: $($online -join ', ')" }
    Start-Sleep -Seconds 5
  } while ($true)
} finally {
  Remove-Variable accessToken, headers -ErrorAction SilentlyContinue
}
Write-Host 'CI mode is disabled and GitHub reports each runner Offline.'
