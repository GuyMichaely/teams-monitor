# Ask the existing desktop Explorer to launch the app in its own context.
# A newly-created Shell.Application or explorer.exe can still inherit the tool's context.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$desktopExe = Join-Path $projectRoot 'data\desktop\TeamsMonitor.exe'
if (-not (Test-Path -LiteralPath $desktopExe)) { throw 'Run scripts/install-desktop.ps1 first.' }
$shellWindows = (New-Object -ComObject Shell.Application).Windows()
$desktopLocation = 0
$desktopRoot = $null
$desktopHwnd = 0
$desktopBrowser = $shellWindows.FindWindowSW([ref]$desktopLocation, [ref]$desktopRoot, 8, [ref]$desktopHwnd, 1)
if (-not $desktopBrowser) { throw 'Windows Explorer desktop is unavailable. Start Teams Monitor from the desktop shortcut.' }
$desktopBrowser.Document.Application.ShellExecute($desktopExe, '', $projectRoot, 'open', 1)
