(() => {
  const $ = (selector) => document.querySelector(selector);
  const storageGet = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const storageSet = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Preferences remain usable if browser storage is disabled. */ } };
  const storageRemove = (key) => { try { localStorage.removeItem(key); } catch { /* Preferences remain usable if browser storage is disabled. */ } };
  const chatList = $('#chatList');
  const messageInput = $('#messageInput');
  const settingsDialog = $('#settingsDialog');
  const infoDialog = $('#infoDialog');
  const LOCAL_MODEL = 'qwen3.5:2b';
  const KOKORO_VOICE_IDS = [24, 25, 26, 27];
  const storedVoiceId = Number(storageGet('jarvis.voiceId'));
  const voicePreferenceVersion = storageGet('jarvis.voicePreferenceVersion');
  const settings = {
    model: LOCAL_MODEL,
    speak: voicePreferenceVersion === '2' ? storageGet('jarvis.speak') !== 'false' : true,
    voiceId: KOKORO_VOICE_IDS.includes(storedVoiceId) ? storedVoiceId : 25
  };
  storageRemove('jarvis.geminiKey');
  storageSet('jarvis.model', LOCAL_MODEL);
  if (voicePreferenceVersion !== '2') {
    storageSet('jarvis.speak', 'true');
    storageSet('jarvis.voicePreferenceVersion', '2');
  }
  let history = [];
  let listening = false;
  let backgroundVoiceReady = false;
  let backgroundVoiceMessage = 'Waiting for the Windows tray listener.';
  let waitingForCommand = false;
  let speaking = false;
  let recognition = null;
  let foregroundSpeechSupported = false;
  let foregroundMicOwner = false;
  let foregroundHandoffReady = false;
  let foregroundListeningWanted = true;
  let foregroundListening = false;
  let foregroundRecognitionError = '';
  let foregroundMicStream = null;
  let foregroundMicRequest = null;
  let foregroundRecognitionStarting = false;
  let foregroundRetryDelay = 300;
  let restartTimer = null;
  let foregroundCommandTimer = null;
  let mediaStream = null;
  let toastTimer = null;
  let pending = false;
  let backgroundReplyPollInFlight = false;
  let activeSpeechAudio = null;
  let activeSpeechSource = null;
  let activeSpeechFinish = null;
  let playbackContext = null;
  let playbackUnlockPromise = null;
  let foregroundReportSequence = Date.now() * 1000;

  function toast(message, error = false) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.toggle('error', error);
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 3300);
  }

  function unlockAudioOutput() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      if (!playbackContext) playbackContext = new AudioContextClass();
      if (playbackContext.state === 'suspended') playbackUnlockPromise = playbackContext.resume().catch(() => {});
    } catch { /* Playback reports a visible error if this browser cannot unlock audio. */ }
  }

  function stopActiveSpeechAudio() {
    activeSpeechAudio?.pause();
    activeSpeechAudio = null;
    if (activeSpeechSource) {
      activeSpeechSource.onended = null;
      try { activeSpeechSource.stop(); } catch { /* The source may already have ended. */ }
      activeSpeechSource = null;
    }
  }

  function openDialog(dialog) {
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }

  function setCoreStatus(label, state = 'idle', hint = '') {
    $('#coreStatus').textContent = label;
    $('#coreDot').className = `status-dot${state === 'active' ? ' on' : state === 'warn' ? ' warn' : ''}`;
    $('.assistant-card').classList.toggle('listening', state === 'active' && listening);
    $('.assistant-card').classList.toggle('thinking', state === 'thinking');
    if (hint) $('#coreHint').textContent = hint;
  }

  function updateVoiceButton() {
    const appOwnsMic = document.visibilityState === 'visible' && foregroundMicOwner;
    listening = appOwnsMic ? foregroundListening : backgroundVoiceReady;
    const enabled = appOwnsMic ? foregroundListeningWanted : backgroundVoiceReady;
    $('#listenBtn').classList.toggle('enabled', enabled);
    $('#listenBtn').setAttribute('aria-pressed', String(enabled));
    if (appOwnsMic) {
      $('#listenLabel').textContent = !foregroundHandoffReady || foregroundRecognitionStarting ? 'CONNECTING APP MICROPHONE' : foregroundListeningWanted ? 'LISTENING IN APP' : 'APP LISTENING PAUSED';
      const hint = foregroundRecognitionError || (foregroundListening
        ? 'The open app is listening directly for “Jarvis”, sir.'
        : !foregroundHandoffReady
          ? 'The app is waiting for the tray to release the microphone.'
          : foregroundRecognitionStarting
            ? 'Connecting to the app microphone. Approve Edge’s microphone prompt if it appears, sir.'
            : foregroundListeningWanted
              ? 'The app microphone is ready and will resume after I finish speaking.'
              : 'App voice is paused. Click the microphone button to resume listening.');
      const appStatus = foregroundListening ? 'LISTENING FOR “JARVIS” IN APP' : foregroundRecognitionStarting ? 'CONNECTING MICROPHONE' : (pending || speaking) ? 'PROCESSING REQUEST' : 'APP VOICE PAUSED';
      setCoreStatus(appStatus, foregroundListening ? 'active' : foregroundRecognitionError ? 'warn' : (pending || speaking) ? 'thinking' : 'idle', hint);
    } else if (backgroundVoiceReady && document.visibilityState === 'visible') {
      $('#listenLabel').textContent = 'TRAY LISTENING';
      setCoreStatus(foregroundRecognitionError ? 'APP MICROPHONE UNAVAILABLE' : 'TRAY LISTENING FOR “JARVIS”', foregroundRecognitionError ? 'warn' : 'active', foregroundRecognitionError || 'The app could not take the microphone, so the tray listener is active. Click the microphone button to retry, sir.');
    } else if (backgroundVoiceReady) {
      $('#listenLabel').textContent = 'LISTENING IN BACKGROUND';
      setCoreStatus('LISTENING FOR “JARVIS”', 'active', 'The app is hidden; the tray listener is handling “Jarvis”, sir.');
    } else {
      $('#listenLabel').textContent = 'VOICE SETUP NEEDED';
      const hint = foregroundRecognitionError || backgroundVoiceMessage;
      setCoreStatus('VOICE LISTENER UNAVAILABLE', 'warn', hint);
    }
  }

  function updateModel() {
    $('#modelChip').textContent = 'QWEN3.5 2B LOCAL';
  }

  function addMessage(text, role, error = false) {
    $('#welcomeMessage')?.remove();
    const message = document.createElement('div');
    message.className = `message ${role}${error ? ' error' : ''}`;
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = role === 'user' ? 'YOU' : 'J.A.R.V.I.S.';
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = text;
    message.append(meta, bubble);
    chatList.append(message);
    chatList.scrollTop = chatList.scrollHeight;
    return message;
  }

  function setThinking(isThinking) {
    pending = isThinking;
    $('#chatForm').classList.toggle('busy', isThinking);
    $('#sendButton')?.toggleAttribute('disabled', isThinking);
    setCoreStatus(isThinking ? 'PROCESSING REQUEST' : (listening ? 'LISTENING FOR “JARVIS”' : 'SYSTEMS STANDING BY'), isThinking ? 'thinking' : listening ? 'active' : 'idle');
    if (isThinking) {
      const row = document.createElement('div');
      row.className = 'message ai typing-row';
      row.innerHTML = '<div class="message-meta">J.A.R.V.I.S.</div><div class="message-bubble"><span class="typing-dots">•••</span></div>';
      chatList.append(row);
      chatList.scrollTop = chatList.scrollHeight;
      return row;
    }
    resumeRecognition();
    return null;
  }

  function reportForegroundOwnership(active) {
    return fetch('/api/foreground/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active, sequence: ++foregroundReportSequence })
    }).then((response) => response.ok).catch(() => false);
  }

  async function waitForTrayRelease() {
    const reported = await reportForegroundOwnership(true);
    if (!reported) {
      if (!foregroundMicOwner) return;
      foregroundRecognitionError = 'The local voice service is unavailable, so app microphone ownership could not be coordinated.';
      foregroundSpeechSupported = false;
      setForegroundOwnership(false);
      toast(foregroundRecognitionError, true);
      return;
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (!foregroundMicOwner || document.visibilityState !== 'visible') return;
      try {
        const response = await fetch('/api/background/status', { cache: 'no-store' });
        if (!response.ok) throw new Error('Tray status is unavailable.');
        const status = await response.json();
        if (status.available !== true || status.foregroundPaused === true) {
          foregroundHandoffReady = true;
          updateVoiceButton();
          resumeRecognition();
          return;
        }
      } catch { /* Retry briefly while the tray releases the shared microphone. */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!foregroundMicOwner) return;
    foregroundRecognitionError = 'The tray did not release the microphone. Hide and reopen the app to retry the handoff.';
    foregroundSpeechSupported = false;
    setForegroundOwnership(false);
    toast(foregroundRecognitionError, true);
  }

  function setForegroundOwnership(active) {
    const next = active && foregroundSpeechSupported && document.visibilityState === 'visible';
    if (foregroundMicOwner === next) return;
    foregroundMicOwner = next;
    foregroundHandoffReady = false;
    if (next) waitForTrayRelease();
    else {
      reportForegroundOwnership(false);
      clearTimeout(restartTimer);
      try { recognition?.abort(); } catch { /* The recognizer may already be stopped. */ }
      foregroundRecognitionStarting = false;
      foregroundListening = false;
      releaseForegroundMicrophone();
    }
    updateVoiceButton();
  }

  function shouldRunForegroundRecognition() {
    return foregroundMicOwner && foregroundHandoffReady && foregroundSpeechSupported && foregroundListeningWanted && !pending && !speaking && Boolean(recognition);
  }

  function pauseForegroundRecognition() {
    clearTimeout(restartTimer);
    if (!recognition) return;
    try { recognition.stop(); } catch { /* It may already be stopping. */ }
    foregroundListening = false;
    updateVoiceButton();
  }

  function releaseForegroundMicrophone() {
    const stream = foregroundMicStream;
    foregroundMicStream = null;
    stream?.getTracks().forEach((track) => track.stop());
  }

  function microphoneErrorMessage(error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
      return 'Allow microphone access for http://127.0.0.1:48123 in Edge, then click the microphone button to retry.';
    }
    if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
      return 'No microphone is available. Connect or enable a microphone, then click the microphone button to retry.';
    }
    if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') {
      return 'Edge could not open the microphone. Close other apps using it and check Windows microphone privacy settings.';
    }
    return `The app could not connect to the microphone${error?.message ? `: ${error.message}` : '.'}`;
  }

  async function requestForegroundMicrophone() {
    const existingTrack = foregroundMicStream?.getAudioTracks().find((track) => track.readyState === 'live');
    if (existingTrack) return existingTrack;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This Edge window cannot request microphone access. Open J.A.R.V.I.S. with the current Start-JARVIS.cmd launcher.');
    }
    if (!foregroundMicRequest) {
      const request = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      foregroundMicRequest = request;
    }
    const request = foregroundMicRequest;
    try {
      const stream = await request;
      if (!foregroundMicOwner || !foregroundListeningWanted || document.visibilityState !== 'visible') {
        stream.getTracks().forEach((track) => track.stop());
        return null;
      }
      const track = stream.getAudioTracks()[0];
      if (!track) {
        stream.getTracks().forEach((item) => item.stop());
        throw new Error('No microphone audio track was returned.');
      }
      foregroundMicStream = stream;
      track.addEventListener('ended', () => {
        if (foregroundMicStream !== stream) return;
        foregroundMicStream = null;
        if (foregroundMicOwner && foregroundListeningWanted) {
          foregroundRecognitionError = 'The microphone disconnected. Reconnect it and click the microphone button to retry.';
          foregroundSpeechSupported = false;
          setForegroundOwnership(false);
          toast(foregroundRecognitionError, true);
        }
      }, { once: true });
      return track;
    } finally {
      if (foregroundMicRequest === request) foregroundMicRequest = null;
    }
  }

  function recognitionAcceptsAudioTrack() {
    const version = navigator.userAgent.match(/(?:Edg|Chrome|Chromium)\/(\d+)/i)?.[1];
    return Number(version || 0) >= 135;
  }

  function failForegroundRecognition(error) {
    foregroundRecognitionStarting = false;
    foregroundSpeechSupported = false;
    foregroundRecognitionError = error instanceof DOMException || error?.name
      ? microphoneErrorMessage(error)
      : `The app could not start speech recognition: ${error?.message || 'unknown error'}`;
    setForegroundOwnership(false);
    updateVoiceButton();
    toast(foregroundRecognitionError, true);
  }

  async function startForegroundRecognition() {
    if (!shouldRunForegroundRecognition() || foregroundRecognitionStarting || foregroundListening) return;
    foregroundRecognitionStarting = true;
    updateVoiceButton();
    let startInvoked = false;
    try {
      const track = await requestForegroundMicrophone();
      if (!track || !shouldRunForegroundRecognition() || !recognition) return;
      if (recognitionAcceptsAudioTrack()) recognition.start(track);
      else recognition.start();
      startInvoked = true;
    } catch (error) {
      if (error?.name === 'InvalidStateError') return;
      failForegroundRecognition(error);
    } finally {
      if (!startInvoked) foregroundRecognitionStarting = false;
    }
  }

  function resumeRecognition() {
    clearTimeout(restartTimer);
    if (!shouldRunForegroundRecognition() || foregroundRecognitionStarting || foregroundListening) return;
    restartTimer = setTimeout(() => {
      if (shouldRunForegroundRecognition()) startForegroundRecognition();
    }, foregroundRetryDelay);
    foregroundRetryDelay = 300;
  }

  function dispatchForegroundCommand(text) {
    Promise.resolve(handleCommand(text, 'voice'))
      .catch((error) => respond(`I could not complete that request, sir. ${error.message}`, true))
      .finally(() => resumeRecognition());
  }

  function handleForegroundTranscript(rawTranscript) {
    const transcript = String(rawTranscript || '').trim().replace(/\s+/g, ' ');
    if (!transcript || pending || speaking) return;
    if (waitingForCommand) {
      waitingForCommand = false;
      clearTimeout(foregroundCommandTimer);
      pauseForegroundRecognition();
      dispatchForegroundCommand(transcript);
      return;
    }
    const wake = transcript.match(/^(?:hey\s+)?jarvis\b[\s,.:;!?-]*(.*)$/i);
    if (!wake) return;
    pauseForegroundRecognition();
    const command = wake[1].trim();
    if (command) {
      toast('Wake phrase heard. Working on it, sir.');
      dispatchForegroundCommand(command);
      return;
    }
    waitingForCommand = true;
    foregroundCommandTimer = setTimeout(() => {
      if (!waitingForCommand) return;
      waitingForCommand = false;
      const prompt = 'I didn’t catch that, sir. Say Jarvis when you are ready.';
      addMessage(prompt, 'ai');
      speak(prompt).finally(() => resumeRecognition());
    }, 12_000);
    addMessage('Yes, sir?', 'ai');
    toast('Wake phrase heard, sir. Listening for your request.');
    speak('Yes, sir?').finally(() => resumeRecognition());
  }

  function initializeForegroundRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (typeof SpeechRecognition !== 'function') {
      foregroundSpeechSupported = false;
      foregroundRecognitionError = 'This browser does not support direct app voice recognition. The tray listener can still listen in the background.';
      setForegroundOwnership(false);
      updateVoiceButton();
      return false;
    }

    let instance;
    try { instance = new SpeechRecognition(); }
    catch (error) {
      foregroundSpeechSupported = false;
      foregroundRecognitionError = `The browser could not create a microphone listener: ${error.message}`;
      setForegroundOwnership(false);
      updateVoiceButton();
      return false;
    }
    instance.lang = 'en-GB';
    instance.continuous = true;
    instance.interimResults = false;
    instance.maxAlternatives = 1;
    instance.onstart = () => {
      if (recognition !== instance) return;
      foregroundRecognitionStarting = false;
      foregroundRecognitionError = '';
      foregroundRetryDelay = 300;
      foregroundListening = true;
      updateVoiceButton();
    };
    instance.onresult = (event) => {
      if (recognition !== instance || !foregroundMicOwner) return;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal && result[0]?.transcript) handleForegroundTranscript(result[0].transcript);
      }
    };
    instance.onerror = (event) => {
      foregroundListening = false;
      foregroundRecognitionStarting = false;
      const error = event.error || 'unknown';
      if (error === 'network') {
        foregroundRecognitionError = 'Edge speech recognition lost its network connection; retrying, sir.';
        foregroundRetryDelay = 2500;
      } else if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(error)) {
        foregroundSpeechSupported = false;
        foregroundRecognitionError = error === 'not-allowed' || error === 'service-not-allowed'
          ? 'Allow microphone access for http://127.0.0.1:48123 in Edge, then click the microphone button to retry.'
          : error === 'audio-capture'
            ? 'Edge received microphone permission but could not route audio to speech recognition. Check the selected Windows input device and close other microphone apps.'
            : `Edge speech recognition is unavailable (${error}); the tray listener can take over.`;
        setForegroundOwnership(false);
        toast(foregroundRecognitionError, true);
      }
      updateVoiceButton();
    };
    instance.onend = () => {
      if (recognition !== instance) return;
      foregroundListening = false;
      foregroundRecognitionStarting = false;
      updateVoiceButton();
      resumeRecognition();
    };
    recognition = instance;
    foregroundSpeechSupported = true;
    foregroundRecognitionError = '';
    setForegroundOwnership(document.visibilityState === 'visible');
    resumeRecognition();
    return true;
  }

  function syncForegroundVisibility() {
    const visible = document.visibilityState === 'visible';
    if (!visible) {
      clearTimeout(foregroundCommandTimer);
      waitingForCommand = false;
      setForegroundOwnership(false);
      return;
    }
    if (!recognition || !foregroundSpeechSupported) initializeForegroundRecognition();
    else setForegroundOwnership(true);
    resumeRecognition();
  }

  function startListening() {
    if (document.visibilityState !== 'visible') {
      if (backgroundVoiceReady) toast('The tray is listening for “Jarvis”. Say the wake word, then your request, sir.');
      else toast(backgroundVoiceMessage, true);
      return;
    }
    if (!foregroundSpeechSupported) {
      if (recognition) { try { recognition.abort(); } catch { /* Already stopped. */ } }
      recognition = null;
      if (!initializeForegroundRecognition()) return;
    }
    foregroundListeningWanted = true;
    setForegroundOwnership(true);
    resumeRecognition();
  }

  function stopListening() {
    if (document.visibilityState !== 'visible' || !foregroundSpeechSupported) {
      if (backgroundVoiceReady) toast('The tray listener is active. Use the tray menu to exit J.A.R.V.I.S., sir.');
      return;
    }
    foregroundListeningWanted = false;
    waitingForCommand = false;
    clearTimeout(foregroundCommandTimer);
    pauseForegroundRecognition();
    releaseForegroundMicrophone();
    setForegroundOwnership(true);
    updateVoiceButton();
  }

  function toggleForegroundListening() {
    if (document.visibilityState === 'visible' && foregroundSpeechSupported && foregroundListeningWanted) stopListening();
    else startListening();
  }

  function spokenText(text) {
    return String(text).replace(/```[\s\S]*?```/g, 'Code omitted.')
      .replace(/https?:\/\/\S+/g, 'link')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      .replace(/[`*_#>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function speak(text, force = false) {
    if ((!settings.speak && !force) || !text) return Promise.resolve(false);
    const transcript = spokenText(text);
    if (!transcript) return Promise.resolve(false);
    stopActiveSpeechAudio();
    activeSpeechFinish?.(true);
    window.speechSynthesis?.cancel();
    speaking = true;
    if (recognition && foregroundListening) pauseForegroundRecognition();

    return new Promise((resolve) => {
      let finished = false;
      let objectUrl = '';
      const warnTtsUnavailable = (reason) => {
        $('#voiceOutputStatus').textContent = `Unavailable: ${reason}`;
        $('#voiceOutputStatus').classList.add('error');
        console.warn('J.A.R.V.I.S. voice playback failed:', reason);
        toast(`Local J.A.R.V.I.S. speech is unavailable, sir. ${reason}`, true);
      };
      const finish = (success) => {
        if (finished) return;
        finished = true;
        if (activeSpeechFinish === finish) activeSpeechFinish = null;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        if (!success) stopActiveSpeechAudio();
        speaking = false;
        resumeRecognition();
        resolve(success);
      };
      activeSpeechFinish = finish;
      (async () => {
        try {
          const response = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: transcript, voiceId: settings.voiceId })
          });
          if (finished) return;
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || `Local speech returned HTTP ${response.status}.`);
          }
          const blob = await response.blob();
          if (finished) return;
          if (!blob.size) throw new Error('The local voice returned empty audio.');
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (AudioContextClass) {
            if (!playbackContext) playbackContext = new AudioContextClass();
            if (playbackContext.state !== 'running' && playbackUnlockPromise) {
              await Promise.race([playbackUnlockPromise, new Promise((resolve) => setTimeout(resolve, 600))]);
            }
            if (!playbackContext) throw new Error('This browser could not start audio playback. Try the Test J.A.R.V.I.S. Voice button in Preferences.');
            if (playbackContext.state !== 'running') throw new Error('Audio is blocked. Click the Test J.A.R.V.I.S. Voice button in Preferences to enable playback.');
            const buffer = await playbackContext.decodeAudioData(await blob.arrayBuffer());
            if (finished) return;
            const source = playbackContext.createBufferSource();
            activeSpeechSource = source;
            source.buffer = buffer;
            source.connect(playbackContext.destination);
            source.onended = () => {
              if (activeSpeechSource === source) activeSpeechSource = null;
              $('#voiceOutputStatus').textContent = 'J.A.R.V.I.S. voice is ready.';
              $('#voiceOutputStatus').classList.remove('error');
              finish(true);
            };
            $('#voiceOutputStatus').textContent = 'Playing J.A.R.V.I.S. voice…';
            $('#voiceOutputStatus').classList.remove('error');
            source.start();
          } else {
            objectUrl = URL.createObjectURL(blob);
            const audio = new Audio(objectUrl);
            activeSpeechAudio = audio;
            audio.onended = () => {
              $('#voiceOutputStatus').textContent = 'J.A.R.V.I.S. voice is ready.';
              $('#voiceOutputStatus').classList.remove('error');
              finish(true);
            };
            audio.onerror = () => {
              warnTtsUnavailable('Local audio playback failed.');
              finish(false);
            };
            $('#voiceOutputStatus').textContent = 'Playing J.A.R.V.I.S. voice…';
            await audio.play();
          }
        } catch (error) {
          if (finished) return;
          warnTtsUnavailable(error.message || 'The speech service could not be reached.');
          finish(false);
        }
      })();
    });
  }

  function respond(text, error = false) {
    addMessage(text, 'ai', error);
    if (!error) speak(text);
  }

  async function postJson(url, data) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
  }

  function normalizeApp(value) {
    const app = value.toLowerCase().replace(/[.!?]+$/g, '').trim();
    const aliases = {
      calc: 'calculator', 'the calculator': 'calculator', 'file explorer': 'explorer', 'the file explorer': 'explorer', files: 'explorer', folders: 'explorer',
      'windows explorer': 'explorer', 'text editor': 'notepad', 'the notepad': 'notepad', 'microsoft paint': 'paint',
      'the settings': 'settings', 'windows settings': 'settings', 'task manager': 'taskmanager', 'the task manager': 'taskmanager',
      'snipping tool': 'snippingtool', 'the snipping tool': 'snippingtool', snip: 'snippingtool', 'windows terminal': 'terminal', 'the terminal': 'terminal', 'the browser': 'browser', 'web browser': 'browser'
    };
    const id = aliases[app] || app;
    const labels = { calculator: 'Calculator', explorer: 'File Explorer', notepad: 'Notepad', paint: 'Paint', settings: 'Settings', taskmanager: 'Task Manager', snippingtool: 'Snipping Tool', terminal: 'Terminal', browser: 'Browser' };
    return id ? { id, label: labels[id] || value.trim() } : null;
  }

  async function launchApp(app, userText = `Open ${app.label}`) {
    addMessage(userText, 'user');
    const thinkingRow = setThinking(true);
    try {
      const result = await postJson('/api/open-app', { app: app.id });
      thinkingRow?.remove();
      setThinking(false);
      respond(`Opening ${result.label}, sir.`);
    } catch (error) {
      thinkingRow?.remove();
      setThinking(false);
      respond(error.message, true);
      toast(error.message, true);
    }
  }

  async function searchWeb(query, userText = `Search the web for ${query}`) {
    addMessage(userText, 'user');
    const thinkingRow = setThinking(true);
    try {
      await postJson('/api/search', { query });
      thinkingRow?.remove();
      setThinking(false);
      respond(`I’ve opened a web search for “${query}”, sir.`);
    } catch (error) {
      thinkingRow?.remove();
      setThinking(false);
      respond(error.message, true);
      toast(error.message, true);
    }
  }

  function cameraImage() {
    const video = $('#cameraVideo');
    if (!mediaStream || video.readyState < 2 || !video.videoWidth) return null;
    const scale = Math.min(1, 1024 / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return { data: canvas.toDataURL('image/jpeg', 0.78) };
  }

  async function askLocalModel(text, image = null) {
    addMessage(text, 'user');
    history.push({ role: 'user', text });
    const thinkingRow = setThinking(true);
    const contents = history.slice(-12).map((item) => ({ role: item.role, text: item.text }));
    try {
      const result = await postJson('/api/chat', { model: settings.model, contents, image });
      history.push({ role: 'model', text: result.answer });
      thinkingRow?.remove();
      setThinking(false);
      respond(result.answer);
    } catch (error) {
      history.pop();
      thinkingRow?.remove();
      setThinking(false);
      respond(error.message, true);
      toast(error.message, true);
    }
  }

  function setCameraState(isOn) {
    $('#cameraPreview').classList.toggle('active', isOn);
    $('#cameraState').textContent = isOn ? 'LIVE' : 'OFF';
    $('#cameraState').classList.toggle('on', isOn);
    $('#cameraToggle').classList.toggle('is-on', isOn);
    $('#cameraToggle').innerHTML = isOn ? '<span>◉</span> DISABLE CAMERA' : '<span>◎</span> ENABLE CAMERA';
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('Camera access is unavailable in this browser.', true);
      return false;
    }
    if (mediaStream) return true;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      $('#cameraVideo').srcObject = mediaStream;
      setCameraState(true);
      toast('Camera enabled. The live preview stays on this device.');
      return true;
    } catch (error) {
      mediaStream = null;
      toast(error.name === 'NotAllowedError' ? 'Allow camera access in your browser to use visual input.' : `Camera could not be opened: ${error.message}`, true);
      return false;
    }
  }

  function stopCamera() {
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    $('#cameraVideo').srcObject = null;
    setCameraState(false);
  }

  async function analyzeCamera(text, userText = text) {
    if (!mediaStream) {
      addMessage(userText, 'user');
      respond('The camera is off, sir. Enable it first, then ask me to look again.', true);
      return;
    }
    const image = cameraImage();
    if (!image) {
      toast('Camera is not ready yet. Please try again in a moment.', true);
      return;
    }
    await askLocalModel(text, image);
  }

  async function handleCommand(rawText, source = 'typed') {
    const text = rawText.trim().replace(/\s+/g, ' ');
    if (!text || pending) return;
    const commandText = text.replace(/^(?:please\s+|can you\s+|could you\s+|would you\s+)/i, '');
    if (/^(?:enable|turn on|start|open)\s+(?:the\s+)?camera\b/i.test(commandText)) {
      addMessage(rawText, 'user');
      const started = await startCamera();
      if (started) respond('Camera is on, sir. The preview is local until you ask me to inspect a still frame.');
      return;
    }
    if (/^(?:disable|turn off|stop|close)\s+(?:the\s+)?camera\b/i.test(commandText)) {
      addMessage(rawText, 'user');
      stopCamera();
      respond('Camera disabled, sir.');
      return;
    }
    if (/(?:what|tell me|describe).*(?:see|camera|looking at)|(?:look at|inspect)\s+(?:the\s+)?camera/i.test(commandText)) {
      await analyzeCamera(commandText, rawText);
      return;
    }
    const openMatch = commandText.match(/^(?:open|launch|start)\s+(.+)$/i);
    if (openMatch) {
      const app = normalizeApp(openMatch[1]);
      if (app) await launchApp(app, rawText);
      else {
        addMessage(rawText, 'user');
        respond('I could not find that app in the Windows app catalog, sir. Try using its full Start menu name.', true);
      }
      return;
    }
    const searchMatch = commandText.match(/^(?:search\s+(?:the\s+)?web(?:\s+for)?|google|look\s+up|find\s+online)\s+(.+)$/i);
    if (searchMatch) {
      await searchWeb(searchMatch[1], rawText);
      return;
    }
    if (source === 'voice' && /^(?:stop listening|go quiet|disable voice)$/i.test(text)) {
      stopListening();
      return;
    }
    await askLocalModel(rawText);
  }

  function loadSettingsToForm() {
    $('#modelSelect').value = settings.model;
    $('#speakReplies').checked = settings.speak;
    $('#jarvisVoice').value = String(settings.voiceId);
    $('#startupButton').textContent = storageGet('jarvis.startup') === 'true' ? 'DISABLE STARTUP' : 'ENABLE STARTUP';
  }

  function showSettings() {
    try {
      loadSettingsToForm();
      openDialog(settingsDialog);
      syncLocalModelStatus();
    } catch (error) {
      toast(`Preferences could not open: ${error.message}`, true);
    }
  }

  async function syncStartupState() {
    try {
      const response = await fetch('/api/startup/status');
      if (!response.ok) return;
      const state = await response.json();
      storageSet('jarvis.startup', String(Boolean(state.enabled)));
      $('#startupButton').textContent = state.enabled ? 'DISABLE STARTUP' : 'ENABLE STARTUP';
    } catch { /* The local server can still be used without reading startup state. */ }
  }

  async function syncLocalModelStatus() {
    const statusNode = $('#localModelStatus');
    if (!statusNode) return;
    statusNode.textContent = 'Checking local model…';
    statusNode.classList.remove('error');
    try {
      const response = await fetch('/api/model/status', { cache: 'no-store' });
      const status = await response.json();
      if (status.installed) {
        statusNode.textContent = 'Qwen 3.5 2B is installed. Questions run locally on this PC.';
      } else if (status.runtime) {
        statusNode.textContent = 'Ollama is running, but the model is missing. Run Setup-Local-AI.cmd.';
        statusNode.classList.add('error');
      } else {
        statusNode.textContent = 'Install Ollama, then run Setup-Local-AI.cmd to download the local model and voice.';
        statusNode.classList.add('error');
      }
    } catch {
      statusNode.textContent = 'Could not check Ollama. Run Setup-Local-AI.cmd, then check again.';
      statusNode.classList.add('error');
    }
  }

  async function syncBackgroundVoiceStatus() {
    try {
      const response = await fetch('/api/background/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('The local server could not read tray status.');
      const status = await response.json();
      backgroundVoiceReady = status.ready === true;
      backgroundVoiceMessage = status.message || (backgroundVoiceReady ? '' : 'Start the tray listener from the J.A.R.V.I.S. launcher.');
    } catch {
      backgroundVoiceReady = false;
      backgroundVoiceMessage = 'The Windows tray listener is not connected. Restart J.A.R.V.I.S. from its launcher.';
    }
    updateVoiceButton();
  }

  async function pollBackgroundSpeech() {
    if (backgroundReplyPollInFlight) return;
    backgroundReplyPollInFlight = true;
    try {
      const response = await fetch('/api/background/speech', { cache: 'no-store' });
      if (!response.ok) return;
      const reply = await response.json();
      if (!reply.pending) return;
      const handled = settings.speak ? await speak(reply.text) : false;
      await postJson('/api/background/speech/ack', { id: reply.id, handled });
    } catch { /* The tray requests local Kokoro speech if the app cannot play the reply. */ }
    finally { backgroundReplyPollInFlight = false; }
  }

  async function saveSettings() {
    settings.model = LOCAL_MODEL;
    settings.speak = $('#speakReplies').checked;
    settings.voiceId = Number($('#jarvisVoice').value);
    storageSet('jarvis.model', settings.model);
    storageSet('jarvis.speak', String(settings.speak));
    storageSet('jarvis.voiceId', String(settings.voiceId));
    let voiceSyncWarning = '';
    try { await postJson('/api/voice/preference', { voiceId: settings.voiceId }); }
    catch (error) { voiceSyncWarning = `Voice saved for this window, sir. Background voice could not be updated: ${error.message}`; }
    updateModel();
    closeDialog(settingsDialog);
    toast(voiceSyncWarning || 'Preferences saved, sir.', Boolean(voiceSyncWarning));
  }
  function updateClock() {
    const now = new Date();
    $('#clock').textContent = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  }

  $('#listenBtn').addEventListener('click', toggleForegroundListening);
  $('#composerMic').addEventListener('click', () => { unlockAudioOutput(); startListening(); });
  document.addEventListener('pointerdown', unlockAudioOutput, { once: true, capture: true });
  document.addEventListener('keydown', unlockAudioOutput, { once: true, capture: true });
  $('#typeBtn').addEventListener('click', () => messageInput.focus());
  $('#openSettings').addEventListener('click', showSettings);
  $('#topSettings').addEventListener('click', showSettings);
  $('#backgroundButton').addEventListener('click', async () => {
    try {
      await postJson('/api/background/hide', {});
      toast('J.A.R.V.I.S. is hidden. Use its tray icon to bring it back.');
    } catch (error) {
      toast(error.message, true);
    }
  });
  $('#saveSettings').addEventListener('click', saveSettings);
  $('#testVoice').addEventListener('click', () => {
    unlockAudioOutput();
    settings.voiceId = Number($('#jarvisVoice').value);
    storageSet('jarvis.voiceId', String(settings.voiceId));
    speak('Good evening, sir. All systems are online and ready.', true);
  });
  $('#checkLocalAI').addEventListener('click', syncLocalModelStatus);
  $('#wakeInfo').addEventListener('click', () => openDialog(infoDialog));
  $('#closeInfo').addEventListener('click', () => closeDialog(infoDialog));
  $('#clearChat').addEventListener('click', () => {
    history = [];
    chatList.replaceChildren();
    chatList.innerHTML = '<div class="welcome-message" id="welcomeMessage"><span class="welcome-mark">✧</span><div><strong>Ready when you are, sir.</strong><p>Ask a question, launch an app, or search the web. I’ll take it from here.</p></div></div>';
    toast('Conversation cleared.');
  });

  $('#chatForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    unlockAudioOutput();
    if (pending) return;
    const text = messageInput.value.trim();
    if (!text) return;
    messageInput.value = '';
    await handleCommand(text);
  });

  $('#launchList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-app]');
    if (button) {
      const app = normalizeApp(button.dataset.app);
      if (app) launchApp(app);
    }
  });

  $('#cameraNav').addEventListener('click', () => $('#cameraCard').scrollIntoView({ behavior: 'smooth', block: 'center' }));
  $('#cameraToggle').addEventListener('click', () => mediaStream ? stopCamera() : startCamera());
  $('#cameraCapture').addEventListener('click', () => analyzeCamera('Describe what you can see in this camera image.'));
  document.querySelectorAll('.example-command').forEach((button) => button.addEventListener('click', () => {
    messageInput.value = button.dataset.prompt;
    messageInput.focus();
  }));

  $('#startupButton').addEventListener('click', async () => {
    const enabled = storageGet('jarvis.startup') === 'true';
    if (enabled && !confirm('Remove JARVIS from Windows startup?')) return;
    if (!enabled && !confirm('Add JARVIS to your personal Windows Startup folder? It will open when you sign in.')) return;
    try {
      await postJson('/api/startup', { action: enabled ? 'disable' : 'enable' });
      storageSet('jarvis.startup', String(!enabled));
      $('#startupButton').textContent = enabled ? 'ENABLE STARTUP' : 'DISABLE STARTUP';
      toast(enabled ? 'JARVIS removed from startup.' : 'JARVIS will start when you sign in.');
    } catch (error) {
      toast(error.message, true);
    }
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === ',') {
      event.preventDefault();
      showSettings();
    }
    if (event.key === 'Escape' && document.visibilityState === 'visible' && foregroundMicOwner && foregroundListeningWanted && !settingsDialog.open && !infoDialog.open) stopListening();
  });

  document.addEventListener('visibilitychange', syncForegroundVisibility);
  window.addEventListener('pagehide', () => {
    foregroundListeningWanted = false;
    foregroundMicOwner = false;
    foregroundListening = false;
    clearTimeout(restartTimer);
    clearTimeout(foregroundCommandTimer);
    waitingForCommand = false;
    reportForegroundOwnership(false);
    try { recognition?.abort(); } catch { /* The recognizer may already be stopped. */ }
    releaseForegroundMicrophone();
  });
  window.addEventListener('beforeunload', () => {
    foregroundListeningWanted = false;
    foregroundMicOwner = false;
    foregroundListening = false;
    clearTimeout(restartTimer);
    clearTimeout(foregroundCommandTimer);
    waitingForCommand = false;
    reportForegroundOwnership(false);
    try { recognition?.abort(); } catch { /* The recognizer may already be stopped. */ }
    releaseForegroundMicrophone();
    stopCamera();
  });

  window.jarvisAppReady = true;
  postJson('/api/voice/preference', { voiceId: settings.voiceId }).catch(() => {});
  updateModel();
  syncForegroundVisibility();
  updateVoiceButton();
  setInterval(() => reportForegroundOwnership(foregroundMicOwner), 1500);
  syncBackgroundVoiceStatus();
  setInterval(syncBackgroundVoiceStatus, 4000);
  pollBackgroundSpeech();
  setInterval(pollBackgroundSpeech, 750);
  syncLocalModelStatus();
  syncStartupState();
  updateClock();
  setInterval(updateClock, 15_000);
})();
