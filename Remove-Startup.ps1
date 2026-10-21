$ErrorActionPreference = 'Stop'
$shortcutPath = Join-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup') 'JARVIS Personal System.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
}
Write-Output 'J.A.R.V.I.S. was removed from Windows startup.'
