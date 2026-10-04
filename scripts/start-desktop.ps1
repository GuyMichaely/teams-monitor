# Ask the existing desktop Explorer to launch the app in its own context.
# A newly-created Shell.Application or explorer.exe can still inherit the tool's context.
[CmdletBinding()]
param([switch]$Agentic)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$desktopExe = Join-Path $projectRoot 'data\desktop\TM.exe'
if (-not (Test-Path -LiteralPath $desktopExe)) { throw 'Run scripts/install-desktop.ps1 first.' }
$shellWindows = (New-Object -ComObject Shell.Application).Windows()
$desktopLocation = 0
$desktopRoot = $null
$desktopHwnd = 0
$desktopBrowser = $shellWindows.FindWindowSW([ref]$desktopLocation, [ref]$desktopRoot, 8, [ref]$desktopHwnd, 1)
if (-not $desktopBrowser) { throw 'Windows Explorer desktop is unavailable. Start TM from the desktop shortcut.' }
$launchArguments = if ($Agentic) { '--agentic' } else { '' }
$desktopBrowser.Document.Application.ShellExecute($desktopExe, $launchArguments, $projectRoot, 'open', 0)
