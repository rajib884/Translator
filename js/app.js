// UI glue + lifecycle. Mobile-first; the same DOM becomes a desktop sidebar via CSS.
//
// Session model: every translation pipeline (client + audio capture + TTS player +
// transcript + status + config snapshot) lives inside a Session object. Each
// session owns its own tab chip and transcript DOM; the chrome (status pill,
// meters, age, control bar, settings panel) reflects whichever session is
// currently `state.activeSessionId`. A global TTSCoordinator serializes TTS
// playback across all running sessions.

const LANGUAGES = [
  ['en', 'English'],
  ['zh', 'Chinese (Mandarin)'],
  ['bn', 'Bangla'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['ar', 'Arabic'],
  ['hi', 'Hindi'],
  ['pt', 'Portuguese'],
];

const MAX_TURNS = 50;
const MAX_LOG = 200;
const STORAGE_KEY = 'live-translator-prefs';
const SESSIONS_KEY = 'live-translator-sessions';

// Voice-activity-detection presets. Hand-tuned for translation use: the model
// shouldn't jump in mid-sentence, so we lean towards LOW end-sensitivity and
// longer silence by default. "Patient" is the answer to "model talks too soon".
const VAD_PRESETS = {
  quick:    { startSensitivity: 'HIGH', endSensitivity: 'HIGH', prefixPaddingMs: 100, silenceDurationMs: 400 },
  balanced: { startSensitivity: 'HIGH', endSensitivity: 'LOW',  prefixPaddingMs: 200, silenceDurationMs: 800 },
  patient:  { startSensitivity: 'LOW',  endSensitivity: 'LOW',  prefixPaddingMs: 300, silenceDurationMs: 1800 },
};
const DEFAULT_VAD_PRESET = 'balanced';
const COMPANION_HTTP_URL = 'http://127.0.0.1:52341';
const COMPANION_WS_URL = 'ws://127.0.0.1:52341/audio';

const $ = (id) => document.getElementById(id);

const els = {
  apiKey:        $('api-key'),
  btnShowKey:    $('btn-show-key'),
  langSource:    $('lang-source'),
  langTarget:    $('lang-target'),
  voice:         $('voice'),
  audioInput:    $('audio-input'),
  audioInputHint:$('audio-input-hint'),
  audioSource:   $('audio-source'),
  audioHint:     $('audio-source-hint'),
  companionApp:      $('companion-app'),
  companionAppField: $('companion-app-field'),
  companionAppHint:  $('companion-app-hint'),
  btnRefreshApps:    $('btn-refresh-apps'),
  audioOutput:   $('audio-output'),
  audioOutputHint:$('audio-output-hint'),
  modeSelect:    $('mode-select'),
  dirSelect:     $('dir-select'),
  dirField:      $('dir-field'),
  vadPreset:     $('vad-preset'),
  vadStart:      $('vad-start'),
  vadEnd:        $('vad-end'),
  vadPrefix:     $('vad-prefix'),
  vadSilence:    $('vad-silence'),
  btnSwap:       $('btn-swap'),
  btnStart:      $('btn-start'),
  btnStop:       $('btn-stop'),
  btnHush:       $('btn-hush'),
  btnPause:      $('btn-pause'),
  btnClear:      $('btn-clear'),
  btnMenu:       $('btn-menu'),
  btnLog:        $('btn-log'),
  btnPip:        $('btn-pip'),
  btnPipQuick:   $('btn-pip-quick'),
  btnEditPrompt: $('btn-edit-prompt'),
  btnSavePrompt: $('btn-save-prompt'),
  btnResetPrompt:$('btn-reset-prompt'),
  promptText:    $('prompt-text'),
  sidebar:       $('sidebar'),
  promptSheet:   $('prompt-sheet'),
  logSheet:      $('log-sheet'),
  statusPill:    $('status-pill'),
  statusText:    $('status-text'),
  sessionAge:    $('session-age'),
  tabList:       $('tab-list'),
  btnNewSession: $('btn-new-session'),
  turnsHost:     $('turns-host'),
  modeSwitch:    $('mode-switch'),
  micMeter:      $('mic-meter'),
  outMeter:      $('out-meter'),
  log:           $('log'),
};

// ─── Session ─────────────────────────────────────────────────────────────────
class Session {
  constructor({ id, config }) {
    this.id = id;
    this.config = config;          // snapshot, mutable while idle

    // Runtime objects, allocated by startSession, torn down by stopSession.
    this.client = null;            // GeminiLiveClient
    this.capture = null;           // AudioCapture | CompanionAudioCapture
    this.player = null;            // TTSPlayer | null (text/transcribe modes)

    this.running = false;
    this.paused = false;
    this.status = 'idle';

    // Audio source actually in use (may differ from config if a fallback fired).
    this.currentAudioMode = '';

    // Wall-clock when the session connected; drives the age display.
    this.startedAt = 0;
    this.ageTimer = 0;

    // Live transcript bookkeeping.
    this.liveTurn = null;
    this.pendingInput = '';
    this.pendingOutput = '';
    this.pendingScheduled = false;

    // DOM owned by this session.
    this.tabEl = null;             // .tab-chip
    this.transcriptEl = null;      // .session-turns
  }

  get isAudio() { return this.config.mode === 'audio'; }
}

// ─── TTS coordinator ─────────────────────────────────────────────────────────
// Sessions translate concurrently but must not all speak at once. This owns a
// global "who is speaking" slot and a queue. While a session is queued or
// actively speaking, its capture is gated to silence so the model doesn't pick
// up another turn from real audio (and doesn't loop back its own output).
class TTSCoordinator {
  constructor() {
    this.currentSpeakerId = null;
    this.queue = [];                 // session ids waiting in FIFO order
    this.entries = new Map();        // id -> { session, player, buffered, wantsToSpeak, turnComplete }
  }

  register(session, player) {
    if (!player) return;
    const entry = {
      session,
      player,
      buffered: [],
      wantsToSpeak: false,
      turnComplete: false,
    };
    this.entries.set(session.id, entry);

    const userOnActive = player.onActiveChange;
    player.onActiveChange = (active) => {
      if (userOnActive) { try { userOnActive(active); } catch (_) {} }
      if (!active && this.currentSpeakerId === session.id) {
        this._maybeFinishSpeaking(session.id);
      }
    };
  }

  unregister(session) {
    const id = session.id;
    this.entries.delete(id);
    this.queue = this.queue.filter((sid) => sid !== id);
    if (this.currentSpeakerId === id) {
      this.currentSpeakerId = null;
      this._tryStartNext();
    }
    session.muteInput = false;
  }

  enqueueChunk(session, b64) {
    const entry = this.entries.get(session.id);
    if (!entry) return;
    if (!entry.wantsToSpeak) {
      entry.wantsToSpeak = true;
      entry.turnComplete = false;
      session.muteInput = true;
      this._requestSpeak(session.id);
    }
    if (this.currentSpeakerId === session.id) {
      entry.player.playChunk(b64);
    } else {
      entry.buffered.push(b64);
    }
  }

  markTurnComplete(session) {
    const entry = this.entries.get(session.id);
    if (!entry || !entry.wantsToSpeak) return;
    entry.turnComplete = true;
    if (this.currentSpeakerId === session.id) {
      this._maybeFinishSpeaking(session.id);
    }
  }

  hush(session) {
    const entry = this.entries.get(session.id);
    if (!entry) return;
    try { entry.player.hush(); } catch (_) {}
    entry.buffered.length = 0;
    entry.wantsToSpeak = false;
    entry.turnComplete = false;
    session.muteInput = false;
    if (this.currentSpeakerId === session.id) {
      this.currentSpeakerId = null;
      this._tryStartNext();
    } else {
      this.queue = this.queue.filter((sid) => sid !== session.id);
    }
  }

  _requestSpeak(sessionId) {
    if (!this.currentSpeakerId) {
      this.currentSpeakerId = sessionId;
    } else if (!this.queue.includes(sessionId)) {
      this.queue.push(sessionId);
    }
  }

  _maybeFinishSpeaking(sessionId) {
    const entry = this.entries.get(sessionId);
    if (!entry || !entry.turnComplete) return;
    if (entry.player.isActive()) return;
    entry.wantsToSpeak = false;
    entry.turnComplete = false;
    entry.session.muteInput = false;
    this.currentSpeakerId = null;
    this._tryStartNext();
  }

  _tryStartNext() {
    if (this.currentSpeakerId) return;
    while (this.queue.length) {
      const nextId = this.queue.shift();
      const entry = this.entries.get(nextId);
      if (!entry) continue;
      this.currentSpeakerId = nextId;
      const buf = entry.buffered;
      entry.buffered = [];
      for (const b64 of buf) entry.player.playChunk(b64);
      if (entry.turnComplete) this._maybeFinishSpeaking(nextId);
      return;
    }
  }
}

const state = {
  sessions: new Map(),
  activeSessionId: null,
  ttsCoordinator: new TTSCoordinator(),

  // 'simple' hides the tab strip and advanced settings sections; 'advanced'
  // shows everything. Sessions and configs are unaffected — flipping back to
  // advanced reveals all existing tabs untouched.
  uiMode: 'simple',

  // Truly global UI state.
  pip: null,
  systemPromptTemplate: null,
  companionAvailable: false,
  companionApps: [],
};

function setUIMode(mode) {
  if (mode !== 'simple' && mode !== 'advanced') mode = 'simple';
  state.uiMode = mode;
  document.body.dataset.uiMode = mode;
  if (els.modeSwitch) {
    for (const btn of els.modeSwitch.querySelectorAll('.mode-opt')) {
      const isThis = btn.dataset.uiMode === mode;
      btn.classList.toggle('is-active', isThis);
      btn.setAttribute('aria-pressed', isThis ? 'true' : 'false');
    }
  }
  savePrefs();
}

function activeSession() {
  return state.activeSessionId ? state.sessions.get(state.activeSessionId) || null : null;
}

function isActive(session) {
  return !!session && session.id === state.activeSessionId;
}

function readConfigFromUI() {
  return {
    source: els.langSource.value,
    target: els.langTarget.value,
    voice:  els.voice.value,
    mode:   els.modeSelect.value,
    dir:    els.dirSelect.value,
    vad:    currentVadConfig(),
    audioSource:    els.audioSource.value || 'mic',
    micDeviceId:    els.audioInput.value || '',
    outputDeviceId: els.audioOutput.value || '',
    companionApp:   els.companionApp ? els.companionApp.value : '',
  };
}

function newSessionId() {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── Per-session DOM ─────────────────────────────────────────────────────────
function createSessionDOM(session) {
  const chip = document.createElement('div');
  chip.className = 'tab-chip';
  chip.dataset.sessionId = session.id;
  chip.dataset.status = session.status;
  chip.setAttribute('role', 'tab');
  chip.innerHTML =
    '<span class="tab-status-dot" aria-hidden="true"></span>' +
    '<span class="tab-label"></span>' +
    '<span class="tab-close" role="button" aria-label="Close session" title="Close session">×</span>';
  els.tabList.appendChild(chip);
  session.tabEl = chip;
  updateTabChip(session);

  const turns = document.createElement('div');
  turns.className = 'session-turns';
  turns.dataset.sessionId = session.id;
  els.turnsHost.appendChild(turns);
  session.transcriptEl = turns;
  renderSessionEmptyState(session);
}

function updateTabChip(session) {
  if (!session.tabEl) return;
  const cfg = session.config;
  const sym = cfg.mode === 'transcribe' ? '·' : (cfg.dir === 'oneway' ? '→' : '↔');
  const label = `${cfg.source.toUpperCase()} ${sym} ${cfg.target.toUpperCase()}`;
  const labelEl = session.tabEl.querySelector('.tab-label');
  if (labelEl) labelEl.textContent = label;
  session.tabEl.dataset.status = session.status;
  session.tabEl.title = `${langName(cfg.source)} → ${langName(cfg.target)}`;
}

function renderSessionEmptyState(session) {
  if (!session.transcriptEl) return;
  session.transcriptEl.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.innerHTML =
    '<div class="empty-icon" aria-hidden="true">' +
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>' +
        '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>' +
        '<line x1="12" y1="19" x2="12" y2="23"/>' +
        '<line x1="8" y1="23" x2="16" y2="23"/>' +
      '</svg>' +
    '</div>' +
    '<p>Press <strong>Start</strong> and speak.<br/>Your words appear on one side, the translation on the other.</p>' +
    '<p class="hint">First, open <button class="link-btn" data-empty-action="open-settings" type="button">Settings</button> and paste your Gemini API key.</p>';
  session.transcriptEl.appendChild(empty);
}

function removeSessionEmptyState(session) {
  if (!session.transcriptEl) return;
  const empty = session.transcriptEl.querySelector(':scope > .empty-state');
  if (empty) empty.remove();
}

// ─── Active session switching ────────────────────────────────────────────────
function setActiveSession(id) {
  if (!state.sessions.has(id)) return;
  if (state.activeSessionId === id) return;

  const prev = activeSession();
  if (prev) {
    if (prev.tabEl) prev.tabEl.classList.remove('is-active');
    if (prev.transcriptEl) prev.transcriptEl.classList.remove('is-active');
  }
  state.activeSessionId = id;
  const next = state.sessions.get(id);
  if (next.tabEl) next.tabEl.classList.add('is-active');
  if (next.transcriptEl) next.transcriptEl.classList.add('is-active');

  loadSessionConfigIntoUI(next);
  applySessionStatusToChrome(next);
  applyControlButtonsForActiveSession();
  els.sessionAge.textContent = next.startedAt
    ? fmtDuration(Date.now() - next.startedAt)
    : '00:00';
  // Meters reset on switch — they'll re-fill from the new session's level
  // callbacks on the next audio frame.
  setMeter(els.micMeter, 0);
  setMeter(els.outMeter, 0);

  saveSessions();
}

function loadSessionConfigIntoUI(session) {
  const cfg = session.config;
  els.langSource.value = cfg.source;
  els.langTarget.value = cfg.target;
  els.voice.value = cfg.voice;
  els.modeSelect.value = cfg.mode;
  els.dirSelect.value = cfg.dir;
  els.audioSource.value = cfg.audioSource;
  // dataset.preferred is what refreshAudioInputDevices/OutputDevices fall back
  // to when the saved deviceId isn't in the current device list yet (devices
  // can take a moment to enumerate). Without this, an async refresh after a
  // tab switch would reset the dropdown to the global pref rather than the
  // active session's preference.
  els.audioInput.value = cfg.micDeviceId;
  els.audioInput.dataset.preferred = cfg.micDeviceId;
  els.audioOutput.value = cfg.outputDeviceId;
  els.audioOutput.dataset.preferred = cfg.outputDeviceId;
  if (els.companionApp) {
    els.companionApp.value = cfg.companionApp || '';
    els.companionApp.dataset.preferred = cfg.companionApp || '';
  }
  els.vadStart.value = cfg.vad.startSensitivity;
  els.vadEnd.value = cfg.vad.endSensitivity;
  els.vadPrefix.value = String(cfg.vad.prefixPaddingMs);
  els.vadSilence.value = String(cfg.vad.silenceDurationMs);
  els.vadPreset.value = detectVadPreset();
  updateDirVisibility();
  updateCompanionAppVisibility();
}

// Called whenever a settings input changes. Saves the snapshot as global
// "default for new sessions" prefs, and writes through to the active session's
// config so it picks up the change at the next Start.
function onSettingsChange() {
  savePrefs();
  const session = activeSession();
  if (!session) return;
  session.config = readConfigFromUI();
  updateTabChip(session);
  saveSessions();
}

function createNewSession({ activate = true } = {}) {
  const session = new Session({ id: newSessionId(), config: readConfigFromUI() });
  state.sessions.set(session.id, session);
  createSessionDOM(session);
  saveSessions();
  if (activate) {
    state.activeSessionId = null;     // force setActiveSession to apply
    setActiveSession(session.id);
  }
  return session;
}

async function closeSession(session) {
  if (!session) return;
  if (session.running) {
    if (!window.confirm('This session is running. Stop it and remove?')) return;
    await stopSession(session);
  }
  if (session.tabEl) session.tabEl.remove();
  if (session.transcriptEl) session.transcriptEl.remove();
  state.sessions.delete(session.id);

  if (state.activeSessionId === session.id) {
    state.activeSessionId = null;
    const next = state.sessions.values().next().value;
    if (next) {
      setActiveSession(next.id);
    } else {
      // No sessions left — create a fresh default from current UI state.
      createNewSession({ activate: true });
    }
  } else {
    saveSessions();
  }
}

// ─── Persistence (sessions) ──────────────────────────────────────────────────
function saveSessions() {
  try {
    const arr = [...state.sessions.values()].map((s) => ({
      id: s.id,
      config: s.config,
    }));
    localStorage.setItem(SESSIONS_KEY, JSON.stringify({
      sessions: arr,
      activeId: state.activeSessionId,
    }));
  } catch (_) {}
}

function loadSavedSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.sessions)) return null;
    return data;
  } catch (_) { return null; }
}

function restoreSessionsFromStorage() {
  const data = loadSavedSessions();
  if (!data || data.sessions.length === 0) {
    createNewSession({ activate: true });
    return;
  }
  // Use the current UI snapshot as a fallback for any missing config fields,
  // then overlay the saved per-session config.
  const fallback = readConfigFromUI();
  for (const entry of data.sessions) {
    const cfg = Object.assign({}, fallback, entry.config || {});
    cfg.vad = Object.assign({}, fallback.vad, (entry.config && entry.config.vad) || {});
    const session = new Session({
      id: entry.id || newSessionId(),
      config: cfg,
    });
    state.sessions.set(session.id, session);
    createSessionDOM(session);
  }
  const wantActive = data.activeId && state.sessions.has(data.activeId)
    ? data.activeId
    : state.sessions.keys().next().value;
  state.activeSessionId = null;
  setActiveSession(wantActive);
}

// ─── Prefs (global UI defaults) ──────────────────────────────────────────────
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch (_) { return {}; }
}
function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      apiKey: els.apiKey.value,
      source: els.langSource.value,
      target: els.langTarget.value,
      voice:  els.voice.value,
      input:  els.audioInput.value,
      audio:  els.audioSource.value,
      output: els.audioOutput.value,
      mode:   els.modeSelect.value,
      dir:    els.dirSelect.value,
      promptTemplate: state.systemPromptTemplate || '',
      companionApp: els.companionApp ? els.companionApp.value : '',
      vadPreset:   els.vadPreset ? els.vadPreset.value : DEFAULT_VAD_PRESET,
      vadStart:    els.vadStart ? els.vadStart.value : '',
      vadEnd:      els.vadEnd ? els.vadEnd.value : '',
      vadPrefix:   els.vadPrefix ? Number(els.vadPrefix.value) : null,
      vadSilence:  els.vadSilence ? Number(els.vadSilence.value) : null,
      uiMode:      state.uiMode || 'simple',
    }));
  } catch (_) {}
}

function langName(code) {
  for (const [c, n] of LANGUAGES) if (c === code) return n;
  return code;
}

// ─── System prompt resolution ────────────────────────────────────────────────
function isBuiltinPromptTemplate(t) {
  return t === GeminiLive.DEFAULT_SYSTEM_PROMPT_TEMPLATE ||
         t === GeminiLive.ONE_WAY_SYSTEM_PROMPT_TEMPLATE ||
         t === GeminiLive.TRANSCRIBE_SYSTEM_PROMPT_TEMPLATE;
}

function modeDefaultTemplate(mode, dir) {
  if (mode === 'transcribe') return GeminiLive.TRANSCRIBE_SYSTEM_PROMPT_TEMPLATE;
  if (dir === 'oneway')      return GeminiLive.ONE_WAY_SYSTEM_PROMPT_TEMPLATE;
  return GeminiLive.DEFAULT_SYSTEM_PROMPT_TEMPLATE;
}

function effectivePromptTemplateFor(mode, dir) {
  const custom = state.systemPromptTemplate;
  if (custom && !isBuiltinPromptTemplate(custom)) return custom;
  return modeDefaultTemplate(mode, dir);
}
function effectivePromptTemplate() {
  return effectivePromptTemplateFor(els.modeSelect.value, els.dirSelect.value);
}

function modeDescriptiveLabel() {
  const mode = els.modeSelect.value;
  if (mode === 'transcribe') return 'Transcribe only';
  const dirLabel = els.dirSelect.value === 'oneway' ? 'one-way →' : 'both ways ↔';
  const fmt = mode === 'text' ? 'text only' : 'voice + text';
  return `Translate (${fmt}, ${dirLabel})`;
}

function updateDirVisibility() {
  els.dirField.style.display = els.modeSelect.value === 'transcribe' ? 'none' : '';
}

// ─── VAD preset / advanced fields ────────────────────────────────────────────
function applyVadPreset(name) {
  const preset = VAD_PRESETS[name];
  if (!preset) return;
  els.vadStart.value = preset.startSensitivity;
  els.vadEnd.value = preset.endSensitivity;
  els.vadPrefix.value = String(preset.prefixPaddingMs);
  els.vadSilence.value = String(preset.silenceDurationMs);
}

function currentVadConfig() {
  const prefix = Math.max(0, Math.min(2000, Number(els.vadPrefix.value) || 0));
  const silence = Math.max(100, Math.min(5000, Number(els.vadSilence.value) || 800));
  return {
    startSensitivity: els.vadStart.value === 'LOW' ? 'LOW' : 'HIGH',
    endSensitivity:   els.vadEnd.value === 'HIGH' ? 'HIGH' : 'LOW',
    prefixPaddingMs:   prefix,
    silenceDurationMs: silence,
  };
}

function vadConfigMatchesPreset(name) {
  const preset = VAD_PRESETS[name];
  if (!preset) return false;
  const cur = currentVadConfig();
  return cur.startSensitivity === preset.startSensitivity &&
         cur.endSensitivity === preset.endSensitivity &&
         cur.prefixPaddingMs === preset.prefixPaddingMs &&
         cur.silenceDurationMs === preset.silenceDurationMs;
}

function detectVadPreset() {
  for (const name of Object.keys(VAD_PRESETS)) {
    if (vadConfigMatchesPreset(name)) return name;
  }
  return 'custom';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function updateAudioSourceAvailability() {
  for (const opt of els.audioSource.options) {
    if (opt.value === 'display') {
      opt.disabled = !LiveAudio.canCaptureDisplayAudio();
    } else if (opt.value === 'companion') {
      opt.disabled = !state.companionAvailable;
    }
  }
  if (els.audioSource.selectedOptions[0]?.disabled) {
    els.audioSource.value = 'mic';
  }

  if (!LiveAudio.canCaptureDisplayAudio() && !state.companionAvailable) {
    els.audioHint.textContent = 'App audio capture is unavailable. Start the companion service or use Chrome/Edge tab audio.';
  } else if (state.companionAvailable) {
    els.audioHint.textContent = 'Companion app detected. Use it for background app audio without screen sharing.';
  } else if (!LiveAudio.canCaptureDisplayAudio()) {
    els.audioHint.textContent = 'Browser app audio capture is unsupported here. Start the companion service to use app audio.';
  } else {
    els.audioHint.textContent = 'Default microphone. Use app/tab audio in Chrome/Edge, or Companion app audio when the local service is running.';
  }
  updateCompanionAppVisibility();
}

async function detectCompanionService({ silent = true } = {}) {
  try {
    const res = await fetchWithTimeout(`${COMPANION_HTTP_URL}/status`, {
      mode: 'cors',
      cache: 'no-store',
      headers: { 'X-Live-Translator': 'status' },
    }, 600);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    state.companionAvailable = data && data.status === 'ok';
  } catch (e) {
    state.companionAvailable = false;
    if (!silent) log('warn', 'Companion service unavailable: ' + (e && e.message ? e.message : e));
  }
  updateAudioSourceAvailability();
  if (state.companionAvailable && els.companionApp) {
    refreshCompanionApps({ silent: true });
  }
  return state.companionAvailable;
}

async function fetchCompanionApps() {
  const res = await fetchWithTimeout(`${COMPANION_HTTP_URL}/apps`, {
    mode: 'cors',
    cache: 'no-store',
    headers: { 'X-Live-Translator': 'apps' },
  }, 1500);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = await res.json();
  return Array.isArray(data && data.apps) ? data.apps : [];
}

async function refreshCompanionApps({ silent = true } = {}) {
  if (!els.companionApp) return;
  try {
    const apps = await fetchCompanionApps();
    apps.sort((a, b) =>
      (a.displayName || a.name || '').localeCompare(b.displayName || b.name || '', undefined, { sensitivity: 'base' })
    );
    state.companionApps = apps;

    const preferred = els.companionApp.value ||
                      els.companionApp.dataset.preferred || '';
    const frag = document.createDocumentFragment();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'All system audio';
    frag.appendChild(def);
    for (const app of apps) {
      const opt = document.createElement('option');
      opt.value = app.name;
      const display = app.displayName && app.displayName !== app.name
        ? `${app.displayName} (${app.name})`
        : app.name;
      opt.textContent = display;
      frag.appendChild(opt);
    }
    els.companionApp.innerHTML = '';
    els.companionApp.appendChild(frag);

    const stillThere = apps.some((a) => a.name === preferred);
    els.companionApp.value = stillThere ? preferred : '';
    els.companionApp.dataset.preferred = els.companionApp.value;

    if (els.companionAppHint) {
      els.companionAppHint.textContent = apps.length
        ? 'Pick an app. Refresh ↻ after starting playback in a new app.'
        : 'No app is making sound right now. Start playback, then refresh ↻.';
    }
    if (!silent) log('info', `Companion: found ${apps.length} app${apps.length === 1 ? '' : 's'} with active audio.`);
  } catch (e) {
    if (!silent) log('warn', 'Could not list companion apps: ' + (e && e.message ? e.message : e));
    if (els.companionAppHint) {
      els.companionAppHint.textContent = 'Could not reach the companion service.';
    }
  }
}

function updateCompanionAppVisibility() {
  if (!els.companionAppField) return;
  const show = els.audioSource.value === 'companion' && state.companionAvailable;
  els.companionAppField.style.display = show ? '' : 'none';
}

function fillLanguages() {
  const frag1 = document.createDocumentFragment();
  const frag2 = document.createDocumentFragment();
  for (const [code, name] of LANGUAGES) {
    const o1 = document.createElement('option');
    o1.value = code; o1.textContent = name; frag1.appendChild(o1);
    const o2 = document.createElement('option');
    o2.value = code; o2.textContent = name; frag2.appendChild(o2);
  }
  els.langSource.appendChild(frag1);
  els.langTarget.appendChild(frag2);

  const prefs = loadPrefs();
  els.apiKey.value      = prefs.apiKey || '';
  els.langSource.value  = prefs.source || 'en';
  els.langTarget.value  = prefs.target || 'zh';
  els.voice.value       = prefs.voice  || 'Zephyr';
  els.audioInput.dataset.preferred = prefs.input || '';
  els.audioInput.value  = prefs.input  || '';
  els.audioSource.value = prefs.audio  || 'mic';
  els.audioOutput.dataset.preferred = prefs.output || '';
  els.audioOutput.value = prefs.output || '';
  if (els.companionApp) {
    els.companionApp.dataset.preferred = prefs.companionApp || '';
    els.companionApp.value = prefs.companionApp || '';
  }

  const savedPreset = prefs.vadPreset && (VAD_PRESETS[prefs.vadPreset] || prefs.vadPreset === 'custom')
    ? prefs.vadPreset : DEFAULT_VAD_PRESET;
  els.vadPreset.value = savedPreset;
  applyVadPreset(savedPreset === 'custom' ? DEFAULT_VAD_PRESET : savedPreset);
  if (prefs.vadStart === 'HIGH' || prefs.vadStart === 'LOW') els.vadStart.value = prefs.vadStart;
  if (prefs.vadEnd === 'HIGH' || prefs.vadEnd === 'LOW')     els.vadEnd.value   = prefs.vadEnd;
  if (Number.isFinite(prefs.vadPrefix))  els.vadPrefix.value = String(prefs.vadPrefix);
  if (Number.isFinite(prefs.vadSilence)) els.vadSilence.value = String(prefs.vadSilence);
  if (savedPreset !== 'custom') {
    els.vadPreset.value = vadConfigMatchesPreset(savedPreset) ? savedPreset : 'custom';
  }
  els.modeSelect.value  = prefs.mode   || 'audio';
  els.dirSelect.value   = prefs.dir    || 'bidir';
  state.systemPromptTemplate = prefs.promptTemplate || null;
  setUIMode(prefs.uiMode === 'advanced' ? 'advanced' : 'simple');

  const urlKey = new URLSearchParams(location.search).get('api');
  if (urlKey) {
    els.apiKey.value = urlKey;
    const url = new URL(location.href);
    url.searchParams.delete('api');
    history.replaceState(null, '', url.toString());
    savePrefs();
    log('info', 'API key loaded from URL and saved locally.');
  }

  if (els.langSource.value === els.langTarget.value) {
    els.langTarget.value = els.langSource.value === 'en' ? 'es' : 'en';
  }

  updateDirVisibility();
  updateAudioSourceAvailability();

  updateAudioInputSupport();
  updateAudioOutputSupport();
}

function updateAudioInputSupport() {
  if (!els.audioInput) return;
  const supported = !!(navigator.mediaDevices &&
                       navigator.mediaDevices.getUserMedia &&
                       navigator.mediaDevices.enumerateDevices);
  els.audioInput.disabled = !supported;
  if (!supported) {
    els.audioInputHint.textContent = 'This browser does not allow web apps to choose a microphone.';
  }
}

function updateAudioOutputSupport() {
  if (!els.audioOutput) return;
  const canSelect = LiveAudio.canSelectOutputDevice && LiveAudio.canSelectOutputDevice();
  const canList = !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices);
  const supported = canSelect && canList;
  els.audioOutput.disabled = !supported;
  if (!supported) {
    els.audioOutputHint.textContent = 'This browser does not allow web apps to choose a speaker.';
  }
}

function inputDeviceLabel(device, index) {
  if (device.label) return device.label;
  if (device.deviceId === 'default') return 'System default';
  if (device.deviceId === 'communications') return 'Communications default';
  return `Microphone ${index + 1}`;
}

function outputDeviceLabel(device, index) {
  if (device.label) return device.label;
  if (device.deviceId === 'default') return 'System default';
  if (device.deviceId === 'communications') return 'Communications default';
  return `Speaker ${index + 1}`;
}

async function refreshAudioInputDevices() {
  if (!els.audioInput || els.audioInput.disabled) return;
  try {
    const selected = els.audioInput.value || els.audioInput.dataset.preferred || '';
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const seen = new Set();
    const frag = document.createDocumentFragment();

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'System default';
    frag.appendChild(defaultOpt);
    seen.add('');

    inputs.forEach((device, index) => {
      const id = device.deviceId || '';
      if (id === 'default') return;
      if (seen.has(id)) return;
      seen.add(id);
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = inputDeviceLabel(device, index);
      frag.appendChild(opt);
    });

    els.audioInput.innerHTML = '';
    els.audioInput.appendChild(frag);
    els.audioInput.value = seen.has(selected) ? selected : '';
    els.audioInput.dataset.preferred = els.audioInput.value;

    if (inputs.length) {
      const hasLabels = inputs.some((d) => d.label);
      els.audioInputHint.textContent = hasLabels
        ? 'Changes apply immediately; Mic + app audio asks you to pick app audio again.'
        : 'Device names may appear after microphone permission.';
    } else {
      els.audioInputHint.textContent = 'No microphones were reported by this browser.';
    }
    savePrefs();
  } catch (e) {
    els.audioInput.disabled = true;
    els.audioInputHint.textContent = 'Could not read microphone devices.';
    log('warn', 'Microphone devices unavailable: ' + (e && e.message ? e.message : e));
  }
}

async function refreshAudioOutputDevices() {
  if (!els.audioOutput || els.audioOutput.disabled) return;
  try {
    const selected = els.audioOutput.value || els.audioOutput.dataset.preferred || '';
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    const seen = new Set();
    const frag = document.createDocumentFragment();

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'System default';
    frag.appendChild(defaultOpt);
    seen.add('');

    outputs.forEach((device, index) => {
      const id = device.deviceId || '';
      if (id === 'default') return;
      if (seen.has(id)) return;
      seen.add(id);
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = outputDeviceLabel(device, index);
      frag.appendChild(opt);
    });

    els.audioOutput.innerHTML = '';
    els.audioOutput.appendChild(frag);
    els.audioOutput.value = seen.has(selected) ? selected : '';
    els.audioOutput.dataset.preferred = els.audioOutput.value;

    if (outputs.length) {
      const hasLabels = outputs.some((d) => d.label);
      els.audioOutputHint.textContent = hasLabels
        ? 'Changes apply immediately to translated speech when supported by the browser.'
        : 'Device names may appear after microphone permission.';
    } else {
      els.audioOutputHint.textContent = 'No speaker devices were reported by this browser.';
    }
    savePrefs();
  } catch (e) {
    els.audioOutput.disabled = true;
    els.audioOutputHint.textContent = 'Could not read audio output devices.';
    log('warn', 'Audio output devices unavailable: ' + (e && e.message ? e.message : e));
  }
}

async function changeAudioOutput() {
  els.audioOutput.dataset.preferred = els.audioOutput.value;
  onSettingsChange();
  const session = activeSession();
  if (!session || !session.player) return;
  try {
    await session.player.setOutputDevice(els.audioOutput.value);
    log('info', 'Audio output changed: ' + (els.audioOutput.selectedOptions[0]?.textContent || 'System default'));
  } catch (e) {
    log('error', 'Audio output change failed: ' + (e && e.message ? e.message : e));
    await refreshAudioOutputDevices();
  }
}

// ─── Per-session capture/player factories ────────────────────────────────────
function sendAudioGated(session, buf) {
  if (!session.client || session.paused) return;
  if (session.muteInput) {
    session.client.sendAudio(new ArrayBuffer(buf.byteLength));
  } else {
    session.client.sendAudio(buf);
  }
}

function createAudioCapture(session) {
  return new LiveAudio.AudioCapture({
    onChunk: (buf) => sendAudioGated(session, buf),
    onLevel: (l) => setMicLevelFor(session, l),
    onDisplayEnded: () => {
      log('warn', 'App audio share ended by the browser.');
      stopSession(session);
    },
  });
}

function createCompanionCapture(session) {
  return new LiveAudio.CompanionAudioCapture({
    onChunk: (buf) => sendAudioGated(session, buf),
    onLevel: (l) => setMicLevelFor(session, l),
    onDisplayEnded: () => {
      if (!session.running) return;
      log('warn', 'Companion audio service disconnected.');
      stopSession(session);
    },
  });
}

async function changeAudioInput() {
  els.audioInput.dataset.preferred = els.audioInput.value;
  onSettingsChange();
  const session = activeSession();
  if (!session || !session.running) return;

  const audioMode = session.currentAudioMode || session.config.audioSource || 'mic';
  if (audioMode === 'display' || audioMode === 'companion') {
    log('info', 'Microphone changed; it will apply when microphone input is used.');
    return;
  }

  try {
    if (audioMode === 'both') {
      log('info', 'Pick the app/tab audio again to switch microphones.');
    }
    const nextCapture = createAudioCapture(session);
    await nextCapture.start({ mode: audioMode, micDeviceId: session.config.micDeviceId });
    try { session.capture && session.capture.stop(); } catch (_) {}
    session.capture = nextCapture;
    await refreshAudioInputDevices();
    log('info', 'Microphone changed: ' + (els.audioInput.selectedOptions[0]?.textContent || 'System default'));
  } catch (e) {
    log('error', 'Microphone change failed: ' + (e && e.message ? e.message : e));
    await refreshAudioInputDevices();
  }
}

// ─── Status pill ──────────────────────────────────────────────────────────────
const STATUS_MAP = {
  idle:         ['pill-idle',         'Idle'],
  connecting:   ['pill-connecting',   'Connecting'],
  connected:    ['pill-listening',    'Listening'],
  translating:  ['pill-translating',  'Speaking'],
  reconnecting: ['pill-reconnecting', 'Reconnect'],
  error:        ['pill-error',        'Error'],
};

function setSessionStatus(session, s) {
  session.status = s;
  if (session.tabEl) session.tabEl.dataset.status = s;
  if (isActive(session)) applySessionStatusToChrome(session);
}

function applySessionStatusToChrome(session) {
  const s = session ? session.status : 'idle';
  const [cls, text] = STATUS_MAP[s] || STATUS_MAP.idle;
  els.statusPill.className = 'pill ' + cls;
  els.statusText.textContent = text;
  if (state.pip) state.pip.setStatus(text, s === 'translating' || s === 'connected');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function log(level, message) {
  const line = document.createElement('div');
  line.className = 'log-line ' + level;
  const ts = new Date().toLocaleTimeString();
  const tsEl = document.createElement('span'); tsEl.className = 'ts'; tsEl.textContent = ts;
  const lvEl = document.createElement('span'); lvEl.className = 'level'; lvEl.textContent = level.toUpperCase();
  const msEl = document.createElement('span'); msEl.className = 'msg'; msEl.textContent = message;
  line.appendChild(tsEl); line.appendChild(lvEl); line.appendChild(msEl);
  els.log.appendChild(line);
  while (els.log.children.length > MAX_LOG) els.log.removeChild(els.log.firstChild);
  els.log.scrollTop = els.log.scrollHeight;
}

// ─── Streaming transcripts: batch chunks per rAF ──────────────────────────────
function scheduleFlush(session) {
  if (session.pendingScheduled) return;
  session.pendingScheduled = true;
  requestAnimationFrame(() => flushPending(session));
}

function flushPending(session) {
  session.pendingScheduled = false;
  if (!session.pendingInput && !session.pendingOutput) return;
  const t = ensureLiveTurn(session);
  if (!t) return;
  if (session.pendingInput) {
    if (t.inputText === '') {
      t.inputEl.classList.remove('empty');
      t.inputEl.firstChild.nodeValue = '';
      t.inputCaret.style.display = '';
    }
    t.inputText += session.pendingInput;
    t.inputEl.firstChild.nodeValue = t.inputText;
    session.pendingInput = '';
    if (state.pip && isActive(session)) state.pip.setInput(t.inputText);
  }
  if (session.pendingOutput) {
    if (t.outputEl) {
      if (t.outputText === '') {
        t.outputEl.classList.remove('empty');
        t.outputEl.firstChild.nodeValue = '';
        if (t.outputCaret) t.outputCaret.style.display = '';
      }
      t.outputText += session.pendingOutput;
      t.outputEl.firstChild.nodeValue = t.outputText;
      if (state.pip && isActive(session)) state.pip.setOutput(t.outputText);
    }
    session.pendingOutput = '';
  }
  if (session.transcriptEl) {
    session.transcriptEl.scrollTop = session.transcriptEl.scrollHeight;
  }
}

function ensureLiveTurn(session) {
  if (session.liveTurn) return session.liveTurn;
  const host = session.transcriptEl;
  if (!host) return null;
  removeSessionEmptyState(session);

  const isTranscribe = session.config.mode === 'transcribe';

  const root = document.createElement('div');
  root.className = 'turn live' + (isTranscribe ? ' turn-single' : '');

  const inRow = document.createElement('div');
  inRow.className = 'turn-row input';
  const inLab = document.createElement('span');
  inLab.className = 'turn-label';
  inLab.textContent = '🎙 ' + langName(session.config.source);
  const inText = document.createElement('span');
  inText.className = 'turn-text empty';
  inText.appendChild(document.createTextNode('listening…'));
  const inCaret = document.createElement('span'); inCaret.className = 'caret'; inCaret.style.display = 'none';
  inText.appendChild(inCaret);
  inRow.appendChild(inLab); inRow.appendChild(inText);

  let outText = null, outCaret = null;
  if (!isTranscribe) {
    const outRow = document.createElement('div');
    outRow.className = 'turn-row output';
    const outLab = document.createElement('span');
    outLab.className = 'turn-label';
    outLab.textContent = '→ ' + langName(session.config.target);
    outText = document.createElement('span');
    outText.className = 'turn-text empty';
    outText.appendChild(document.createTextNode('…'));
    outCaret = document.createElement('span'); outCaret.className = 'caret'; outCaret.style.display = 'none';
    outText.appendChild(outCaret);
    outRow.appendChild(outLab); outRow.appendChild(outText);
    root.appendChild(inRow); root.appendChild(outRow);
  } else {
    root.appendChild(inRow);
  }

  host.appendChild(root);

  while (host.children.length > MAX_TURNS) {
    host.removeChild(host.firstChild);
  }

  session.liveTurn = {
    root,
    inputEl: inText,
    outputEl: outText,
    inputCaret: inCaret,
    outputCaret: outCaret,
    inputText: '',
    outputText: '',
  };

  if (state.pip && isActive(session)) {
    state.pip.setLangs(langName(session.config.source), langName(session.config.target));
    state.pip.setInput('');
    state.pip.setOutput('');
  }
  return session.liveTurn;
}

function appendInputFor(session, chunk)  { session.pendingInput  += chunk; scheduleFlush(session); }
function appendOutputFor(session, chunk) { session.pendingOutput += chunk; scheduleFlush(session); }

function finalizeTurn(session) {
  flushPending(session);
  if (!session.liveTurn) return;
  const t = session.liveTurn;
  t.inputCaret.remove();
  if (t.outputCaret) t.outputCaret.remove();
  if (!t.inputText.trim())  { t.inputEl.classList.add('empty');  t.inputEl.firstChild.nodeValue = '(silence)'; }
  if (t.outputEl && !t.outputText.trim()) { t.outputEl.classList.add('empty'); t.outputEl.firstChild.nodeValue = '(no translation)'; }
  t.root.classList.remove('live');
  session.liveTurn = null;
}

function setMeter(el, level) {
  const pct = level <= 0 ? 0 : Math.min(100, Math.sqrt(level) * 110);
  el.style.width = pct + '%';
}

function setMicLevelFor(session, level) {
  if (isActive(session)) setMeter(els.micMeter, level);
}
function setOutLevelFor(session, level) {
  if (isActive(session)) setMeter(els.outMeter, level);
}

// ─── Control-bar state ───────────────────────────────────────────────────────
function applyControlButtonsForActiveSession() {
  const session = activeSession();
  if (!session) {
    els.btnStart.disabled = true;
    els.btnStop.disabled = true;
    els.btnHush.disabled = true;
    els.btnPause.disabled = true;
    els.btnPause.classList.remove('is-paused');
    els.btnPause.title = 'Pause mic';
    setControlsLocked(false);
    return;
  }
  els.btnStart.disabled = session.running;
  els.btnStop.disabled = !session.running;
  els.btnHush.disabled = !session.running || !session.isAudio;
  els.btnPause.disabled = !session.running;
  els.btnPause.classList.toggle('is-paused', !!session.paused);
  els.btnPause.title = session.paused ? 'Resume mic' : 'Pause mic';
  setControlsLocked(session.running);
}

// ─── Pipeline ────────────────────────────────────────────────────────────────
async function startPipeline() {
  let session = activeSession();
  if (!session) return;
  if (session.running) return;
  // Re-snapshot the UI in case the user edited fields without changing the
  // active session (defensive — onSettingsChange should already have synced).
  session.config = readConfigFromUI();
  await startSession(session);
}

async function startSession(session) {
  if (session.running) return;

  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    openSheet('sidebar');
    log('error', 'Paste your Gemini API key first.');
    els.apiKey.focus();
    return;
  }
  const cfg = session.config;
  if (cfg.source === cfg.target) {
    log('error', 'Source and target languages must differ.');
    return;
  }
  savePrefs();

  const isAudio = cfg.mode === 'audio';

  setSessionStatus(session, 'connecting');
  // Eagerly disable Start while the pipeline negotiates so a double-click
  // doesn't fire a second startSession. session.running flips true after
  // session.client.start() succeeds.
  if (isActive(session)) {
    els.btnStart.disabled = true;
    els.btnStop.disabled = false;
    els.btnHush.disabled = !isAudio;
    setControlsLocked(true);
  }

  if (isAudio) {
    session.player = new LiveAudio.TTSPlayer({
      outputDeviceId: cfg.outputDeviceId,
      onLevel: (l) => setOutLevelFor(session, l),
      onActiveChange: (active) => {
        const s = session.client && session.client.state;
        if (s === 'connected') {
          setSessionStatus(session, active ? 'translating' : 'connected');
        }
      },
    });
    state.ttsCoordinator.register(session, session.player);
  } else {
    session.player = null;
  }

  const systemInstruction = GeminiLive.renderSystemPrompt(
    effectivePromptTemplateFor(cfg.mode, cfg.dir),
    langName(cfg.source), langName(cfg.target));

  session.client = new GeminiLive.GeminiLiveClient({
    apiKey,
    voice: cfg.voice,
    systemInstruction,
    vad: cfg.vad,
    useOutputTranscription: cfg.mode !== 'transcribe',
    onAudio: isAudio ? (b64) => state.ttsCoordinator.enqueueChunk(session, b64) : () => {},
    onInputChunk:  (chunk) => appendInputFor(session, chunk),
    onOutputChunk: cfg.mode !== 'transcribe' ? (chunk) => appendOutputFor(session, chunk) : () => {},
    onTurnComplete: () => {
      if (isAudio) state.ttsCoordinator.markTurnComplete(session);
      finalizeTurn(session);
    },
    onState: (s) => {
      if (s === 'connected') {
        setSessionStatus(session,
          isAudio && session.player && session.player.isActive() ? 'translating' : 'connected');
      } else {
        setSessionStatus(session, s);
      }
    },
    onLog: log,
  });

  try {
    if (isAudio) await session.player.ensureCtx();
    const audioMode = cfg.audioSource || 'mic';
    if (audioMode === 'companion') {
      if (!state.companionAvailable && !(await detectCompanionService({ silent: false }))) {
        throw new Error('Companion audio service is not running.');
      }
      const selectedExe = cfg.companionApp;
      let pid = 0;
      if (selectedExe) {
        try { await refreshCompanionApps({ silent: true }); } catch (_) {}
        const match = state.companionApps.find((a) => a.name === selectedExe);
        if (match) pid = match.pid;
        else throw new Error(`"${selectedExe}" is no longer making sound. Start playback in it and try again.`);
      }
      const wsUrl = pid ? `${COMPANION_WS_URL}?pid=${pid}` : COMPANION_WS_URL;
      session.capture = createCompanionCapture(session);
      await session.capture.start({ wsUrl });
    } else {
      session.capture = createAudioCapture(session);
      await session.capture.start({ mode: audioMode, micDeviceId: cfg.micDeviceId });
    }
    session.currentAudioMode = audioMode;
    await refreshAudioInputDevices();
    await refreshAudioOutputDevices();
    const sourceLabels = {mic:'microphone', display:'browser app audio', companion:'companion app audio', both:'mic + app audio'};
    let sourceLog = sourceLabels[audioMode] || audioMode;
    if (audioMode === 'companion' && cfg.companionApp) {
      const opt = els.companionApp ? els.companionApp.selectedOptions[0] : null;
      const label = opt ? opt.textContent : cfg.companionApp;
      sourceLog = `companion app audio (${label})`;
    }
    log('info', 'Audio source: ' + sourceLog);
  } catch (e) {
    log('error', 'Audio error: ' + (e && e.message ? e.message : e));
    await stopSession(session);
    return;
  }

  session.client.start();
  session.running = true;
  session.paused = false;
  if (isActive(session)) applyControlButtonsForActiveSession();

  session.startedAt = Date.now();
  if (session.ageTimer) clearInterval(session.ageTimer);
  session.ageTimer = setInterval(() => {
    if (isActive(session)) {
      els.sessionAge.textContent = fmtDuration(Date.now() - session.startedAt);
    }
  }, 1000);

  const dirLabel = cfg.dir === 'oneway' ? '→' : '⇄';
  const modeLabel = cfg.mode !== 'audio' ? ` (${cfg.mode === 'text' ? 'text only' : 'transcribe'})` : '';
  log('info', `Session started: ${langName(cfg.source)} ${dirLabel} ${langName(cfg.target)}${modeLabel}`);
}

async function stopPipeline() {
  const session = activeSession();
  if (!session) return;
  await stopSession(session);
}

async function stopSession(session) {
  state.ttsCoordinator.unregister(session);
  try { session.client && session.client.stop(); } catch (_) {}
  try { session.capture && session.capture.stop(); } catch (_) {}
  try { session.player && session.player.destroy(); } catch (_) {}
  session.client = null;
  session.capture = null;
  session.player = null;
  session.currentAudioMode = '';
  session.running = false;
  session.paused = false;
  if (session.ageTimer) { clearInterval(session.ageTimer); session.ageTimer = 0; }
  finalizeTurn(session);
  setSessionStatus(session, 'idle');
  if (isActive(session)) {
    applyControlButtonsForActiveSession();
    els.sessionAge.textContent = '00:00';
    setMeter(els.micMeter, 0);
    setMeter(els.outMeter, 0);
  }
}

function setControlsLocked(locked) {
  els.langSource.disabled    = locked;
  els.langTarget.disabled    = locked;
  els.voice.disabled         = locked;
  els.audioSource.disabled   = locked;
  els.apiKey.disabled        = locked;
  els.btnSwap.disabled       = locked;
  els.modeSelect.disabled    = locked;
  els.dirSelect.disabled     = locked;
  els.vadPreset.disabled     = locked;
  els.vadStart.disabled      = locked;
  els.vadEnd.disabled        = locked;
  els.vadPrefix.disabled     = locked;
  els.vadSilence.disabled    = locked;
}

function togglePause() {
  const session = activeSession();
  if (!session || !session.running) return;
  session.paused = !session.paused;
  els.btnPause.classList.toggle('is-paused', session.paused);
  els.btnPause.title = session.paused ? 'Resume mic' : 'Pause mic';
  if (session.paused) state.ttsCoordinator.hush(session);
  log('info', session.paused ? 'Mic paused.' : 'Mic resumed.');
}

// ─── Sheets ──────────────────────────────────────────────────────────────────
function openSheet(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('is-open');
}
function closeSheet(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('is-open');
}

function clearConversation() {
  const session = activeSession();
  if (!session) return;
  session.liveTurn = null;
  if (session.transcriptEl) {
    session.transcriptEl.innerHTML = '';
    renderSessionEmptyState(session);
  }
  if (state.pip) { state.pip.setInput(''); state.pip.setOutput(''); }
}

// ─── System prompt editor ────────────────────────────────────────────────────
function openPromptEditor() {
  els.promptText.value = effectivePromptTemplate();
  const lab = document.getElementById('prompt-mode-label');
  if (lab) lab.textContent = modeDescriptiveLabel();
  openSheet('prompt-sheet');
}
function savePromptEditor() {
  const v = els.promptText.value.trim();
  state.systemPromptTemplate = (v && !isBuiltinPromptTemplate(v)) ? v : null;
  savePrefs();
  closeSheet('prompt-sheet');
  log('info', state.systemPromptTemplate
        ? 'System prompt updated (takes effect on next Start).'
        : 'System prompt reset — using default for the current mode.');
}
function resetPromptEditor() {
  els.promptText.value = modeDefaultTemplate(els.modeSelect.value, els.dirSelect.value);
}

// ─── Picture-in-Picture ──────────────────────────────────────────────────────
class PipController {
  constructor() {
    this.win = null;
    this.statusEl = null;
    this.dotEl = null;
    this.inputLabelEl = null;
    this.outputLabelEl = null;
    this.inputEl = null;
    this.outputEl = null;
    this._currentInput = '';
    this._currentOutput = '';
    this._currentStatus = 'Idle';
    this._currentLive = false;
    this._inLang = '';
    this._outLang = '';
    this.onClose = () => {};
  }

  static isDocPipSupported() {
    return 'documentPictureInPicture' in window;
  }

  isOpen() { return !!(this.win && !this.win.closed); }

  async open() {
    if (this.isOpen()) { try { this.win.focus(); } catch (_) {} return; }
    if (PipController.isDocPipSupported()) {
      this.win = await window.documentPictureInPicture.requestWindow({
        width: 460, height: 300,
      });
    } else {
      this.win = window.open('', 'live-translator-pip',
        'width=460,height=300,resizable=yes,scrollbars=yes,noopener=no');
      if (!this.win) throw new Error('Popup blocked. Allow popups for this site.');
    }
    this._setup();
    this.win.addEventListener('pagehide', () => this._cleanup());
    if (this.win.document) this.win.document.title = 'Live Translator';
  }

  _setup() {
    const doc = this.win.document;
    doc.documentElement.lang = 'en';
    const style = doc.createElement('style');
    style.textContent = `
      html, body {
        margin: 0; height: 100%;
        background: #0b0d12; color: #e8ecf3;
        font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
        display: flex; flex-direction: column; overflow: hidden;
      }
      header {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 14px; border-bottom: 1px solid #1c2230;
        background: #11141b; flex: 0 0 auto;
      }
      .pip-pill {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 10px; border-radius: 999px;
        font-size: 11px; font-weight: 600;
        background: #1d2230;
      }
      .pip-dot { width: 6px; height: 6px; border-radius: 50%; background: #6b7488; }
      .pip-dot.live { background: #7c9cff; animation: p 0.8s infinite; }
      @keyframes p { 0%,100%{ opacity:1; } 50%{ opacity:0.4; } }
      .pip-brand { font-weight: 600; font-size: 13px; }
      main {
        flex: 1; padding: 14px 16px; overflow-y: auto;
        display: flex; flex-direction: column; gap: 12px;
      }
      .pip-label {
        font-size: 10px; font-weight: 700; letter-spacing: 0.6px;
        text-transform: uppercase; color: #6b7488; margin-bottom: 4px;
      }
      .pip-input-lab { color: #7c9cff; }
      .pip-output-lab { color: #a78bfa; }
      .pip-input { font-size: 15px; color: #aab2c4; line-height: 1.45; word-wrap: break-word; }
      .pip-output { font-size: 20px; font-weight: 500; line-height: 1.4; word-wrap: break-word; }
      .pip-empty { color: #6b7488; font-style: italic; }
    `;
    doc.head.appendChild(style);
    doc.body.innerHTML = `
      <header>
        <span aria-hidden="true">🌐</span>
        <span class="pip-brand">Translator</span>
        <span style="flex:1"></span>
        <span class="pip-pill"><span class="pip-dot" id="pipdot"></span><span id="pipstatus">Idle</span></span>
      </header>
      <main>
        <div>
          <div class="pip-label pip-input-lab" id="pipinlab">You</div>
          <div class="pip-input pip-empty" id="pipin">—</div>
        </div>
        <div>
          <div class="pip-label pip-output-lab" id="pipoutlab">Translation</div>
          <div class="pip-output pip-empty" id="pipout">—</div>
        </div>
      </main>
    `;
    this.statusEl = doc.getElementById('pipstatus');
    this.dotEl = doc.getElementById('pipdot');
    this.inputLabelEl = doc.getElementById('pipinlab');
    this.outputLabelEl = doc.getElementById('pipoutlab');
    this.inputEl = doc.getElementById('pipin');
    this.outputEl = doc.getElementById('pipout');

    this.setStatus(this._currentStatus, this._currentLive);
    if (this._inLang) this.setLangs(this._inLang, this._outLang);
    this.setInput(this._currentInput);
    this.setOutput(this._currentOutput);
  }

  setStatus(text, live) {
    this._currentStatus = text;
    this._currentLive = !!live;
    if (this.statusEl) this.statusEl.textContent = text;
    if (this.dotEl) this.dotEl.classList.toggle('live', !!live);
  }

  setLangs(inLang, outLang) {
    this._inLang = inLang; this._outLang = outLang;
    if (this.inputLabelEl) this.inputLabelEl.textContent = '🎙 ' + inLang;
    if (this.outputLabelEl) this.outputLabelEl.textContent = '→ ' + outLang;
  }

  setInput(text) {
    this._currentInput = text;
    if (!this.inputEl) return;
    if (text) {
      this.inputEl.classList.remove('pip-empty');
      this.inputEl.textContent = text;
    } else {
      this.inputEl.classList.add('pip-empty');
      this.inputEl.textContent = '—';
    }
  }

  setOutput(text) {
    this._currentOutput = text;
    if (!this.outputEl) return;
    if (text) {
      this.outputEl.classList.remove('pip-empty');
      this.outputEl.textContent = text;
    } else {
      this.outputEl.classList.add('pip-empty');
      this.outputEl.textContent = '—';
    }
  }

  _cleanup() {
    this.win = null;
    this.statusEl = this.dotEl = null;
    this.inputEl = this.outputEl = null;
    this.inputLabelEl = this.outputLabelEl = null;
    this.onClose();
  }

  close() {
    if (this.win) { try { this.win.close(); } catch (_) {} }
    this._cleanup();
  }
}

async function togglePip() {
  if (state.pip && state.pip.isOpen()) {
    state.pip.close();
    return;
  }
  const pip = new PipController();
  try {
    await pip.open();
  } catch (e) {
    log('error', 'Pop out failed: ' + (e && e.message ? e.message : e));
    return;
  }
  state.pip = pip;
  pip.onClose = () => { if (state.pip === pip) state.pip = null; };

  const session = activeSession();
  pip.setStatus(els.statusText.textContent, els.statusPill.classList.contains('pill-translating')
                                              || els.statusPill.classList.contains('pill-listening'));
  if (session) {
    pip.setLangs(langName(session.config.source), langName(session.config.target));
  } else {
    pip.setLangs(langName(els.langSource.value), langName(els.langTarget.value));
  }
  if (session && session.liveTurn) {
    pip.setInput(session.liveTurn.inputText);
    pip.setOutput(session.liveTurn.outputText);
  } else if (session && session.transcriptEl) {
    const last = session.transcriptEl.querySelector('.turn:last-child');
    if (last) {
      const it = last.querySelector('.turn-row.input .turn-text');
      const ot = last.querySelector('.turn-row.output .turn-text');
      pip.setInput(it && !it.classList.contains('empty') ? it.textContent : '');
      pip.setOutput(ot && !ot.classList.contains('empty') ? ot.textContent : '');
    }
  }
  log('info', PipController.isDocPipSupported() ? 'Pop-out window opened.' : 'Pop-out (popup fallback) opened.');
}

// ─── Wire UI ─────────────────────────────────────────────────────────────────
function wireUI() {
  els.btnStart.addEventListener('click', startPipeline);
  els.btnStop.addEventListener('click', stopPipeline);
  els.btnPause.addEventListener('click', togglePause);
  els.btnHush.addEventListener('click', () => {
    const session = activeSession();
    if (session) state.ttsCoordinator.hush(session);
    log('info', 'Playback hushed');
  });
  els.btnClear.addEventListener('click', clearConversation);
  els.btnSwap.addEventListener('click', () => {
    const a = els.langSource.value;
    els.langSource.value = els.langTarget.value;
    els.langTarget.value = a;
    onSettingsChange();
  });
  els.btnShowKey.addEventListener('click', () => {
    els.apiKey.type = els.apiKey.type === 'password' ? 'text' : 'password';
  });
  els.modeSelect.addEventListener('change', () => {
    updateDirVisibility();
    onSettingsChange();
  });
  els.vadPreset.addEventListener('change', () => {
    if (els.vadPreset.value !== 'custom') applyVadPreset(els.vadPreset.value);
    onSettingsChange();
  });
  for (const el of [els.vadStart, els.vadEnd, els.vadPrefix, els.vadSilence]) {
    el.addEventListener('change', () => {
      els.vadPreset.value = detectVadPreset();
      onSettingsChange();
    });
  }
  els.audioSource.addEventListener('change', () => {
    if (els.audioSource.value === 'companion') detectCompanionService({ silent: false });
    updateCompanionAppVisibility();
    onSettingsChange();
  });
  if (els.companionApp) {
    els.companionApp.addEventListener('change', () => {
      els.companionApp.dataset.preferred = els.companionApp.value;
      onSettingsChange();
    });
  }
  if (els.btnRefreshApps) {
    els.btnRefreshApps.addEventListener('click', () => refreshCompanionApps({ silent: false }));
  }
  for (const sel of [els.langSource, els.langTarget, els.voice, els.dirSelect]) {
    sel.addEventListener('change', onSettingsChange);
  }
  els.audioInput.addEventListener('change', changeAudioInput);
  els.audioOutput.addEventListener('change', changeAudioOutput);
  // API key is global, not per-session — savePrefs only.
  els.apiKey.addEventListener('change', savePrefs);

  els.btnMenu.addEventListener('click', () => openSheet('sidebar'));
  els.btnLog.addEventListener('click', () => openSheet('log-sheet'));
  els.btnEditPrompt.addEventListener('click', openPromptEditor);
  els.btnSavePrompt.addEventListener('click', savePromptEditor);
  els.btnResetPrompt.addEventListener('click', resetPromptEditor);
  els.btnPip.addEventListener('click', togglePip);
  els.btnPipQuick.addEventListener('click', togglePip);

  // Simple/Advanced toggle.
  if (els.modeSwitch) {
    els.modeSwitch.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.mode-opt');
      if (!btn) return;
      setUIMode(btn.dataset.uiMode);
    });
  }

  // Tabs: + to add, click chip to activate, click × to close.
  if (els.btnNewSession) {
    els.btnNewSession.addEventListener('click', () => createNewSession({ activate: true }));
  }
  if (els.tabList) {
    els.tabList.addEventListener('click', (ev) => {
      const close = ev.target.closest('.tab-close');
      if (close) {
        const chip = close.closest('.tab-chip');
        if (chip) closeSession(state.sessions.get(chip.dataset.sessionId));
        ev.stopPropagation();
        return;
      }
      const chip = ev.target.closest('.tab-chip');
      if (chip) setActiveSession(chip.dataset.sessionId);
    });
  }

  // Empty-state "Settings" button is created dynamically per session — use
  // event delegation so we don't re-bind on every render.
  if (els.turnsHost) {
    els.turnsHost.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-empty-action="open-settings"]')) {
        openSheet('sidebar');
      }
    });
  }

  // Generic sheet close handlers
  document.addEventListener('click', (ev) => {
    const tgt = ev.target.closest('[data-close]');
    if (tgt) closeSheet(tgt.getAttribute('data-close'));
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      closeSheet('sidebar');
      closeSheet('prompt-sheet');
      closeSheet('log-sheet');
    }
  });

  window.addEventListener('beforeunload', () => {
    for (const session of state.sessions.values()) {
      if (session.running) {
        try { session.client && session.client.stop(); } catch (_) {}
        try { session.capture && session.capture.stop(); } catch (_) {}
        try { session.player && session.player.destroy(); } catch (_) {}
      }
    }
    if (state.pip) state.pip.close();
  });
  window.addEventListener('focus', () => detectCompanionService());

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      refreshAudioInputDevices();
      refreshAudioOutputDevices();
    });
  }
}

function checkSupport() {
  const missing = [];
  if (!window.WebSocket) missing.push('WebSocket');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) missing.push('getUserMedia');
  if (!(window.AudioContext || window.webkitAudioContext)) missing.push('AudioContext');
  if (!window.AudioWorkletNode) missing.push('AudioWorklet');
  if (missing.length) {
    log('error', 'Browser missing required APIs: ' + missing.join(', '));
    els.btnStart.disabled = true;
    return false;
  }
  if (location.protocol === 'http:' &&
      location.hostname !== 'localhost' &&
      location.hostname !== '127.0.0.1') {
    log('warn', 'Microphone needs HTTPS, localhost, or file://.');
  }
  if (!PipController.isDocPipSupported()) {
    log('info', 'Native PiP unavailable here — Pop out will use a regular popup window.');
  }
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  fillLanguages();
  wireUI();
  restoreSessionsFromStorage();
  detectCompanionService();
  refreshAudioInputDevices();
  refreshAudioOutputDevices();
  if (checkSupport()) log('info', 'Ready.');
});
