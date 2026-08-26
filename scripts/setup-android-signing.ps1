# One-time setup for GitHub-hosted Android debug builds.
# Uploads this PC's existing Android debug keystore as an Actions secret so CI
# produces APKs signed exactly like local `assembleDebug` builds.

$ErrorActionPreference = "Stop"
$repo = "GuyMichaely/teams-monitor"
$debugKeystore = Join-Path $HOME ".android\debug.keystore"

$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) {
  throw "GitHub CLI (gh) is required. Install it, run 'gh auth login', then re-run this script."
}
& $gh.Source auth status | Out-Null
if ($LASTEXITCODE -ne 0) { throw "GitHub CLI is not authenticated. Run 'gh auth login' first." }

if (-not (Test-Path $debugKeystore)) {
  throw "Android debug keystore not found at $debugKeystore. Run 'cd android-app; .\gradlew.bat assembleDebug' once, then re-run this script."
}

$keystoreBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($debugKeystore))
$keystoreBase64 | & $gh.Source secret set ANDROID_DEBUG_KEYSTORE_BASE64 --repo $repo
if ($LASTEXITCODE -ne 0) { throw "Failed to set ANDROID_DEBUG_KEYSTORE_BASE64." }

Write-Host "Uploaded your existing Android debug keystore to GitHub Actions."
Write-Host "Source key: $debugKeystore"
Write-Host "Back up that file; future APK updates must keep using the same signing key."

& $gh.Source workflow run android-apk.yml --repo $repo
if ($LASTEXITCODE -ne 0) { throw "Signing is configured, but triggering android-apk.yml failed." }
Write-Host "Triggered the Android APK workflow. The resulting APK will appear in the android-latest GitHub Release."
