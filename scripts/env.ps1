$ErrorActionPreference = 'Stop'
$auraRoot = Split-Path -Parent $PSScriptRoot
$auraNode = (Get-Command node -ErrorAction SilentlyContinue).Source
$auraBundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (!$auraNode -or [int]((& $auraNode -p 'process.versions.node.split(".")[0]')) -lt 24) {
    if (Test-Path -LiteralPath $auraBundledNode) { $auraNode = $auraBundledNode }
    else { throw 'Aura requires Node.js 24 or newer. Install it and reopen your terminal.' }
}
$env:Path = (Split-Path -Parent $auraNode) + ';' + $env:Path
$auraPackageManager = (Get-Content -LiteralPath (Join-Path $auraRoot 'package.json') -Raw | ConvertFrom-Json).packageManager
$auraPnpmPackage = Join-Path $auraRoot '.tools\pnpm\node_modules\pnpm'
$auraPnpmManifest = Join-Path $auraPnpmPackage 'package.json'
if (!(Test-Path -LiteralPath $auraPnpmManifest) -or
    (Get-Content -LiteralPath $auraPnpmManifest -Raw | ConvertFrom-Json).version -ne ($auraPackageManager -replace '^pnpm@', '')) {
    throw "Install the repository's package manager: npm install --prefix .tools/pnpm $auraPackageManager"
}
$auraPnpmCommand = Join-Path $auraPnpmPackage 'pnpm.exe'
$auraPnpmArguments = @()
if (!(Test-Path -LiteralPath $auraPnpmCommand)) {
    $auraPnpmCommand = $auraNode
    $auraPnpmArguments = @(Join-Path $auraPnpmPackage 'bin\pnpm.cjs')
}
$env:Path = (Join-Path $auraRoot '.tools\pnpm\node_modules\.bin') + ';' + $env:Path
