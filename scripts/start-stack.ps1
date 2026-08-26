# Starts the Teams-monitor stack: GUI server, orchestrator, Cloudflare tunnel.
# Safe to re-run — each component starts only if it isn't already running.
# Logs land in data\.

$root = "C:\Users\GuyMichaely\projects\teams-monitor"
$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"

function Test-Port($port) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect("127.0.0.1", $port)
    $c.Close()
    return $true
  } catch { return $false }
}

# GUI server (port 8090). Node loads GUI_TOKEN/GEMINI_API_KEY from .env.
if (-not (Test-Port 8090)) {
  Start-Process node -ArgumentList '--env-file=.env src/cli.mjs gui' -WorkingDirectory $root -WindowStyle Hidden `
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
  Start-Process node -ArgumentList '--env-file=.env src/cli.mjs run' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardError "$root\data\orchestrator.log" -RedirectStandardOutput "$root\data\orchestrator.out.log"
}

# Cloudflare tunnel (gui.guymichaely.com -> 127.0.0.1:8090).
# Match this tunnel specifically so another cloudflared process does not block it.
$tunnelRunning = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue | `
  Where-Object { $_.CommandLine -match '(?i)tunnel\s+run' -and $_.CommandLine -match '(?i)teams-gui' }
if (-not $tunnelRunning) {
  Start-Process $cloudflared -ArgumentList 'tunnel run teams-gui' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardError "$root\data\tunnel.log" -RedirectStandardOutput "$root\data\tunnel.out.log"
}
