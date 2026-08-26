# Launch the new Teams client with a CDP remote-debugging port exposed,
# scoping the env var to THIS process only (does not affect other WebView2 apps).
# Uses the app execution alias — C:\Program Files\WindowsApps is not enumerable.
#
# Usage:  ./scripts/launch-teams.ps1 [-Port 9222]
#
# Note: if Teams is already running it must be fully quit first (tray icon -> Quit),
# otherwise the new process just hands off to the existing one without the flag.

param(
    [int]$Port = 9222
)

$teamsExe = "$env:LOCALAPPDATA\Microsoft\WindowsApps\ms-teams.exe"

if (-not (Test-Path $teamsExe)) {
    Write-Error "Could not find the Teams app execution alias at $teamsExe. Is the new Teams installed?"
    exit 1
}

# Is Teams already running? Warn, since the flag won't take effect.
if (Get-Process -Name "ms-teams" -ErrorAction SilentlyContinue) {
    Write-Warning "Teams is already running. Quit it fully (tray -> Quit) and re-run, or the debug port won't open."
}

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
Start-Process $teamsExe
Write-Host "Launched Teams with --remote-debugging-port=$Port"
Write-Host "Verify:  Invoke-RestMethod http://localhost:$Port/json/version"
