# One-time setup for reproducible GitHub-hosted Android builds.
# Reuses this PC's Android debug key when available so the first CI APK can
# update an app previously installed from a local debug build. Otherwise it
# creates a dedicated signing key. All signing material stays outside the repo.

$ErrorActionPreference = "Stop"
$repo = "GuyMichaely/teams-monitor"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backupDir = Join-Path $HOME ".teams-monitor"
$keystore = Join-Path $backupDir "android-release.jks"
$passwordFile = Join-Path $backupDir "android-release-password.txt"
$aliasFile = Join-Path $backupDir "android-release-alias.txt"
$debugKeystore = Join-Path $HOME ".android\debug.keystore"

$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) {
  throw "GitHub CLI (gh) is required. Install it, run 'gh auth login', then re-run this script."
}
& $gh.Source auth status | Out-Null
if ($LASTEXITCODE -ne 0) { throw "GitHub CLI is not authenticated. Run 'gh auth login' first." }

$keytool = Get-Command keytool -ErrorAction SilentlyContinue
if ($keytool) {
  $keytoolExe = $keytool.Source
} else {
  $portableKeytool = Join-Path $root "tools\jdk17\bin\keytool.exe"
  if (-not (Test-Path $portableKeytool)) {
    throw "keytool was not found. Install/use JDK 17, or restore tools\jdk17 on this machine."
  }
  $keytoolExe = $portableKeytool
}

New-Item -ItemType Directory -Force $backupDir | Out-Null

if (Test-Path $keystore) {
  if (-not (Test-Path $passwordFile) -or -not (Test-Path $aliasFile)) {
    throw "Signing keystore exists at $keystore but its password/alias metadata is missing. Refusing to replace the key."
  }
  $password = (Get-Content $passwordFile -Raw).Trim()
  $alias = (Get-Content $aliasFile -Raw).Trim()
  Write-Host "Using existing signing-key backup: $keystore"
} elseif (Test-Path $debugKeystore) {
  # Gradle debug builds normally use this per-PC key. Reusing it preserves the
  # signature of an APK already sideloaded from this machine.
  & $keytoolExe -list -keystore $debugKeystore -storepass android -alias androiddebugkey | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Found $debugKeystore, but it is not the standard Android debug keystore. Refusing to guess its credentials."
  }
  Copy-Item $debugKeystore $keystore
  $password = "android"
  $alias = "androiddebugkey"
  Set-Content -NoNewline $passwordFile $password
  Set-Content -NoNewline $aliasFile $alias
  Write-Host "Reused this PC's Android debug signing key so CI builds can update the current sideloaded app."
} else {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $password = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $alias = "teamsmonitor"

  & $keytoolExe -genkeypair -v `
    -keystore $keystore `
    -storetype JKS `
    -storepass $password `
    -keypass $password `
    -alias $alias `
    -keyalg RSA `
    -keysize 2048 `
    -validity 10000 `
    -dname "CN=Teams Monitor, OU=Personal, O=GuyMichaely, C=US"
  if ($LASTEXITCODE -ne 0) { throw "keytool failed to create the Android signing key." }

  Set-Content -NoNewline $passwordFile $password
  Set-Content -NoNewline $aliasFile $alias
  Write-Warning "No existing Android debug keystore was found. A new signing key was created; if the installed app was signed by another key, uninstall it once before installing the first GitHub Release APK."
}

try {
  icacls $backupDir /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" | Out-Null
} catch {
  Write-Warning "Could not tighten ACLs on $backupDir; protect the signing-key backup manually."
}

$keystoreBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($keystore))
$keystoreBase64 | & $gh.Source secret set ANDROID_KEYSTORE_BASE64 --repo $repo
if ($LASTEXITCODE -ne 0) { throw "Failed to set ANDROID_KEYSTORE_BASE64." }
$password | & $gh.Source secret set ANDROID_KEYSTORE_PASSWORD --repo $repo
if ($LASTEXITCODE -ne 0) { throw "Failed to set ANDROID_KEYSTORE_PASSWORD." }
$alias | & $gh.Source secret set ANDROID_KEY_ALIAS --repo $repo
if ($LASTEXITCODE -ne 0) { throw "Failed to set ANDROID_KEY_ALIAS." }

Write-Host "GitHub Actions signing secrets configured."
Write-Host "Keep $backupDir safe; losing the signing key prevents future APKs from updating the installed app."

& $gh.Source workflow run android-apk.yml --repo $repo
if ($LASTEXITCODE -ne 0) { throw "Signing is configured, but triggering android-apk.yml failed." }
Write-Host "Triggered the Android APK workflow. The resulting APK will appear in the android-latest GitHub Release."
