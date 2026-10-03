[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'data\agent\sandbox' }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler is unavailable.' }
$exePath = Join-Path $OutputDirectory 'TM-sandbox.exe'
& $compiler /nologo /target:exe /optimize+ /platform:x64 /reference:System.Web.Extensions.dll "/out:$exePath" (Join-Path $PSScriptRoot 'windows\BunSandbox.cs')
if ($LASTEXITCODE -ne 0) { throw 'Sandbox helper compilation failed.' }
$hasher = [Security.Cryptography.SHA256]::Create()
$sourceStream = [IO.File]::OpenRead((Join-Path $PSScriptRoot 'windows\BunSandbox.cs'))
try { $hash = [BitConverter]::ToString($hasher.ComputeHash($sourceStream)).Replace('-', '').ToLowerInvariant() }
finally { $sourceStream.Dispose(); $hasher.Dispose() }
[IO.File]::WriteAllText($exePath + '.sha256', $hash)
Write-Output "Sandbox helper: $exePath"
