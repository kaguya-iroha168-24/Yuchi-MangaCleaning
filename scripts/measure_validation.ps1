param([string]$Label = 'coexist-loaded')
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$reportDirectory = 'E:\BagassZx\Yuchi-Diagnostics\mangaclean-tauri-migration\realworld-20261028'
$inventory = @(Get-CimInstance Win32_Process)
$roots = @($inventory | Where-Object {
    $_.Name -eq 'yuchi-labs-tauri.exe' -or
    ($_.Name -eq 'python.exe' -and $_.CommandLine -like '*realworld-20261028\pyside-original-copy\main.py*' -and
     $_.CommandLine -like '*DemoClean*')
})
$groups = @()
foreach ($root in $roots) {
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    [void]$owned.Add([int]$root.ProcessId)
    do {
        $previous = $owned.Count
        foreach ($item in $inventory) {
            if ($owned.Contains([int]$item.ParentProcessId)) { [void]$owned.Add([int]$item.ProcessId) }
        }
    } while ($previous -ne $owned.Count)
    $rows = @()
    foreach ($processId in $owned) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($null -eq $process) { continue }
        $rows += [ordered]@{ id = $processId; name = $process.ProcessName;
            working_set_mib = [math]::Round($process.WorkingSet64 / 1MB, 2);
            private_bytes_mib = [math]::Round($process.PrivateMemorySize64 / 1MB, 2);
            peak_working_set_mib = [math]::Round($process.PeakWorkingSet64 / 1MB, 2);
            responding = $process.Responding }
    }
    $ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $owned.Contains([int]$_.OwningProcess) } |
        Select-Object LocalAddress,LocalPort,OwningProcess)
    $sumWorking = 0.0
    $sumPrivate = 0.0
    foreach ($row in $rows) { $sumWorking += $row['working_set_mib']; $sumPrivate += $row['private_bytes_mib'] }
    $groups += [ordered]@{ root_id = $root.ProcessId; app = $root.Name; processes = $rows;
        summed_working_set_mib = [math]::Round($sumWorking, 2);
        summed_private_bytes_mib = [math]::Round($sumPrivate, 2);
        listening = $ports }
}
$report = [ordered]@{ measured_at = (Get-Date -Format o); label = $Label; applications = $groups;
    caveat = 'Point-in-time process-tree samples. Summed working sets may double-count shared pages; private bytes are committed private memory, not physical RAM. Dev build; not a release benchmark.' }
$path = Join-Path $reportDirectory ('MEMORY-' + $Label + '.json')
$report | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $path -Encoding UTF8
$report | ConvertTo-Json -Depth 7
