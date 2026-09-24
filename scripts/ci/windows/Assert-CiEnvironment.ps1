$ErrorActionPreference = 'Stop'

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [System.Security.Principal.WindowsPrincipal] $identity
if ($identity.Name -ine "$env:COMPUTERNAME\AuraCI" -or
    $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'The runner must use the non-administrator AuraCI account.'
}

foreach ($path in @('F:\aura', 'F:\aura\.aura', 'D:\', 'E:\', 'F:\', 'C:\Users\15389')) {
  $readable = $false
  try {
    Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop | Select-Object -First 1 | Out-Null
    $readable = $true
  } catch {
    if ($_.Exception -isnot [System.UnauthorizedAccessException]) {
      throw "Could not verify access denial for $path`: $($_.Exception.Message)"
    }
  }
  if ($readable) { throw "CI can read protected path: $path" }
}

foreach ($port in @(4311, 8188)) {
  if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
    throw "Credential-bearing local service port $port is listening. Stop that service before running CI jobs."
  }
}
if (Get-Process -Name 'Godot*' -ErrorAction SilentlyContinue) {
  throw 'Godot is already running outside CI.'
}
if (Get-Process -Name 'Veya*' -ErrorAction SilentlyContinue) {
  throw 'Veya is already running outside CI.'
}
if (-not (Get-NetTCPConnection -State Listen -LocalPort 7890 -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' })) {
  throw 'The local GitHub proxy at 127.0.0.1:7890 is unavailable.'
}
