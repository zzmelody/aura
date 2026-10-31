param([switch]$SkipPrebuild)
. "$PSScriptRoot\env.ps1"

if (!$env:JAVA_HOME) {
    $auraJdk = Get-ChildItem -LiteralPath "$auraRoot\.tools\jdk21" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($auraJdk) { $env:JAVA_HOME = $auraJdk.FullName }
}
if (!$env:JAVA_HOME -or !(Test-Path -LiteralPath "$env:JAVA_HOME\bin\java.exe")) {
    throw 'Set JAVA_HOME to a JDK 21 installation.'
}
if (!$env:ANDROID_HOME) {
    if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_HOME = $env:ANDROID_SDK_ROOT }
    elseif (Test-Path -LiteralPath "$env:LOCALAPPDATA\Android\Sdk") { $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk" }
    elseif (Test-Path -LiteralPath 'C:\SDK\AndroidSDK') { $env:ANDROID_HOME = 'C:\SDK\AndroidSDK' }
}
if (!$env:ANDROID_HOME) { throw 'Set ANDROID_HOME to an Android SDK installation.' }

$env:Path = "$env:JAVA_HOME\bin;" + $env:Path
$env:CI = '1'
$env:NODE_ENV = 'production'
$env:GRADLE_USER_HOME = "$auraRoot\.tools\gradle"
Set-Location -LiteralPath "$auraRoot\apps\mobile"

& $auraPnpmCommand @auraPnpmArguments run build
if ($LASTEXITCODE -ne 0) { throw 'Aura mobile Web build failed.' }

if (!$SkipPrebuild) {
    if (!(Test-Path -LiteralPath '.\android')) {
        & $auraPnpmCommand @auraPnpmArguments exec cap add android
        if ($LASTEXITCODE -ne 0) { throw 'Capacitor Android project creation failed.' }
    }
    & $auraPnpmCommand @auraPnpmArguments exec cap sync android
    if ($LASTEXITCODE -ne 0) { throw 'Capacitor Android sync failed.' }
}

if (!(Test-Path -LiteralPath '.\android\gradlew.bat')) {
    throw 'Capacitor Android project is missing. Run without -SkipPrebuild once.'
}
Set-Location -LiteralPath '.\android'
& .\gradlew.bat :app:assembleDebug --no-daemon --console=plain --max-workers=4
if ($LASTEXITCODE -ne 0) { throw 'Android packaging failed.' }

$auraOutput = "$auraRoot\apps\mobile\dist-android"
New-Item -ItemType Directory -Path $auraOutput -Force | Out-Null
Copy-Item -LiteralPath '.\app\build\outputs\apk\debug\app-debug.apk' -Destination "$auraOutput\aura-preview.apk"
& "$PSScriptRoot\verify-android.ps1" -Apk "$auraOutput\aura-preview.apk"
Write-Output 'Preview APK uses the generated Android debug key. Production store signing is separate.'
