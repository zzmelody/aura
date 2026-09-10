param([string]$Apk = "$PSScriptRoot\..\output\android\aura-preview.apk")
$ErrorActionPreference = 'Stop'
$auraApkPath = (Resolve-Path -LiteralPath $Apk).Path
Add-Type -AssemblyName System.IO.Compression.FileSystem
$auraArchive = [System.IO.Compression.ZipFile]::OpenRead($auraApkPath)
try {
    if (!$auraArchive.GetEntry('assets/public/index.html')) { throw 'Missing Capacitor Web entrypoint.' }
    $auraScripts = @($auraArchive.Entries | Where-Object { $_.FullName -match '^assets/public/assets/.+\.js$' })
    if ($auraScripts.Count -lt 1) { throw 'Missing bundled React application code.' }
    if (!$auraArchive.GetEntry('classes.dex')) { throw 'Missing Android executable classes.' }
    $auraFonts = @($auraArchive.Entries | Where-Object { $_.FullName -match '^assets/public/assets/.+\.woff2$' })
    if ($auraFonts.Count -lt 4) { throw 'Missing embedded Web fonts.' }
    Write-Output "PASS: Capacitor Web assets, application code and $($auraFonts.Count) local fonts are embedded."
} finally { $auraArchive.Dispose() }

if ($env:ANDROID_HOME -and $env:JAVA_HOME) {
    $auraBuildTools = Get-ChildItem -LiteralPath (Join-Path $env:ANDROID_HOME 'build-tools') -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if (!$auraBuildTools) { throw 'Android build-tools are missing.' }
    & (Join-Path $auraBuildTools.FullName 'apksigner.bat') verify $auraApkPath
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    $auraPermissions = & (Join-Path $auraBuildTools.FullName 'aapt.exe') dump permissions $auraApkPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect APK permissions.' }
    if ($auraPermissions -match 'READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|SYSTEM_ALERT_WINDOW|VIBRATE') {
        throw 'Unused Android permissions are present.'
    }
    Write-Output 'PASS: APK signature and permission checks.'
} else {
    Write-Output 'Set ANDROID_HOME and JAVA_HOME to verify signature and permissions.'
}
Get-FileHash -LiteralPath $auraApkPath -Algorithm SHA256 | Format-List
