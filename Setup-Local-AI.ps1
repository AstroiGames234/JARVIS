$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Model = 'qwen3.5:2b'
$Root = Join-Path $env:LOCALAPPDATA 'JARVIS\voice'
$KokoroRoot = Join-Path $Root 'kokoro-multi-lang-v1_0'
$VoicePackage = Join-Path $Root 'node_modules\sherpa-onnx-node'
$Archive = Join-Path $env:TEMP 'JARVIS-kokoro-multi-lang-v1_0.tar.bz2'
$ModelUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2'

$Ollama = Get-Command 'ollama.exe' -ErrorAction SilentlyContinue
if (-not $Ollama) {
  Write-Host 'Ollama is not installed.' -ForegroundColor Red
  Write-Host 'Install it from https://ollama.com/download/windows, then run this setup again.'
  Read-Host 'Press Enter to close'
  exit 1
}

$Npm = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
if (-not $Npm) {
  Write-Host 'npm was not found. Install Node.js 24 LTS from https://nodejs.org/, then run this setup again.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
$Node = Get-Command 'node.exe' -ErrorAction SilentlyContinue
if (-not $Node) {
  Write-Host 'node.exe was not found. Install Node.js 24 LTS from https://nodejs.org/, then run this setup again.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

New-Item -ItemType Directory -Path $Root -Force | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $Root 'package.json'))) {
  '{"name":"jarvis-local-voice","private":true}' | Set-Content -LiteralPath (Join-Path $Root 'package.json') -Encoding ASCII
}

Write-Host "Downloading the local $Model model through Ollama. This is about 3.1 GB the first time." -ForegroundColor Cyan
& $Ollama.Source pull $Model
if ($LASTEXITCODE -ne 0) { throw 'Ollama could not download the model. Confirm Ollama is running and try again.' }

Write-Host 'Installing the local Windows speech engine (no Python or compiler required)…' -ForegroundColor Cyan
& $Npm.Source install --prefix $Root --no-save --no-package-lock 'sherpa-onnx-node'
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $VoicePackage)) {
  throw 'Could not install the local speech engine. Check your internet connection and run Setup-Local-AI.cmd again.'
}

$ModelFile = Join-Path $KokoroRoot 'model.onnx'
$VoiceFile = Join-Path $KokoroRoot 'voices.bin'
$TokensFile = Join-Path $KokoroRoot 'tokens.txt'
$LexiconFile = Join-Path $KokoroRoot 'lexicon-gb-en.txt'
$EspeakData = Join-Path $KokoroRoot 'espeak-ng-data'
if (-not ((Test-Path -LiteralPath $ModelFile) -and (Test-Path -LiteralPath $VoiceFile) -and (Test-Path -LiteralPath $TokensFile) -and (Test-Path -LiteralPath $LexiconFile) -and (Test-Path -LiteralPath $EspeakData))) {
  Write-Host 'Downloading the Kokoro multi-voice model (about 700 MB after extraction)…' -ForegroundColor Cyan
  Invoke-WebRequest -Uri $ModelUrl -OutFile $Archive
  $Tar = Get-Command 'tar.exe' -ErrorAction SilentlyContinue
  if (-not $Tar) { throw 'Windows tar.exe was not found. Install current Windows updates and run setup again.' }
  & $Tar.Source '-xjf' $Archive '-C' $Root
  if ($LASTEXITCODE -ne 0) { throw 'Could not extract the Kokoro voice model.' }
  Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
}

if (-not ((Test-Path -LiteralPath $ModelFile) -and (Test-Path -LiteralPath $VoiceFile) -and (Test-Path -LiteralPath $TokensFile) -and (Test-Path -LiteralPath $LexiconFile) -and (Test-Path -LiteralPath $EspeakData))) {
  throw 'The Kokoro voice model did not finish installing. Run Setup-Local-AI.cmd again.'
}

Write-Host 'Preparing instant “Yes, sir?” replies in each British voice…' -ForegroundColor Cyan
& $Node.Source (Join-Path $PSScriptRoot 'Prepare-Voice.js')
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the instant wake acknowledgements.' }

Write-Host ''
Write-Host 'Local AI and Kokoro voice setup is complete. Restart J.A.R.V.I.S., then compare the British voices in Preferences.' -ForegroundColor Green
Read-Host 'Press Enter to close'
