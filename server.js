const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const HOST = '127.0.0.1';
const PORT = 48123;
const ROOT = __dirname;
const MAX_BODY = 2_500_000;
const STARTUP_SHORTCUT = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'JARVIS Personal System.lnk');
const LOCAL_MODEL = 'qwen3.5:2b';
const LOCAL_AI_URL = 'http://127.0.0.1:11434';
const LOCAL_VOICE_ROOT = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'JARVIS', 'voice');
const LOCAL_VOICE_PACKAGE = path.join(LOCAL_VOICE_ROOT, 'node_modules', 'sherpa-onnx-node');
const KOKORO_ROOT = path.join(LOCAL_VOICE_ROOT, 'kokoro-multi-lang-v1_0');
const VOICE_PREFERENCE_FILE = path.join(LOCAL_VOICE_ROOT, 'voice-preference.json');
const KOKORO_VOICE_IDS = new Set([24, 25, 26, 27]);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon'
};
const PUBLIC_FILES = new Set(['index.html', 'app.css', 'app.js', 'settings-fallback.js']);
let backgroundVoice = { ready: false, message: 'Waiting for the Windows tray listener.', available: false, foregroundPaused: false };
let foregroundVoice = { active: false, updatedAt: 0, sequence: -1 };
let backgroundSpeech = null;
let backgroundSpeechSequence = 0;
let localSpeechEngine = null;
let localSpeechQueue = Promise.resolve();
let selectedVoiceId = (() => {
  try {
    const saved = Number(JSON.parse(fs.readFileSync(VOICE_PREFERENCE_FILE, 'utf8')).voiceId);
    return KOKORO_VOICE_IDS.has(saved) ? saved : 25;
  } catch { return 25; }
})();
const wakeAcknowledgementAudio = new Map();
for (const voiceId of KOKORO_VOICE_IDS) {
  try {
    const file = fs.readFileSync(path.join(LOCAL_VOICE_ROOT, `wake-ack-${voiceId}.wav`));
    if (file.length >= 44 && file.toString('ascii', 0, 4) === 'RIFF' && file.toString('ascii', 8, 12) === 'WAVE') {
      wakeAcknowledgementAudio.set(voiceId, file);
    }
  } catch { /* The setup script creates these ready-to-play wake acknowledgements. */ }
}

function send(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
}

function rejectForeignOrigin(req, res) {
  const expectedOrigin = `http://${HOST}:${PORT}`;
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (host !== `${HOST}:${PORT}` || (origin && origin !== expectedOrigin)) {
    send(res, 403, { error: 'This local assistant only accepts requests from its own window.' });
    return true;
  }
  return false;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('The request was not valid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const APP_TARGETS = {
  calculator: { label: 'Calculator', command: 'calc.exe' },
  notepad: { label: 'Notepad', command: 'notepad.exe' },
  paint: { label: 'Paint', command: 'mspaint.exe' },
  explorer: { label: 'File Explorer', command: 'explorer.exe' },
  settings: { label: 'Settings', command: 'ms-settings:', shell: true },
  browser: { label: 'Browser', command: 'https://www.google.com', shell: true },
  taskmanager: { label: 'Task Manager', command: 'taskmgr.exe' },
  snippingtool: { label: 'Snipping Tool', command: 'SnippingTool.exe' },
  terminal: { label: 'Terminal', command: 'wt.exe' },
  camera: { label: 'Camera', command: 'microsoft.windows.camera:' , shell: true }
};

const APP_ALIASES = {
  calc: 'calculator', 'the calculator': 'calculator',
  'file explorer': 'explorer', 'the file explorer': 'explorer', 'windows explorer': 'explorer', files: 'explorer', folders: 'explorer',
  'text editor': 'notepad', 'the notepad': 'notepad', 'microsoft paint': 'paint',
  'the settings': 'settings', 'windows settings': 'settings', 'task manager': 'taskmanager', 'the task manager': 'taskmanager',
  'snipping tool': 'snippingtool', 'the snipping tool': 'snippingtool', snip: 'snippingtool', 'windows terminal': 'terminal', 'the terminal': 'terminal',
  'the browser': 'browser', 'web browser': 'browser', 'the camera': 'camera'
};
let installedAppCache = { expiresAt: 0, apps: [] };
let installedAppScan = null;
let steamCatalogCache = { expiresAt: 0, apps: [], executable: '' };
let steamCatalogScan = null;

function appKey(value) {
  return String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function addStartMenuApps(apps, folder, depth = 0) {
  if (depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      addStartMenuApps(apps, fullPath, depth + 1);
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.lnk') {
      const label = path.basename(entry.name, path.extname(entry.name)).trim();
      if (label) apps.push({ label, type: 'shortcut', target: fullPath, priority: 3 });
    }
  }
}

function readPowerShellAppCatalog() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$items = @() ',
    'Get-StartApps | ForEach-Object { if ($_.Name -and $_.AppID) { $items += [pscustomobject]@{label=[string]$_.Name; type=\'aumid\'; target=[string]$_.AppID; priority=2} } }',
    "$roots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths')",
    'foreach ($root in $roots) { if (Test-Path $root) { Get-ChildItem $root | ForEach-Object { $key = Get-Item $_.PSPath; $exe = ([string]$key.GetValue(\'\')).Trim(\'"\'); $name = [IO.Path]::GetFileNameWithoutExtension($_.PSChildName); if ($exe -and (Test-Path $exe)) { $items += [pscustomobject]@{label=$name; type=\'exe\'; target=$exe; priority=1} } } } }',
    "$steamRoots = @('HKCU:\\Software\\Valve\\Steam', 'HKLM:\\Software\\Valve\\Steam', 'HKLM:\\Software\\WOW6432Node\\Valve\\Steam')",
    'foreach ($root in $steamRoots) { if (Test-Path $root) { $install = (Get-ItemProperty -Path $root -Name InstallPath).InstallPath; if ($install) { $exe = Join-Path $install \'steam.exe\'; if (Test-Path $exe) { $items += [pscustomobject]@{label=\'Steam\'; type=\'exe\'; target=$exe; priority=2} } } } }',
    'ConvertTo-Json -InputObject @($items) -Compress'
  ].join('; ');
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (apps) => { if (settled) return; settled = true; resolve(apps); };
    let child;
    try {
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], shell: false
      });
    } catch { return finish([]); }
    const timeout = setTimeout(() => { child.kill(); finish([]); }, 12_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 3_000_000) { child.kill(); finish([]); }
    });
    child.once('error', () => { clearTimeout(timeout); finish([]); });
    child.once('close', () => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(output.trim() || '[]');
        finish((Array.isArray(parsed) ? parsed : [parsed]).filter((item) =>
          item && typeof item.label === 'string' && typeof item.target === 'string' &&
          ['aumid', 'exe'].includes(item.type)
        ));
      } catch { finish([]); }
    });
  });
}

async function getInstalledApps() {
  if (Date.now() < installedAppCache.expiresAt) return installedAppCache.apps;
  if (installedAppScan) return installedAppScan;
  installedAppScan = (async () => {
    const apps = [];
    addStartMenuApps(apps, path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    addStartMenuApps(apps, path.join(process.env.ProgramData || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    apps.push(...await readPowerShellAppCatalog());
    const unique = new Map();
    for (const app of apps) {
      if (!app.label || !appKey(app.label) || !app.target) continue;
      const key = `${appKey(app.label)}:${app.type}`;
      const existing = unique.get(key);
      if (!existing || app.priority > existing.priority) unique.set(key, app);
    }
    installedAppCache = { apps: [...unique.values()], expiresAt: Date.now() + 60_000 };
    return installedAppCache.apps;
  })().finally(() => { installedAppScan = null; });
  return installedAppScan;
}

function decodeVdfString(value) {
  return value.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
}

async function getSteamCatalog() {
  if (Date.now() < steamCatalogCache.expiresAt) return steamCatalogCache;
  if (steamCatalogScan) return steamCatalogScan;
  steamCatalogScan = (async () => {
    const roots = new Set([
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Steam'),
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Steam')
    ]);
    for (const app of await getInstalledApps()) {
      if (app.type === 'exe' && appKey(app.label) === 'steam' && path.basename(app.target).toLowerCase() === 'steam.exe') {
        roots.add(path.dirname(app.target));
      }
    }

    const libraries = new Set();
    let executable = '';
    for (const root of roots) {
      const steamExe = path.join(root, 'steam.exe');
      if (!executable && fs.existsSync(steamExe)) executable = steamExe;
      const steamApps = path.join(root, 'steamapps');
      if (!fs.existsSync(steamApps)) continue;
      libraries.add(steamApps);
      const libraryFile = path.join(steamApps, 'libraryfolders.vdf');
      try {
        const data = fs.readFileSync(libraryFile, 'utf8');
        for (const match of data.matchAll(/"path"\s*"((?:\\.|[^"])*)"/gi)) {
          const libraryRoot = decodeVdfString(match[1]);
          if (libraryRoot) libraries.add(path.join(libraryRoot, 'steamapps'));
        }
      } catch { /* Older Steam installs may not have a library list yet. */ }
    }

    const games = new Map();
    for (const steamApps of libraries) {
      let files;
      try { files = fs.readdirSync(steamApps); } catch { continue; }
      for (const file of files) {
        if (!/^appmanifest_\d+\.acf$/i.test(file)) continue;
        try {
          const manifestPath = path.join(steamApps, file);
          if (fs.statSync(manifestPath).size > 256_000) continue;
          const manifest = fs.readFileSync(manifestPath, 'utf8');
          const id = manifest.match(/"appid"\s*"(\d+)"/i)?.[1];
          const nameValue = manifest.match(/"name"\s*"((?:\\.|[^"])*)"/i)?.[1];
          const stateValue = manifest.match(/"StateFlags"\s*"(\d+)"/i)?.[1];
          if (!id || !nameValue || !stateValue || (Number(stateValue) & 4) === 0) continue;
          const label = decodeVdfString(nameValue).trim();
          if (label) games.set(id, { label, appId: id });
        } catch { /* Skip unreadable or incomplete app manifests. */ }
      }
    }
    steamCatalogCache = { apps: [...games.values()], executable, expiresAt: Date.now() + 60_000 };
    return steamCatalogCache;
  })().finally(() => { steamCatalogScan = null; });
  return steamCatalogScan;
}

async function launchSteamApp(requestedName) {
  const catalog = await getSteamCatalog();
  const key = appKey(requestedName);
  const exact = catalog.apps.filter((app) => appKey(app.label) === key);
  let game = exact[0];
  if (!game) {
    const candidates = catalog.apps.filter((app) => appKey(app.label).startsWith(key));
    const matches = candidates.length ? candidates : catalog.apps.filter((app) => appKey(app.label).includes(key));
    if (matches.length === 1) game = matches[0];
    else if (matches.length > 1) {
      throw new Error(`More than one Steam app matches “${requestedName}”: ${matches.slice(0, 5).map((app) => app.label).join(', ')}. Please say the full name.`);
    }
  }
  if (!game) throw new Error(`I could not find “${requestedName}” among the installed Steam apps, sir.`);
  if (catalog.executable) return launchDetached(catalog.executable, ['-applaunch', game.appId], game.label);
  return launchDetached('explorer.exe', [`steam://rungameid/${game.appId}`], game.label);
}

async function findInstalledApp(requested) {
  const apps = await getInstalledApps();
  const key = appKey(requested);
  if (!key) return null;
  const exact = apps.filter((app) => appKey(app.label) === key);
  if (exact.length) return exact.sort((a, b) => b.priority - a.priority)[0];
  const prefix = apps.filter((app) => appKey(app.label).startsWith(key));
  if (prefix.length === 1) return prefix[0];
  const partial = apps.filter((app) => appKey(app.label).includes(key));
  if (partial.length === 1) return partial[0];
  if (prefix.length > 1 || partial.length > 1) {
    const choices = (prefix.length > 1 ? prefix : partial).slice(0, 5).map((app) => app.label);
    throw new Error(`More than one app matches “${requested}”: ${choices.join(', ')}. Please say the full app name.`);
  }
  return null;
}

function launchDetached(executable, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child.once('error', (error) => reject(new Error(`${label} could not be opened. ${error.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve(label);
    });
  });
}

async function openApp(requestedName) {
  if (typeof requestedName !== 'string' || !requestedName.trim() || requestedName.length > 200) {
    throw new Error('Please tell me the name of the app you would like me to open, sir.');
  }
  const requested = requestedName.trim().replace(/[.!?]+$/g, '').trim();
  const steamMatch = requested.match(/^(.+?)\s+(?:through|via)\s+steam$/i);
  if (steamMatch) {
    const gameName = steamMatch[1].trim();
    if (!gameName) throw new Error('Please say the Steam app name before “through Steam,” sir.');
    return launchSteamApp(gameName);
  }
  const normalized = requested.toLowerCase();
  const alias = Object.hasOwn(APP_ALIASES, normalized) ? APP_ALIASES[normalized] : null;
  const id = alias || (Object.hasOwn(APP_TARGETS, normalized) ? normalized : null);
  if (id) {
    const app = APP_TARGETS[id];
    return launchDetached(app.shell ? 'explorer.exe' : app.command, app.shell ? [app.command] : [], app.label);
  }

  let installed = await findInstalledApp(requested);
  if (!installed && /^(?:the|my)\s+/i.test(requested)) {
    installed = await findInstalledApp(requested.replace(/^(?:the|my)\s+/i, ''));
  }
  if (!installed) throw new Error(`I could not find “${requested}” in the installed app catalog. Try its full Start menu name, sir.`);
  if (installed.type === 'shortcut') return launchDetached('explorer.exe', [installed.target], installed.label);
  if (installed.type === 'aumid') {
    if (!/^[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/.test(installed.target)) throw new Error(`${installed.label} has an invalid Windows app identifier.`);
    return launchDetached('explorer.exe', [`shell:AppsFolder\\${installed.target}`], installed.label);
  }
  if (installed.type === 'exe') {
    if (!path.isAbsolute(installed.target) || !installed.target.toLowerCase().endsWith('.exe')) throw new Error(`${installed.label} has an invalid executable path.`);
    return launchDetached(installed.target, [], installed.label);
  }
  throw new Error(`Windows could not launch ${installed.label}.`);
}

function openWebSearch(query) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  return new Promise((resolve, reject) => {
    const child = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child.once('error', (error) => reject(new Error(`The web search could not be opened. ${error.message}`)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function validateContents(contents) {
  if (!Array.isArray(contents) || contents.length < 1 || contents.length > 16) {
    throw Object.assign(new Error('Conversation is empty or too long.'), { status: 400 });
  }
  const safe = [];
  for (const turn of contents) {
    if (!turn || !['user', 'model'].includes(turn.role) || typeof turn.text !== 'string') continue;
    const text = turn.text.slice(0, 5000);
    safe.push({ role: turn.role, parts: [{ text }] });
  }
  if (!safe.length || safe[safe.length - 1].role !== 'user') {
    throw Object.assign(new Error('The latest message must be from you.'), { status: 400 });
  }
  return safe;
}

async function askLocalModel(body) {
  const contents = validateContents(body.contents);
  const messages = [{
    role: 'system',
    content: 'You are JARVIS, a calm, capable personal desktop aide with concise British formality and dry warmth. Address the user as “sir” naturally, especially when acknowledging requests, but do not force it into every sentence. Use clear, brief spoken-friendly answers. You are inspired by a fictional cinematic assistant, but do not claim to be the film character or imitate any actor. Be honest about what you can access: you cannot see the desktop or use the camera unless an image is explicitly included in the current message. Never claim an action occurred unless the desktop app confirms it.'
  }, ...contents.map((turn) => ({ role: turn.role === 'model' ? 'assistant' : turn.role, content: turn.parts[0].text }))];
  if (body.image && typeof body.image.data === 'string') {
    const match = body.image.data.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match || match[2].length > 1_800_000) {
      throw Object.assign(new Error('Camera image was invalid or too large.'), { status: 400 });
    }
    messages[messages.length - 1].images = [match[2]];
  }

  let response;
  try {
    response = await fetch(`${LOCAL_AI_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LOCAL_MODEL,
        messages,
        stream: false,
        keep_alive: '10m',
        options: { temperature: 0.7, num_predict: 700 }
      }),
      signal: AbortSignal.timeout(180_000)
    });
  } catch {
    throw Object.assign(new Error('The local AI runtime is unavailable. Install Ollama, then run Setup-Local-AI.cmd from the J.A.R.V.I.S. folder.'), { status: 503 });
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error || `Ollama returned HTTP ${response.status}.`;
    throw Object.assign(new Error(detail), { status: 502 });
  }
  const answer = data?.message?.content?.trim();
  if (!answer) throw Object.assign(new Error('The local model returned no text. Please try again.'), { status: 502 });
  return answer;
}

async function localModelStatus() {
  try {
    const response = await fetch(`${LOCAL_AI_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { runtime: true, installed: false, model: LOCAL_MODEL };
    const data = await response.json().catch(() => ({}));
    const installed = Array.isArray(data.models) && data.models.some((item) => item.name === LOCAL_MODEL || item.model === LOCAL_MODEL);
    return { runtime: true, installed, model: LOCAL_MODEL };
  } catch {
    return { runtime: false, installed: false, model: LOCAL_MODEL };
  }
}

async function loadLocalSpeechEngine() {
  const requiredFiles = [
    path.join(KOKORO_ROOT, 'model.onnx'),
    path.join(KOKORO_ROOT, 'voices.bin'),
    path.join(KOKORO_ROOT, 'tokens.txt'),
    path.join(KOKORO_ROOT, 'lexicon-gb-en.txt'),
    path.join(KOKORO_ROOT, 'espeak-ng-data')
  ];
  if (!fs.existsSync(LOCAL_VOICE_PACKAGE) || requiredFiles.some((file) => !fs.existsSync(file))) {
    throw Object.assign(new Error('The local J.A.R.V.I.S. voice is not installed yet. Run Setup-Local-AI.cmd from the J.A.R.V.I.S. folder.'), { status: 503 });
  }
  if (!localSpeechEngine) {
    localSpeechEngine = Promise.resolve().then(async () => {
      const sherpa = require(LOCAL_VOICE_PACKAGE);
      const tts = await sherpa.OfflineTts.createAsync({
        model: {
          kokoro: {
            model: path.join(KOKORO_ROOT, 'model.onnx'),
            voices: path.join(KOKORO_ROOT, 'voices.bin'),
            tokens: path.join(KOKORO_ROOT, 'tokens.txt'),
            lexicon: path.join(KOKORO_ROOT, 'lexicon-gb-en.txt'),
            dataDir: path.join(KOKORO_ROOT, 'espeak-ng-data')
          },
          numThreads: Math.max(1, Math.min(4, os.cpus().length - 1)),
          debug: 0,
          provider: 'cpu'
        },
        maxNumSentences: 1,
        silenceScale: 0.2
      });
      return { sherpa, tts };
    }).catch((error) => {
      localSpeechEngine = null;
      throw Object.assign(new Error(`The local J.A.R.V.I.S. voice could not initialise. ${error.message || 'Check Setup-Local-AI.cmd.'}`), { status: 503 });
    });
  }
  return localSpeechEngine;
}

async function renderLocalSpeech(transcript, voiceId) {
  const { sherpa, tts } = await loadLocalSpeechEngine();
  try {
    const generationConfig = new sherpa.GenerationConfig({ sid: voiceId, speed: 0.94, silenceScale: 0.2 });
    const audio = await tts.generateAsync({ text: transcript, generationConfig });
    if (!audio?.samples?.length || !audio.sampleRate) throw new Error('Kokoro returned empty audio.');
    const outputPath = path.join(os.tmpdir(), `jarvis-voice-${process.pid}-${crypto.randomBytes(8).toString('hex')}.wav`);
    try {
      sherpa.writeWave(outputPath, { samples: audio.samples, sampleRate: audio.sampleRate });
      const wave = fs.readFileSync(outputPath);
      if (wave.length < 44 || wave.toString('ascii', 0, 4) !== 'RIFF' || wave.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Kokoro returned an invalid WAV file.');
      }
      return wave;
    } finally {
      try { fs.rmSync(outputPath, { force: true }); } catch { /* Remove temporary speech output when possible. */ }
    }
  } catch (error) {
    throw Object.assign(new Error(`Local J.A.R.V.I.S. speech failed. ${error.message || 'Kokoro could not generate audio.'}`), { status: 502 });
  }
}

function synthesizeLocalSpeech(text, voiceId = selectedVoiceId) {
  const transcript = typeof text === 'string' ? text.trim().slice(0, 3000) : '';
  if (!transcript) return Promise.reject(Object.assign(new Error('There is no reply to speak.'), { status: 400 }));
  if (/^yes[\s,]+sir[?!.]*$/i.test(transcript) && wakeAcknowledgementAudio.has(voiceId)) {
    return Promise.resolve(wakeAcknowledgementAudio.get(voiceId));
  }
  const queued = localSpeechQueue.then(() => renderLocalSpeech(transcript, voiceId));
  localSpeechQueue = queued.catch(() => {});
  return queued;
}

function savePreferredVoice(value) {
  const voiceId = Number(value);
  if (!KOKORO_VOICE_IDS.has(voiceId)) {
    throw Object.assign(new Error('Choose one of the installed British voices.'), { status: 400 });
  }
  selectedVoiceId = voiceId;
  try {
    fs.mkdirSync(LOCAL_VOICE_ROOT, { recursive: true });
    fs.writeFileSync(VOICE_PREFERENCE_FILE, JSON.stringify({ voiceId }), 'utf8');
  } catch (error) {
    throw Object.assign(new Error(`The voice preference could not be saved. ${error.message}`), { status: 500 });
  }
  return voiceId;
}

function sendAudio(res, audio) {
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Content-Length': audio.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(audio);
}

function sendFile(res, pathname) {
  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(ROOT, `.${cleanPath}`);
  if (!resolved.startsWith(ROOT + path.sep) || !PUBLIC_FILES.has(path.basename(resolved)) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  });
  fs.createReadStream(resolved).pipe(res);
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') return send(res, 200, { ok: true });
  if (rejectForeignOrigin(req, res)) return;
  if (req.url === '/api/startup/status' && req.method === 'GET') {
    return send(res, 200, { enabled: fs.existsSync(STARTUP_SHORTCUT) });
  }
  if (req.url === '/api/background/status' && req.method === 'GET') {
    return send(res, 200, backgroundVoice);
  }
  if (req.url === '/api/foreground/status' && req.method === 'GET') {
    return send(res, 200, { active: foregroundVoice.active && Date.now() - foregroundVoice.updatedAt < 5000 });
  }
  if (req.url === '/api/foreground/status' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const sequence = Number.isSafeInteger(body.sequence) ? body.sequence : foregroundVoice.sequence + 1;
      if (sequence >= foregroundVoice.sequence) foregroundVoice = { active: body.active === true, updatedAt: Date.now(), sequence };
      return send(res, 200, { ok: true });
    } catch (error) {
      return send(res, error.status || 400, { error: error.message });
    }
  }
  if (req.url === '/api/voice/preference' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const voiceId = savePreferredVoice(body.voiceId);
      return send(res, 200, { ok: true, voiceId });
    } catch (error) {
      return send(res, error.status || 400, { error: error.message });
    }
  }
  if (req.url === '/api/tts' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const requestedVoiceId = body.voiceId === undefined ? selectedVoiceId : Number(body.voiceId);
      const voiceId = requestedVoiceId === selectedVoiceId ? selectedVoiceId : savePreferredVoice(requestedVoiceId);
      const audio = await synthesizeLocalSpeech(body.text, voiceId);
      return sendAudio(res, audio);
    } catch (error) {
      return send(res, error.status || 502, { error: error.message || 'The local voice could not generate speech.' });
    }
  }
  if (req.url === '/api/model/status' && req.method === 'GET') {
    return send(res, 200, await localModelStatus());
  }
  if (req.url === '/api/background/status' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      backgroundVoice = {
        ready: body.ready === true,
        message: typeof body.message === 'string' ? body.message.trim().slice(0, 240) : '',
        available: body.available === true,
        foregroundPaused: body.foregroundPaused === true
      };
      return send(res, 200, { ok: true });
    } catch (error) {
      return send(res, error.status || 400, { error: error.message });
    }
  }
  if (req.url === '/api/background/speech' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 3000) : '';
      if (!text) return send(res, 400, { error: 'There is no reply to speak.' });
      const id = String(++backgroundSpeechSequence);
      backgroundSpeech = { id, text, createdAt: Date.now(), claimed: false, complete: false, handled: false };
      return send(res, 200, { id });
    } catch (error) {
      return send(res, error.status || 400, { error: error.message });
    }
  }
  if (req.url === '/api/background/speech' && req.method === 'GET') {
    if (!backgroundSpeech || Date.now() - backgroundSpeech.createdAt > 90_000 || backgroundSpeech.claimed) return send(res, 200, { pending: false });
    backgroundSpeech.claimed = true;
    return send(res, 200, { pending: true, id: backgroundSpeech.id, text: backgroundSpeech.text });
  }
  if (req.url.startsWith('/api/background/speech/result?') && req.method === 'GET') {
    const id = new URL(req.url, `http://${HOST}:${PORT}`).searchParams.get('id');
    if (!backgroundSpeech || backgroundSpeech.id !== id || Date.now() - backgroundSpeech.createdAt > 90_000) return send(res, 200, { complete: true, handled: false, claimed: false });
    return send(res, 200, { complete: backgroundSpeech.complete, handled: backgroundSpeech.handled, claimed: backgroundSpeech.claimed });
  }
  if (req.url === '/api/background/speech/ack' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      if (!backgroundSpeech || body.id !== backgroundSpeech.id) return send(res, 404, { error: 'That background reply has expired.' });
      backgroundSpeech.complete = true;
      backgroundSpeech.handled = body.handled === true;
      return send(res, 200, { ok: true });
    } catch (error) {
      return send(res, error.status || 400, { error: error.message });
    }
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      const answer = await askLocalModel(await readJson(req));
      return send(res, 200, { answer });
    } catch (error) {
      return send(res, error.status || 502, { error: error.message || 'The local AI model could not be reached.' });
    }
  }
  if (req.method === 'POST' && req.url === '/api/assistant-command') {
    try {
      const body = await readJson(req);
      const command = typeof body.command === 'string' ? body.command.trim().slice(0, 1000) : '';
      if (!command) return send(res, 400, { error: 'I did not catch a command, sir.' });

      const openMatch = command.match(/^(?:please\s+)?(?:open|launch|start)\s+(.+?)\s*[.!?]*$/i);
      if (openMatch) {
        const requested = openMatch[1].replace(/[.!?]+$/g, '').trim();
        const label = await openApp(requested);
        return send(res, 200, { response: `Opening ${label}, sir.` });
      }

      const searchMatch = command.match(/^(?:please\s+)?(?:search(?: the web)? for|look up|google)\s+(.+?)\s*[.!?]*$/i);
      if (searchMatch) {
        const query = searchMatch[1].trim().slice(0, 500);
        if (!query) return send(res, 400, { error: 'Tell me what you would like me to search for, sir.' });
        await openWebSearch(query);
        return send(res, 200, { response: `I’ve opened a web search for ${query}, sir.` });
      }

      const answer = await askLocalModel({
        contents: [{ role: 'user', text: command }]
      });
      return send(res, 200, { response: answer });
    } catch (error) {
      return send(res, error.status || 502, { error: error.message || 'I could not complete that request, sir.' });
    }
  }
  if (req.method === 'POST' && req.url === '/api/open-app') {
    try {
      const body = await readJson(req);
      const label = await openApp(body.app);
      return send(res, 200, { ok: true, label });
    } catch (error) {
      return send(res, error.status || 400, { error: error.message });
    }
  }
  if (req.method === 'POST' && req.url === '/api/search') {
    try {
      const body = await readJson(req);
      const query = typeof body.query === 'string' ? body.query.trim().slice(0, 500) : '';
      if (!query) return send(res, 400, { error: 'Add a search query first.' });
      await openWebSearch(query);
      return send(res, 200, { ok: true });
    } catch (error) {
      return send(res, error.status || 400, { error: error.message });
    }
  }
  if (req.method === 'POST' && req.url === '/api/background/hide') {
    const script = path.join(ROOT, 'Window-Control.ps1');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Action', 'Hide'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', (error) => send(res, 500, { error: `Could not hide the JARVIS window: ${error.message}` }));
    child.once('close', (code) => {
      if (code === 0) return send(res, 200, { ok: true });
      return send(res, 500, { error: output.trim() || 'The JARVIS window could not be found.' });
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/shutdown') {
    send(res, 200, { ok: true });
    setTimeout(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2500).unref();
    }, 250).unref();
    return;
  }
  if (req.method === 'POST' && req.url === '/api/startup') {
    try {
      const body = await readJson(req);
      if (!['enable', 'disable'].includes(body.action)) return send(res, 400, { error: 'Unknown startup action.' });
      const script = path.join(ROOT, body.action === 'enable' ? 'Install-Startup.ps1' : 'Remove-Startup.ps1');
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk) => { output += chunk.toString(); });
      child.on('close', (code) => {
        if (code !== 0) return send(res, 500, { error: output.trim() || 'Windows could not update the startup shortcut.' });
        return send(res, 200, { ok: true, enabled: body.action === 'enable' });
      });
      child.on('error', (error) => send(res, 500, { error: error.message }));
    } catch (error) {
      return send(res, error.status || 400, { error: error.message });
    }
    return;
  }
  if (req.method === 'GET') return sendFile(res, new URL(req.url, `http://${HOST}:${PORT}`).pathname);
  res.writeHead(405, { Allow: 'GET, POST' });
  res.end('Method not allowed');
});

function launchWindow() {
  const url = `http://${HOST}:${PORT}`;
  const edgePaths = [
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  const edge = edgePaths.find((candidate) => candidate && fs.existsSync(candidate));
  try {
    if (edge) spawn(edge, [`--app=${url}`, '--new-window'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    // If Edge is unavailable, the server remains usable at the local URL.
  }
}

async function run() {
  try {
    const existing = await fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(800) });
    if (existing.ok) {
      launchWindow();
      return;
    }
  } catch { /* No earlier instance is running. */ }

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') launchWindow();
    else process.exitCode = 1;
  });
  server.listen(PORT, HOST, launchWindow);
}

run();
