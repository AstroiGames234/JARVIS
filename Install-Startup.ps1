$ErrorActionPreference = 'Stop'
$startupFolder = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$shortcutPath = Join-Path $startupFolder 'JARVIS Personal System.lnk'
$launcherPath = Join-Path $PSScriptRoot 'Start-JARVIS.vbs'
$wscriptPath = Join-Path $env:WINDIR 'System32\wscript.exe'

if (-not (Test-Path -LiteralPath $launcherPath)) {
    throw "The launcher was not found: $launcherPath"
}
if (-not (Test-Path -LiteralPath $startupFolder)) {
    New-Item -ItemType Directory -Path $startupFolder -Force | Out-Null
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $wscriptPath
$shortcut.Arguments = '"' + $launcherPath + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$iconPath = Join-Path $PSScriptRoot 'jarvis.ico'
if (Test-Path -LiteralPath $iconPath) { $shortcut.IconLocation = "$iconPath,0" }
$shortcut.Description = 'Start J.A.R.V.I.S. Personal System when you sign in'
$shortcut.Save()
Write-Output 'J.A.R.V.I.S. will start when you sign in to Windows.'
