# Compatibility entrypoint: the desktop tray now owns the entire stack.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'data\desktop\TM.exe'))) {
    & (Join-Path $PSScriptRoot 'install-desktop.ps1')
}
& (Join-Path $PSScriptRoot 'start-desktop.ps1')
