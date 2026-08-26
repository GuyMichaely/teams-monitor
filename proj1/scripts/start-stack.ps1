# Starts the Teams-monitor stack: GUI server, orchestrator, Cloudflare tunnel.
# Safe to re-run — each component starts only if it isn't already running.
# Logs land in data\. Scheduled to run at logon (Task Scheduler: TeamsMonitorStack).

$root = "C:\Users\GuyMichaely\projects\proj1"
$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"

# Secrets live in the per-user env store; make sure child processes inherit them
# even when this script runs from a shell started before they were set.
if (-not $env:GUI_TOKEN) {
  $env:GUI_TOKEN = [Environment]::GetEnvironmentVariable("GUI_TOKEN", "User")
}
if (-not $env:GEMINI_API_KEY) {
  $env:GEMINI_API_KEY = [Environment]::GetEnvironmentVariable("GEMINI_API_KEY", "User")
}

function Test-Port($port) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect("127.0.0.1", $port)
    $c.Close()
    return $true
  } catch { return $false }
}

# GUI server (port 8090)
if (-not (Test-Port 8090)) {
  Start-Process node -ArgumentList 'src/cli.mjs gui' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardError "$root\data\gui.log" -RedirectStandardOutput "$root\data\gui.out.log"
}

# Orchestrator (fresh heartbeat = alive; hard-stop kills the pid and removes it)
$hb = "$root\data\heartbeat.json"
$orchRunning = $false
if (Test-Path $hb) {
  try {
    $j = Get-Content $hb -Raw | ConvertFrom-Json
    if ((New-TimeSpan -Start ([DateTime]$j.at) -End (Get-Date)).TotalSeconds -lt 60) { $orchRunning = $true }
  } catch {}
}
if (-not $orchRunning) {
  Start-Process node -ArgumentList 'src/cli.mjs run' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardError "$root\data\orchestrator.log" -RedirectStandardOutput "$root\data\orchestrator.out.log"
}

# Cloudflare tunnel (gui.guymichaely.com -> 127.0.0.1:8090)
if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
  Start-Process $cloudflared -ArgumentList 'tunnel run teams-gui' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardError "$root\data\tunnel.log" -RedirectStandardOutput "$root\data\tunnel.out.log"
}
