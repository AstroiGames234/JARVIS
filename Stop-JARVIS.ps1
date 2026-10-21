param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
$trayPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Background-Tray.ps1'))
$serverPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'server.js'))
$jarvisProcesses = @()
$serverListenerIds = @()

try { $serverListenerIds = @(Get-NetTCPConnection -LocalPort 48123 -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique) } catch {
    try {
        $serverListenerIds = @(netstat -ano -p tcp | ForEach-Object {
            if ($_ -match '^\s*TCP\s+\S+:48123\s+\S+\s+LISTENING\s+(\d+)\s*$') { [int]$Matches[1] }
        } | Select-Object -Unique)
    } catch { }
}

try {
    $processes = Get-CimInstance -ClassName Win32_Process
} catch {
    try { $processes = Get-WmiObject -Class Win32_Process } catch {
        if (-not $Quiet) { Write-Error 'Could not inspect running processes. Use Task Manager to close the J.A.R.V.I.S. tray and its Node server.' }
        exit 1
    }
}

foreach ($process in $processes) {
    if ($process.Name -notmatch '^(?:node|powershell|pwsh)\.exe$' -or [string]::IsNullOrWhiteSpace($process.CommandLine)) { continue }
    $isTray = $process.CommandLine.IndexOf($trayPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $isServer = $process.Name -ieq 'node.exe' -and (
        $process.CommandLine.IndexOf($serverPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        ($serverListenerIds -contains [int]$process.ProcessId -and $process.CommandLine -match '(?:^|\s|[\\/])server\.js(?:\s|$|")')
    )
    if ($isTray -or $isServer) {
        $jarvisProcesses += $process
    }
}

foreach ($process in $jarvisProcesses) {
    if ($process.Name -ieq 'node.exe') {
        try { Invoke-RestMethod -Uri 'http://127.0.0.1:48123/api/shutdown' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 2 | Out-Null } catch { }
    }
}

foreach ($process in $jarvisProcesses) {
    try { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop } catch { }
}

if (-not $Quiet) {
    if ($jarvisProcesses.Count) { Write-Output 'J.A.R.V.I.S. tray and server processes have been stopped.' }
    else { Write-Output 'No J.A.R.V.I.S. processes were running from this folder.' }
}
