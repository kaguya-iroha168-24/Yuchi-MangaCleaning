param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$cache = Join-Path $workspace '.cache'
$temp = Join-Path $cache 'tmp'

New-Item -ItemType Directory -Force -Path $cache, $temp | Out-Null
Set-Location -LiteralPath $workspace

$python = Join-Path $workspace '.venv-standalone\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Python environment missing. See README.md.' }
if (-not (Test-Path -LiteralPath (Join-Path $workspace 'node_modules'))) { throw 'Frontend dependencies missing. See README.md.' }

$portState = Join-Path $cache 'dev-port.json'
$previousPort = 0
if (Test-Path -LiteralPath $portState) {
    try { $previousPort = [int]((Get-Content -LiteralPath $portState -Raw | ConvertFrom-Json).port) } catch { $previousPort = 0 }
}
if ($previousPort -lt 1024 -or $previousPort -gt 65535) { $previousPort = 0 }
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $previousPort)
try { $listener.Start() } catch {
    $listener.Stop()
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
}
$port = $listener.LocalEndpoint.Port
$listener.Stop()
[System.IO.File]::WriteAllText($portState, (@{ port = $port } | ConvertTo-Json))

$config = @{ build = @{
    devUrl = "http://127.0.0.1:$port"
    beforeDevCommand = "npm exec -- vite --host 127.0.0.1 --port $port --strictPort"
} } | ConvertTo-Json -Depth 4
$configPath = Join-Path $cache 'dev-config.json'
if (-not (Test-Path -LiteralPath $configPath) -or (Get-Content -LiteralPath $configPath -Raw) -ne $config) {
    [System.IO.File]::WriteAllText($configPath, $config)
}

$env:CARGO_HOME = Join-Path $cache 'cargo'
$env:RUSTUP_HOME = Join-Path $cache 'rustup'
$env:CARGO_TARGET_DIR = Join-Path $workspace 'src-tauri\target'
$env:npm_config_cache = Join-Path $cache 'npm'
$env:PIP_CACHE_DIR = Join-Path $cache 'pip'
$env:TEMP = $temp
$env:TMP = $temp
$env:YUCHI_DEV_PORT = [string]$port
$env:PATH = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:PATH

Write-Output "Yuchi Tauri frontend: http://127.0.0.1:$port"
if ($DryRun) { exit 0 }
& npm.cmd run tauri dev -- --config $configPath
exit $LASTEXITCODE
