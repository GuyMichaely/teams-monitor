# Control the installed tray, not its child PIDs. New trays launch through the
# existing Explorer desktop so closing Codex cannot own their lifetime.
[CmdletBinding()]
param(
    [Parameter(Position=0)][ValidateSet('start','stop','restart','status','quit')][string]$Action = 'start',
    [switch]$Agentic,
    [ValidateRange(1,300)][int]$TimeoutSeconds = 180
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$hash = [Security.Cryptography.SHA256]::Create()
try { $rootHash = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))).Replace('-','').Substring(0,24) }
finally { $hash.Dispose() }
$instanceName = "Local\TeamsMonitorTray_$rootHash"
$sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
$pipeName = "TeamsMonitorTray_${rootHash}_${sessionId}_control"

function Connect-Tray([int]$WaitMs) {
    $client = [IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
    try { $client.Connect($WaitMs); return $client }
    catch [TimeoutException] { $client.Dispose(); return $null }
    catch { $client.Dispose(); throw }
}

$pipe = Connect-Tray 500
if (-not $pipe) {
    $existingMutex = $null
    $trayExists = [Threading.Mutex]::TryOpenExisting($instanceName, [ref]$existingMutex)
    if ($existingMutex) { $existingMutex.Dispose() }
    if ($trayExists) {
        # A just-launched tray may not have opened its IPC yet. Never launch an
        # unowned replacement or silently report success for an older build.
        $pipe = Connect-Tray 5000
        if (-not $pipe) { throw 'The tray is running but local control is unavailable. Quit it and rebuild with bun run desktop:install.' }
    } elseif ($Action -in @('start','restart')) {
        & (Join-Path $PSScriptRoot 'start-desktop.ps1') -Agentic:$Agentic
        $pipe = Connect-Tray 15000
        if (-not $pipe) { throw 'The tray did not open local control. Check data/desktop/tray.log.' }
    } else {
        [ordered]@{ ok=$true; state='not_running'; status='Tray is not running.'; trayPid=$null; supervisorPid=$null } | ConvertTo-Json -Compress
        exit 0
    }
}

try {
    $command = [Text.Encoding]::ASCII.GetBytes($Action + "`n")
    $pipe.Write($command,0,$command.Length)
    $reader = [IO.StreamReader]::new($pipe, [Text.Encoding]::UTF8, $false, 4096, $true)
    try {
        $reply = $reader.ReadLineAsync()
        if (-not $reply.Wait($TimeoutSeconds * 1000)) { throw 'Tray command timed out. Check system:status before retrying; the operation may still be running.' }
        if (-not $reply.Result -or $reply.Result.Length -gt 65536) { throw 'Invalid tray response.' }
        $result = $reply.Result | ConvertFrom-Json
        if ($Action -eq 'quit' -and $result.ok) {
            $trayProcess = Get-Process -Id $result.trayPid -ErrorAction SilentlyContinue
            if ($trayProcess) {
                if ($trayProcess.Path -ne (Join-Path $projectRoot 'data\desktop\TM.exe')) { throw 'Tray identity changed while waiting for quit.' }
                if (-not $trayProcess.WaitForExit(15000)) { throw 'The tray has not exited yet. Check system:status and data/desktop/tray.log.' }
                $trayProcess.Dispose()
            }
            $result.state = 'not_running'; $result.status = 'Tray exited.'
        }
        $result | ConvertTo-Json -Compress
        if (-not $result.ok) { exit 1 }
    } finally { $reader.Dispose() }
} finally { $pipe.Dispose() }
