#Requires -RunAsAdministrator
param(
  [Parameter(Mandatory)] [ValidatePattern('^[A-Za-z0-9_.-]+$')] [string] $Repository,
  [string] $Owner = 'zzmelody',
  [string] $CiAccountName = 'AuraCI',
  [string] $RunnerRoot = 'C:\ci-runners',
  [string] $ControlRoot = 'C:\ci-control'
)

$ErrorActionPreference = 'Stop'
trap {
  $message = $_.Exception.Message
  New-Item -ItemType Directory -Force -Path $ControlRoot | Out-Null
  $message | Set-Content -LiteralPath (Join-Path $ControlRoot 'register-last-error.txt') -Encoding UTF8
  Write-Host "Registration failed: $message"
  exit 1
}
if ($Owner -ne 'zzmelody') { throw 'Only repositories owned by zzmelody are allowed.' }
$ciUser = Get-LocalUser -Name $CiAccountName -ErrorAction Stop
if (-not $ciUser.Enabled) { throw 'CI account is disabled.' }

$credentialLines = @('protocol=https', 'host=github.com', 'username=zzmelody', '') | git credential-manager get
$passwordLine = $credentialLines | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
if (-not $passwordLine) { throw 'No GitHub credential for zzmelody in the current user profile.' }
$accessToken = $passwordLine.Substring(9)
Remove-Variable credentialLines, passwordLine
$headers = @{
  Authorization = "Bearer $accessToken"
  Accept = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent' = 'Aura-CI-setup'
}
$apiRoot = "https://api.github.com/repos/$Owner/$Repository"
try {
  $me = Invoke-RestMethod 'https://api.github.com/user' -Headers $headers
  $repo = Invoke-RestMethod $apiRoot -Headers $headers
  $collaborators = @(Invoke-RestMethod "$apiRoot/collaborators?per_page=100" -Headers $headers)
  if ($me.login -ne 'zzmelody' -or $repo.full_name -ne "$Owner/$Repository" -or -not $repo.private -or -not $repo.permissions.admin) {
    throw 'Repository ownership, visibility, or administrator permission failed verification.'
  }
  if ($collaborators.Count -ne 1 -or $collaborators[0].login -ne 'zzmelody') {
    throw 'The repository must have only zzmelody as a collaborator before using this host.'
  }

  $release = Invoke-RestMethod 'https://api.github.com/repos/actions/runner/releases/latest' -Headers $headers
  $asset = $release.assets | Where-Object { $_.name -match '^actions-runner-win-x64-[0-9.]+\.zip$' } | Select-Object -First 1
  if (-not $asset -or $asset.digest -notmatch '^sha256:[0-9a-fA-F]{64}$') {
    throw 'Official Windows x64 runner asset or its SHA-256 digest is unavailable.'
  }
  $expectedHash = $asset.digest.Substring(7)
  $archive = Join-Path $env:TEMP $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive -Headers @{ 'User-Agent' = 'Aura-CI-setup' }
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash
  if ($actualHash -ne $expectedHash) { throw 'Runner download SHA-256 verification failed.' }

  $runnerDir = Join-Path $RunnerRoot $Repository
  if (Test-Path -LiteralPath $runnerDir) {
    if (@(Get-ChildItem -LiteralPath $runnerDir -Force).Count -gt 0) {
      throw "Runner directory is not empty: $runnerDir"
    }
  } else {
    New-Item -ItemType Directory -Path $runnerDir | Out-Null
  }
  Expand-Archive -LiteralPath $archive -DestinationPath $runnerDir
  Remove-Item -LiteralPath $archive -Force

  $label = "zzmelody-$Repository-win"
  $runnerName = "$env:COMPUTERNAME-$Repository"
  $registration = Invoke-RestMethod "$apiRoot/actions/runners/registration-token" -Method Post -Headers $headers
  $env:ACTIONS_RUNNER_INPUT_TOKEN = $registration.token
  try {
    Push-Location $runnerDir
    & (Join-Path $runnerDir 'config.cmd') --unattended --url "https://github.com/$Owner/$Repository" --name $runnerName --work _work --labels $label --no-default-labels
    if ($LASTEXITCODE -ne 0) { throw 'Runner registration failed.' }
  } finally {
    Pop-Location
    Remove-Item Env:ACTIONS_RUNNER_INPUT_TOKEN -ErrorAction SilentlyContinue
  }

  $taskName = "Aura-CI-$Repository"
  $launcher = Join-Path $ControlRoot 'Run-Runner.ps1'
  if (-not (Test-Path -LiteralPath $launcher)) { throw "Missing runner launcher: $launcher" }
  $action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Repository $Repository" -WorkingDirectory $runnerDir
  $principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$CiAccountName" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null

  $accessCheck = Join-Path $ControlRoot 'Test-CiAccess.ps1'
  if (-not (Test-Path -LiteralPath $accessCheck)) { throw "Missing access check script: $accessCheck" }
  $checkAction = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$accessCheck`"" -WorkingDirectory $ControlRoot
  Register-ScheduledTask -TaskName 'Aura-CI-AccessCheck' -Action $checkAction -Principal $principal -Settings $settings -Force | Out-Null

  $manifestPath = Join-Path $ControlRoot 'repositories.json'
  $manifest = @()
  if (Test-Path -LiteralPath $manifestPath) {
    $parsedManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest = @($parsedManifest | ForEach-Object { $_ })
  }
  $manifest += [pscustomobject]@{ owner = $Owner; repository = $Repository; runnerName = $runnerName; taskName = $taskName; directory = $runnerDir }
  ConvertTo-Json -InputObject $manifest -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  Remove-Item -LiteralPath (Join-Path $ControlRoot 'register-last-error.txt') -ErrorAction SilentlyContinue
  Write-Host "Registered $Owner/$Repository as $runnerName with label $label. Interactive task: $taskName"
} finally {
  Remove-Variable accessToken, headers -ErrorAction SilentlyContinue
}
