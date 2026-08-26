# One-time setup for reproducible GitHub-hosted Android builds.
# Creates a signing key OUTSIDE the repo, stores the key/password as Actions
# secrets, then triggers the Android APK workflow.

$ErrorActionPreference = "Stop"
$repo = "GuyMichaely/teams-monitor"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backupDir = Join-Path $HOME ".teams-monitor"
$keystore = Join-Path $backupDir "android-release.jks"
$passwordFile = Join-Path $backupDir "android-release-password.txt"
$alias = "teamsmonitor"

$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) {
  throw "GitHub CLI (gh) is required. Install it, run 'gh auth login', then re-run this script."
}
& $gh.Source auth status | Out-Null

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
  if (-not (Test-Path $passwordFile)) {
    throw "Signing keystore already exists at $keystore but its password backup is missing. Refusing to replace the key."
  }
  $password = (Get-Content $passwordFile -Raw).Trim()
  Write-Host "Using existing signing key: $keystore"
} else {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $password = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

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

  Set-Content -NoNewline $passwordFile $password
  try {
    icacls $backupDir /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F" | Out-Null
  } catch {
    Write-Warning "Could not tighten ACLs on $backupDir; protect the signing-key backup manually."
  }
  Write-Host "Created signing-key backup: $keystore"
  Write-Host "Created password backup:    $passwordFile"
}

$keystoreBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($keystore))
$keystoreBase64 | & $gh.Source secret set ANDROID_KEYSTORE_BASE64 --repo $repo
$password | & $gh.Source secret set ANDROID_KEYSTORE_PASSWORD --repo $repo

Write-Host "GitHub Actions signing secrets configured."
Write-Host "Keep $backupDir safe; losing the signing key prevents future APKs from updating the installed app."

& $gh.Source workflow run android-apk.yml --repo $repo
Write-Host "Triggered the Android APK workflow. The resulting APK will appear in the android-latest GitHub Release."
