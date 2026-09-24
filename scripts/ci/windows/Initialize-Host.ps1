#Requires -RunAsAdministrator
param(
  [string] $CiAccountName = 'AuraCI',
  [string] $PersonalRepo = 'F:\aura',
  [string] $RunnerRoot = 'C:\ci-runners',
  [string] $ControlRoot = 'C:\ci-control'
)

$ErrorActionPreference = 'Stop'
trap {
  $message = $_.Exception.Message
  New-Item -ItemType Directory -Force -Path $ControlRoot | Out-Null
  $message | Set-Content -LiteralPath (Join-Path $ControlRoot 'initialize-last-error.txt') -Encoding UTF8
  Write-Host "Initialization failed: $message"
  exit 1
}

function Invoke-Icacls {
  param([string[]] $Arguments)
  & icacls.exe @Arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "icacls failed: $($Arguments -join ' ')" }
}

function Assert-NoBroadGrant {
  param([string] $Path)
  $broadSids = @('S-1-5-11', 'S-1-5-32-545')
  foreach ($ace in (Get-Acl -LiteralPath $Path).Access) {
    $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($ace.AccessControlType -eq 'Allow' -and $sid -in $broadSids) {
      throw "$Path still grants access to Authenticated Users or Users"
    }
  }
}

if (-not (Test-Path -LiteralPath $PersonalRepo -PathType Container)) {
  throw "Personal repository not found: $PersonalRepo"
}

$ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
New-Item -ItemType Directory -Force -Path $ControlRoot | Out-Null
$rootBackup = Join-Path $ControlRoot 'aura-root-acl.before.txt'
if (-not (Test-Path -LiteralPath $rootBackup)) {
  Invoke-Icacls -Arguments @($PersonalRepo, '/save', $rootBackup)
}
if (Test-Path -LiteralPath (Join-Path $PersonalRepo '.aura')) {
  $secretsBackup = Join-Path $ControlRoot 'aura-secrets-acl.before.txt'
  if (-not (Test-Path -LiteralPath $secretsBackup)) {
    Invoke-Icacls -Arguments @((Join-Path $PersonalRepo '.aura'), '/save', $secretsBackup)
  }
}

# Secure the personal checkout before creating another authenticated local user.
Invoke-Icacls -Arguments @($PersonalRepo, '/inheritance:d')
Invoke-Icacls -Arguments @($PersonalRepo, '/grant:r', "*$($ownerSid):(OI)(CI)F", '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
Invoke-Icacls -Arguments @($PersonalRepo, '/remove:g', '*S-1-5-11', '*S-1-5-32-545')
Assert-NoBroadGrant $PersonalRepo
if (Test-Path -LiteralPath (Join-Path $PersonalRepo '.aura')) {
  Assert-NoBroadGrant (Join-Path $PersonalRepo '.aura')
}

$ciUser = Get-LocalUser -Name $CiAccountName -ErrorAction SilentlyContinue
if (-not $ciUser) {
  $password = Read-Host "Set a password for local CI account $CiAccountName" -AsSecureString
  $ciUser = New-LocalUser -Name $CiAccountName -Password $password -Description 'GitHub Actions CI runner account'
  Remove-Variable password
}
if (-not $ciUser.Enabled) { throw "Local CI account is disabled: $CiAccountName" }
$ciSid = $ciUser.SID.Value
$users = Get-LocalGroup -SID 'S-1-5-32-545'
if (-not (Get-LocalGroupMember -Group $users.Name | Where-Object { $_.SID.Value -eq $ciSid })) {
  Add-LocalGroupMember -Group $users.Name -Member $ciUser
}
& net.exe user $CiAccountName /passwordreq:yes | Out-Host
if ($LASTEXITCODE -ne 0 -or -not (Get-LocalUser -Name $CiAccountName).PasswordRequired) {
  throw "CI account must require a password: $CiAccountName"
}
$administrators = Get-LocalGroup -SID 'S-1-5-32-544'
if (Get-LocalGroupMember -Group $administrators.Name | Where-Object { $_.SID.Value -eq $ciSid }) {
  throw "CI account must not be an administrator: $CiAccountName"
}

New-Item -ItemType Directory -Force -Path $RunnerRoot | Out-Null
Invoke-Icacls -Arguments @($RunnerRoot, '/inheritance:r')
Invoke-Icacls -Arguments @($RunnerRoot, '/grant:r', "*$($ownerSid):(OI)(CI)F", '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', "*$($ciSid):(OI)(CI)M")
Invoke-Icacls -Arguments @($RunnerRoot, '/remove:g', '*S-1-5-11', '*S-1-5-32-545')
Assert-NoBroadGrant $RunnerRoot

Invoke-Icacls -Arguments @($ControlRoot, '/inheritance:r')
Invoke-Icacls -Arguments @($ControlRoot, '/grant:r', "*$($ownerSid):(OI)(CI)F", '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', "*$($ciSid):(OI)(CI)RX")
Invoke-Icacls -Arguments @($ControlRoot, '/remove:g', '*S-1-5-11', '*S-1-5-32-545')
Assert-NoBroadGrant $ControlRoot

# The data volumes otherwise grant Modify rights to every authenticated user.
foreach ($drive in @('D:\', 'E:\', 'F:\')) {
  $backup = Join-Path $ControlRoot ("acl-$($drive[0]).before.txt")
  if (-not (Test-Path -LiteralPath $backup)) {
    Invoke-Icacls -Arguments @($drive, '/save', $backup)
  }
  Invoke-Icacls -Arguments @($drive, '/deny', "*$($ciSid):(OI)(CI)F")
}

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item -LiteralPath (Join-Path $source 'Enter-CiMode.ps1') -Destination $ControlRoot -Force
Copy-Item -LiteralPath (Join-Path $source 'Exit-CiMode.ps1') -Destination $ControlRoot -Force
Copy-Item -LiteralPath (Join-Path $source 'Invoke-GpuLocked.ps1') -Destination $ControlRoot -Force
Copy-Item -LiteralPath (Join-Path $source 'Register-Repository.ps1') -Destination $ControlRoot -Force
Copy-Item -LiteralPath (Join-Path $source 'Test-CiAccess.ps1') -Destination $ControlRoot -Force
Copy-Item -LiteralPath (Join-Path $source 'Run-Runner.ps1') -Destination $ControlRoot -Force

Write-Host "Created or verified $CiAccountName ($ciSid). Reboot and sign in once before starting interactive runners."
Remove-Item -LiteralPath (Join-Path $ControlRoot 'initialize-last-error.txt') -ErrorAction SilentlyContinue
'Completed' | Set-Content -LiteralPath (Join-Path $ControlRoot 'initialize-status.txt') -Encoding UTF8
