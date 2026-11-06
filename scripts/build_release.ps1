param([switch]$SkipBuild, [string]$ResumeDirectory)
$ErrorActionPreference = 'Stop'
$releaseWorkspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $releaseWorkspace
# Child process only: reuse the same existing toolchain/cache as development.
$env:CARGO_HOME = Join-Path $releaseWorkspace '.cache\cargo'
$env:RUSTUP_HOME = Join-Path $releaseWorkspace '.cache\rustup'
$env:CARGO_TARGET_DIR = Join-Path $releaseWorkspace 'src-tauri\target'
$env:npm_config_cache = Join-Path $releaseWorkspace '.cache\npm'
$env:TEMP = Join-Path $releaseWorkspace '.cache\tmp'
$env:TMP = $env:TEMP
$env:PATH = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:PATH
if (-not $SkipBuild) {
    & npm.cmd run tauri build -- --no-bundle -- --offline
    if ($LASTEXITCODE -ne 0) { throw 'Release build failed. No installation was attempted.' }
}
$stageArguments = @('-B', (Join-Path $PSScriptRoot 'stage_release.py'))
if ($ResumeDirectory) { $stageArguments += @('--resume', $ResumeDirectory) }
& (Join-Path $releaseWorkspace '.venv-standalone\Scripts\python.exe') @stageArguments
if ($LASTEXITCODE -ne 0) { throw 'Release staging failed.' }
$releaseReceipt = Get-Content -LiteralPath (Join-Path $releaseWorkspace '.cache\latest-release.json') -Raw | ConvertFrom-Json
$shortcutFile = Join-Path $releaseWorkspace 'MangaClean.lnk'
$shortcutShell = New-Object -ComObject WScript.Shell
$shortcut = $shortcutShell.CreateShortcut($shortcutFile)
$shortcut.TargetPath = $releaseReceipt.executable
$shortcut.WorkingDirectory = $releaseReceipt.directory
$shortcut.Description = 'MangaClean Local Release — no terminal or development build'
$shortcut.Save()
