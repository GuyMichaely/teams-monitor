# Build a native Windows tray app and create a per-user desktop shortcut. No autostart.
[CmdletBinding()]
param([switch]$BuildOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$desktopBin = Join-Path $projectRoot 'data\desktop'
New-Item -ItemType Directory -Force -Path $desktopBin | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler is unavailable.' }
$exePath = Join-Path $desktopBin 'TM.exe'
$previousExePath = Join-Path $desktopBin 'TeamsMonitor.exe'
if (Get-Process -Name TM,TeamsMonitor -ErrorAction SilentlyContinue | Where-Object { $_.Path -in @($exePath, $previousExePath) }) { throw 'Quit TM from its tray icon before rebuilding.' }
Add-Type -AssemblyName System.Drawing
$iconPath = Join-Path $desktopBin 'TM.ico'
$bitmap = New-Object System.Drawing.Bitmap 32,32
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$font = New-Object System.Drawing.Font 'Segoe UI',20,([System.Drawing.FontStyle]::Bold)
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(36,90,120))
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.FillEllipse($brush,0,0,31,31)
$graphics.DrawString('T',$font,[System.Drawing.Brushes]::White,4,-2)
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$iconFile = [IO.File]::Create($iconPath)
try { $icon.Save($iconFile) } finally { $iconFile.Dispose(); $icon.Dispose(); $graphics.Dispose(); $font.Dispose(); $brush.Dispose(); $bitmap.Dispose() }
& $compiler /nologo /target:winexe /optimize+ /platform:x64 "/out:$exePath" "/win32icon:$iconPath" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'windows\TeamsMonitorTray.cs')
if ($LASTEXITCODE -ne 0) { throw 'Tray app compilation failed.' }
$signalPath = Join-Path $desktopBin 'TM-signal.exe'
& $compiler /nologo /target:winexe /optimize+ /platform:x64 /define:AWAKE_SIGNAL_ONLY "/out:$signalPath" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'windows\TeamsMonitorTray.cs')
if ($LASTEXITCODE -ne 0) { throw 'Tray signal helper compilation failed.' }
if (-not $BuildOnly) {
    $desktopFolder = [Environment]::GetFolderPath('Desktop')
    $shortcutPath = Join-Path $desktopFolder 'TM.lnk'
    $previousShortcutPath = Join-Path $desktopFolder 'Teams Monitor.lnk'
    $shortcutShell = New-Object -ComObject WScript.Shell
    if (Test-Path -LiteralPath $shortcutPath) {
        $existingShortcut = $shortcutShell.CreateShortcut($shortcutPath)
        if ($existingShortcut.TargetPath -notin @($exePath, $previousExePath)) { throw 'A different TM desktop shortcut already exists; it was not overwritten.' }
    }
    $shortcut = $shortcutShell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $exePath
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.Description = 'Start TM; closing the status window hides to tray. Quit using the tray icon.'
    $shortcut.IconLocation = "$exePath,0"
    $shortcut.Save()
    # Only replace the previous shortcut when it belongs to this checkout.
    if (Test-Path -LiteralPath $previousShortcutPath) {
        $previousShortcut = $shortcutShell.CreateShortcut($previousShortcutPath)
        if ($previousShortcut.TargetPath -in @($exePath, $previousExePath)) {
            Remove-Item -LiteralPath $previousShortcutPath
        }
    }
    Write-Output "Installed: $shortcutPath"
}
Write-Output "Tray app: $exePath"
