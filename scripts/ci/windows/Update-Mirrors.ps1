param(
  [string] $MirrorRoot = 'C:\ci-runners\mirrors',
  [string] $ProxyUrl = 'http://127.0.0.1:7890'
)

$ErrorActionPreference = 'Stop'
$env:HTTPS_PROXY = $ProxyUrl
$env:HTTP_PROXY = $ProxyUrl
$env:NO_PROXY = 'localhost,127.0.0.1,::1'

# Bare mirrors that CI jobs fetch from, so GitHub is contacted once here
# instead of by every job. URLs are public or readable without credentials.
$mirrors = @(
  @{ Name = 'Veya.git'; Url = 'https://github.com/zzmelody/Veya.git' },
  @{ Name = 'aura.git'; Url = 'https://github.com/zzmelody/aura.git' },
  @{ Name = 'godot.git'; Url = 'https://github.com/zzmelody/godot.git' },
  @{ Name = 'godot-cpp.git'; Url = 'https://github.com/godotengine/godot-cpp.git' },
  @{ Name = 'flecs.git'; Url = 'https://github.com/SanderMertens/flecs.git' },
  @{ Name = 'luau.git'; Url = 'https://github.com/luau-lang/luau.git' },
  @{ Name = 'gns.git'; Url = 'https://github.com/ValveSoftware/GameNetworkingSockets.git' }
)

New-Item -ItemType Directory -Force -Path $MirrorRoot | Out-Null
foreach ($mirror in $mirrors) {
  $path = Join-Path $MirrorRoot $mirror.Name
  if (-not (Test-Path -LiteralPath (Join-Path $path 'HEAD'))) {
    & git clone --mirror $mirror.Url $path
  } else {
    & git -C $path fetch --prune
  }
  if ($LASTEXITCODE -ne 0) { throw "Mirror update failed: $($mirror.Name)" }
}
