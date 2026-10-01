[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ProductionRoot,
    [string]$DesktopDirectory = [Environment]::GetFolderPath('Desktop')
)
$ErrorActionPreference = 'Stop'
$agenticRoot = Split-Path $PSScriptRoot -Parent
$prodRoot = (Resolve-Path -LiteralPath $ProductionRoot).Path
if ($prodRoot -eq $agenticRoot) { throw 'Production and agentic must be separate folders.' }
if (-not (Test-Path -LiteralPath $DesktopDirectory -PathType Container)) { throw 'Desktop folder is unavailable.' }
$shell = New-Object -ComObject WScript.Shell
$separator = [char]0x2014
$entries = @(
    @{ Name="TM $separator Prod"; Root=$prodRoot; Arguments='' },
    @{ Name="TM $separator Agentic"; Root=$agenticRoot; Arguments='--agentic' }
)
# Validate all targets before writing either shortcut. No launch or ownership changes.
foreach ($entry in $entries) {
    $target = Join-Path $entry.Root 'data\desktop\TM.exe'
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'Build/install each checkout before creating shortcuts.' }
    $path = Join-Path $DesktopDirectory ($entry.Name + '.lnk')
    if (Test-Path -LiteralPath $path) {
        $existing = $shell.CreateShortcut($path)
        if ($existing.TargetPath -ne $target) { throw 'A named shortcut belongs to another installation; it was not overwritten.' }
    }
}
foreach ($entry in $entries) {
    $path = Join-Path $DesktopDirectory ($entry.Name + '.lnk')
    $target = Join-Path $entry.Root 'data\desktop\TM.exe'
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = $target
    $shortcut.WorkingDirectory = $entry.Root
    $shortcut.Arguments = $entry.Arguments
    $shortcut.Description = 'Quit the active TM tray before launching the other version.'
    $shortcut.IconLocation = "$target,0"
    $shortcut.Save()
    Write-Output "Installed: $path"
}
