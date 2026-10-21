(() => {
  const get = (key, fallback = '') => {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  };
  const set = (key, value) => {
    try { localStorage.setItem(key, value); } catch { /* The settings dialog can still be used for this session. */ }
  };
  const dialog = () => document.querySelector('#settingsDialog');
  const openSettings = () => {
    const panel = dialog();
    if (!panel || panel.open) return;
    try {
      if (typeof panel.showModal === 'function') panel.showModal();
      else panel.setAttribute('open', '');
    } catch {
      panel.setAttribute('open', '');
    }
  };
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#openSettings, #topSettings')) return;
    event.preventDefault();
    openSettings();
    if (window.jarvisAppReady) return;
    const model = document.querySelector('#modelSelect');
    const speak = document.querySelector('#speakReplies');
    if (model) model.value = 'qwen3.5:2b';
    if (speak) speak.checked = get('jarvis.speak', 'true') !== 'false';
    const button = document.querySelector('#startupButton');
    if (button) button.textContent = get('jarvis.startup') === 'true' ? 'DISABLE STARTUP' : 'ENABLE STARTUP';
  }, true);

  document.addEventListener('click', async (event) => {
    if (!event.target.closest('#saveSettings') || window.jarvisAppReady) return;
    event.preventDefault();
    set('jarvis.speak', String(document.querySelector('#speakReplies')?.checked !== false));
    const panel = dialog();
    if (typeof panel?.close === 'function' && panel.open) panel.close();
    else panel?.removeAttribute('open');
  }, true);
})();
