param([string]$Apk = "$PSScriptRoot\..\output\android\aura-preview.apk")
$ErrorActionPreference = 'Stop'
$auraApkPath = (Resolve-Path -LiteralPath $Apk).Path
Add-Type -AssemblyName System.IO.Compression.FileSystem
$auraArchive = [System.IO.Compression.ZipFile]::OpenRead($auraApkPath)
try {
    $auraBundle = $auraArchive.GetEntry('assets/index.android.bundle')
    if (!$auraBundle -or $auraBundle.Length -lt 100000) { throw 'Missing embedded application bundle.' }
    if (!$auraArchive.GetEntry('classes.dex')) { throw 'Missing Android executable classes.' }
    $auraFonts = @($auraArchive.Entries | Where-Object { $_.FullName -match '\.ttf$' })
    if ($auraFonts.Count -lt 4) { throw 'Missing embedded fonts.' }
    Write-Output "PASS: application code and $($auraFonts.Count) local fonts are embedded."
} finally { $auraArchive.Dispose() }
if ($env:ANDROID_HOME -and $env:JAVA_HOME) {
    $auraBuildTools = Join-Path $env:ANDROID_HOME 'build-tools\36.0.0'
    & "$auraBuildTools\apksigner.bat" verify $auraApkPath
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    $auraPermissions = & "$auraBuildTools\aapt.exe" dump permissions $auraApkPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect APK permissions.' }
    if ($auraPermissions -match 'READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|SYSTEM_ALERT_WINDOW|VIBRATE') { throw 'Unused Android permissions are present.' }
    Write-Output 'PASS: APK signature and permission checks.'
} else {
    Write-Output 'Set ANDROID_HOME and JAVA_HOME to verify signature and permissions.'
}
Get-FileHash -LiteralPath $auraApkPath -Algorithm SHA256 | Format-List
