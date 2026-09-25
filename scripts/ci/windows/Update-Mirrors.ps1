param(
  [string] $MirrorRoot = 'C:\ci-runners\mirrors',
  [string] $ProxyUrl = 'http://127.0.0.1:7890'
)

$ErrorActionPreference = 'Stop'
$env:HTTPS_PROXY = $ProxyUrl
$env:HTTP_PROXY = $ProxyUrl
$env:NO_PROXY = 'localhost,127.0.0.1,::1'

# godot is a full engine fork; CI only needs the pinned commit, so a shallow
# mirror keeps the fetch small. The others are small enough to mirror fully.
$mirrors = @(
  @{ Name = 'Veya.git'; Url = 'https://github.com/zzmelody/Veya.git'; Shallow = $false },
  @{ Name = 'aura.git'; Url = 'https://github.com/zzmelody/aura.git'; Shallow = $false },
  @{ Name = 'godot.git'; Url = 'https://github.com/zzmelody/godot.git'; Shallow = $true },
  @{ Name = 'godot-cpp.git'; Url = 'https://github.com/godotengine/godot-cpp.git'; Shallow = $false },
  @{ Name = 'flecs.git'; Url = 'https://github.com/SanderMertens/flecs.git'; Shallow = $false },
  @{ Name = 'luau.git'; Url = 'https://github.com/luau-lang/luau.git'; Shallow = $false },
  @{ Name = 'gns.git'; Url = 'https://github.com/ValveSoftware/GameNetworkingSockets.git'; Shallow = $false }
)

New-Item -ItemType Directory -Force -Path $MirrorRoot | Out-Null
foreach ($mirror in $mirrors) {
  $path = Join-Path $MirrorRoot $mirror.Name
  if (-not (Test-Path -LiteralPath (Join-Path $path 'HEAD'))) {
    if ($mirror.Shallow) {
      & git clone --mirror --depth 1 $mirror.Url $path
    } else {
      & git clone --mirror $mirror.Url $path
    }
  } else {
    & git -C $path fetch --prune
  }
  if ($LASTEXITCODE -ne 0) { throw "Mirror update failed: $($mirror.Name)" }
}
