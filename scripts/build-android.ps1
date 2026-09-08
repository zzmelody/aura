param([string]$Architectures = 'arm64-v8a,x86_64', [switch]$SkipPrebuild)
. "$PSScriptRoot\env.ps1"
if ($Architectures -notmatch '^(arm64-v8a|x86_64)(,(arm64-v8a|x86_64))*$') { throw 'Architectures must be arm64-v8a and/or x86_64.' }
if (!$env:JAVA_HOME) {
    $jdk = Get-ChildItem -LiteralPath "$auraRoot\.tools\jdk21" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($jdk) { $env:JAVA_HOME = $jdk.FullName }
}
if (!$env:JAVA_HOME -or !(Test-Path -LiteralPath "$env:JAVA_HOME\bin\java.exe")) { throw 'Set JAVA_HOME to a JDK 21 installation.' }
if (!$env:ANDROID_HOME) {
    if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_HOME = $env:ANDROID_SDK_ROOT }
    elseif (Test-Path -LiteralPath "$env:LOCALAPPDATA\Android\Sdk") { $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk" }
    elseif (Test-Path -LiteralPath 'C:\SDK\AndroidSDK') { $env:ANDROID_HOME = 'C:\SDK\AndroidSDK' }
}
if (!$env:ANDROID_HOME) { throw 'Set ANDROID_HOME to an Android SDK installation.' }
$env:Path = "$env:JAVA_HOME\bin;" + $env:Path
$env:CI = '1'
$env:NODE_ENV = 'production'
$env:AURA_PREVIEW_HTTP = '1'
$env:GRADLE_USER_HOME = "$auraRoot\.tools\gradle"
$auraJdk17 = Get-ChildItem -LiteralPath "$auraRoot\.tools\jdk17" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
if ($auraJdk17) { $env:AURA_JDK17 = $auraJdk17.FullName }
Set-Location -LiteralPath "$auraRoot\packages\frontend\mobile"
if (!$SkipPrebuild) {
    & $auraNode "$auraRoot\node_modules\expo\bin\cli" prebuild --platform android --no-install
    if ($LASTEXITCODE -ne 0) { throw 'Expo prebuild failed.' }
}
Set-Location -LiteralPath "$auraRoot\packages\frontend\mobile\android"
& .\gradlew.bat :app:assembleRelease "-PreactNativeArchitectures=$Architectures" '-Porg.gradle.java.installations.fromEnv=AURA_JDK17,JAVA_HOME' '-Djava.net.preferIPv4Stack=true' --no-daemon --console=plain --max-workers=4
if ($LASTEXITCODE -ne 0) { throw 'Android packaging failed.' }
$auraOutput = "$auraRoot\output\android"
New-Item -ItemType Directory -Path $auraOutput -Force | Out-Null
Copy-Item -LiteralPath '.\app\build\outputs\apk\release\app-release.apk' -Destination "$auraOutput\aura-preview.apk"
& "$PSScriptRoot\verify-android.ps1" -Apk "$auraOutput\aura-preview.apk"
Write-Output 'Preview APK uses the generated development signing key. Production store signing is separate.'
