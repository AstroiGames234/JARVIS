@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node.exe"
if errorlevel 1 (
  set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if not exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE="
)
if not defined NODE_EXE (
  echo Node.js 24 LTS or newer is required.
  echo Install the free LTS version from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop-JARVIS.ps1" -Quiet
if errorlevel 1 (
  echo Could not stop the old J.A.R.V.I.S. instance. Run Stop-JARVIS.cmd and check the message.
  pause
  exit /b 1
)
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0Background-Tray.ps1"
"%NODE_EXE%" "%~dp0server.js"
