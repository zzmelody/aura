$ErrorActionPreference = 'Stop'
$auraRoot = Split-Path -Parent $PSScriptRoot
$auraNode = (Get-Command node -ErrorAction SilentlyContinue).Source
$auraBundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (!$auraNode -or [int]((& $auraNode -p 'process.versions.node.split(".")[0]')) -lt 24) {
    if (Test-Path -LiteralPath $auraBundledNode) { $auraNode = $auraBundledNode }
    else { throw 'Aura requires Node.js 24 or newer. Install it and reopen your terminal.' }
}
$env:Path = (Split-Path -Parent $auraNode) + ';' + $env:Path
$auraPnpm = Join-Path $auraRoot '.tools\pnpm\node_modules\pnpm\bin\pnpm.cjs'
if (!(Test-Path -LiteralPath $auraPnpm)) {
    throw 'pnpm 10 is not installed. Run: npm install --prefix .tools/pnpm pnpm@10.17.1'
}
$env:Path = (Join-Path $auraRoot '.tools\pnpm\node_modules\.bin') + ';' + $env:Path
