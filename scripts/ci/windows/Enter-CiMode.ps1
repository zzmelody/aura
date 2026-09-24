param([string] $ControlRoot = 'C:\ci-control')

$ErrorActionPreference = 'Stop'
$manifestPath = Join-Path $ControlRoot 'repositories.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'No repositories have been registered.' }
$repositories = @(Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json)
if ($repositories.Count -eq 0) { throw 'No repositories have been registered.' }

foreach ($port in @(4311, 8188)) {
  if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
    throw "Local service port $port is listening. Stop credential-bearing local services before CI mode."
  }
}
if (Get-Process -Name 'Godot*' -ErrorAction SilentlyContinue) {
  throw 'Godot is already running outside CI. Stop it before entering CI mode.'
}

$checkPath = 'C:\ci-runners\access-check.json'
Remove-Item -LiteralPath $checkPath -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'Aura-CI-AccessCheck'
$checkDeadline = (Get-Date).AddSeconds(30)
while (-not (Test-Path -LiteralPath $checkPath)) {
  if ((Get-Date) -ge $checkDeadline) { throw 'CI access check did not finish. Log in to AuraCI and retry.' }
  Start-Sleep -Seconds 1
}
$check = Get-Content -LiteralPath $checkPath -Raw | ConvertFrom-Json
if (-not $check.passed -or $check.sid -ne (Get-LocalUser -Name 'AuraCI').SID.Value) {
  throw 'CI account could access a protected location or has unexpected privileges. Keep runners offline.'
}

foreach ($entry in $repositories) {
  Start-ScheduledTask -TaskName $entry.taskName
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-ScheduledTask -TaskName $entry.taskName).State -ne 'Running') {
    if ((Get-Date) -ge $deadline) { throw "Runner task did not remain running: $($entry.taskName)" }
    Start-Sleep -Seconds 1
  }
  Write-Host "Started $($entry.owner)/$($entry.repository) runner task."
}
Write-Host 'CI mode is enabled. Keep Aura, ComfyUI, Veya and other credential-bearing localhost services stopped.'
