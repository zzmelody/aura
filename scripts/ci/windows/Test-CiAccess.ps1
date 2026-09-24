param(
  [string] $ResultPath = 'C:\ci-runners\access-check.json'
)

$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([System.Security.Principal.WindowsPrincipal] $identity).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$checks = [ordered]@{}
foreach ($path in @('F:\aura', 'F:\aura\.aura', 'D:\', 'E:\', 'F:\', 'C:\Users\15389')) {
  try {
    Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop | Select-Object -First 1 | Out-Null
    $checks[$path] = $false
  } catch {
    $checks[$path] = $true
  }
}
$probe = Join-Path (Split-Path -Parent $ResultPath) ([guid]::NewGuid().ToString('N') + '.txt')
try {
  'CI write check' | Set-Content -LiteralPath $probe -Encoding UTF8
  $ownDirectoryWorks = (Get-Content -LiteralPath $probe -Raw).TrimEnd("`r", "`n") -eq 'CI write check'
} finally {
  Remove-Item -LiteralPath $probe -ErrorAction SilentlyContinue
}
$passed = $identity.Name -like '*\AuraCI' -and -not $isAdmin -and $ownDirectoryWorks -and @($checks.Values | Where-Object { -not $_ }).Count -eq 0
[pscustomobject]@{
  account = $identity.Name
  sid = $identity.User.Value
  isAdmin = $isAdmin
  ownDirectoryWorks = $ownDirectoryWorks
  checks = $checks
  passed = $passed
  checkedAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ResultPath -Encoding UTF8
if (-not $passed) { exit 1 }
