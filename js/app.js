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
// Multi-session is meant for the occasional power user juggling a couple of
// translations. Past 3 the audio coordinator queues up too far behind real
// time and the tab strip gets cluttered on narrow screens.
const MAX_SESSIONS = 3;
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
const COMPANION_PTT_URL = 'ws://127.0.0.1:52341/hotkey';

// All user-facing hint strings live here so a content review can read the
// whole vocabulary in one place. Some hints depend on multiple state inputs
// (e.g. audio source availability) and are expressed as small selectors that
// take those inputs and return a string.
const HINTS = {
  mode: {
    audio:      'Translates speech into both text and spoken audio.',
    text:       'Translates speech into text only (spoken audio discarded).',
    transcribe: 'Transcribes speech into text in the same language (no translation).',
  },
  dir: {
    bidir:  'Translates both your speech and the other person\'s speech.',
    oneway: 'Translates only your speech (useful for broadcasts).',
  },
  speechMode(mode, companionOk) {
    if (!companionOk) return 'Push to talk needs the companion app running.';
    if (mode === 'ptt') return 'Hold the bound key while speaking. Release to let the model translate.';
    return 'Auto VAD: model decides when you start/stop speaking based on silence detection.';
  },
  audioSource(canDisplay, companionOk) {
    if (!canDisplay && !companionOk) return 'App audio capture is unavailable. Start the companion service or use Chrome/Edge tab audio.';
    if (companionOk)                  return 'Companion app detected. Use it for background app audio without screen sharing.';
    if (!canDisplay)                  return 'Browser app audio capture is unsupported here. Start the companion service to use app audio.';
    return 'Default microphone. Use app/tab audio in Chrome/Edge, or Companion app audio when the local service is running.';
  },
};

const $ = (id) => document.getElementById(id);

// ─── Segmented control helpers ───────────────────────────────────────────────
// We replaced several <select> elements with .segmented button groups. To keep
// the rest of the code reading naturally, segmented elements are wrapped in a
// tiny proxy that mimics the .value + change-event API.
function segValueOf(seg) {
  if (!seg) return '';
  const btn = seg.querySelector('.seg-opt.is-active');
  return btn ? btn.dataset.value : '';
}

// Centralises option lookup so the rest of the helpers don't have to template
// `value` into a CSS selector (which would need CSS.escape for arbitrary
// inputs). Linear scan is fine — segmented groups are 2–4 options.
function segOptByValue(seg, value) {
  if (!seg) return null;
  for (const btn of seg.querySelectorAll('.seg-opt')) {
    if (btn.dataset.value === value) return btn;
  }
  return null;
}

function setSegValue(seg, value) {
  if (!seg) return;
  let foundActive = false;
  for (const btn of seg.querySelectorAll('.seg-opt')) {
    const isThis = btn.dataset.value === value;
    if (isThis) foundActive = true;
    btn.classList.toggle('is-active', isThis);
    btn.setAttribute('aria-checked', isThis ? 'true' : 'false');
  }
  if (!foundActive) {
    // Surface the mismatch loudly during development — silently snapping to
    // a fallback hides config bugs (typos in dataset.value, mismatched preset
    // keys). Empty-string requests are intentional ("clear selection") and skip.
    if (value !== undefined && value !== null && value !== '') {
      console.warn(`[Translator] segmented control: no .seg-opt with data-value="${value}" — fell back to first enabled option.`);
    }
    const first = seg.querySelector('.seg-opt:not([disabled])');
    if (first) {
      first.classList.add('is-active');
      first.setAttribute('aria-checked', 'true');
    }
  }
}

function setSegOptionDisabled(seg, value, disabled) {
  const btn = segOptByValue(seg, value);
  if (btn) btn.disabled = !!disabled;
}

function segOption(seg, value) {
  return segOptByValue(seg, value);
}

function wireSegmented(seg, onChange) {
  if (!seg) return;
  seg.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.seg-opt');
    // Three ways an option can be off-limits:
    //  - btn.disabled  → individually marked unavailable (setOptionDisabled)
    //  - seg.is-locked → whole control locked (segProxy.disabled, e.g. session running)
    //  - already active → no-op, don't refire onChange
    if (!btn || btn.disabled) return;
    if (seg.classList.contains('is-locked')) return;
    if (btn.classList.contains('is-active')) return;
    setSegValue(seg, btn.dataset.value);
    if (onChange) onChange(btn.dataset.value);
  });
}

// Wraps a .segmented element as a select-like proxy: `.value` get/set,
// `addEventListener('change', …)`. Lets the rest of the code keep its shape.
function segProxy(seg) {
  const proxy = {
    el: seg,
    get value() { return segValueOf(seg); },
    set value(v) { setSegValue(seg, v); },
    // Locking the whole control (during a running session) must remove the
    // options from the focus order and announce them as disabled to AT —
    // .is-locked alone only stops pointer events, leaving the buttons tab-
    // reachable and silently unresponsive. We deliberately use tabindex +
    // aria-disabled rather than the DOM `disabled` attribute so the per-option
    // disabled state (set by setOptionDisabled for e.g. unavailable PTT) is
    // preserved across lock/unlock cycles.
    set disabled(d) {
      if (!seg) return;
      seg.classList.toggle('is-locked', !!d);
      for (const btn of seg.querySelectorAll('.seg-opt')) {
        if (d) {
          btn.setAttribute('aria-disabled', 'true');
          btn.setAttribute('tabindex', '-1');
        } else {
          btn.removeAttribute('aria-disabled');
          btn.removeAttribute('tabindex');
        }
      }
    },
    get selectedOptions() {
      const btn = seg && seg.querySelector('.seg-opt.is-active');
      return btn ? [{ textContent: btn.textContent, value: btn.dataset.value }] : [];
    },
    addEventListener(type, fn) {
      if (type === 'change') wireSegmented(seg, () => fn({ target: proxy }));
    },
    setOptionDisabled(value, disabled) { setSegOptionDisabled(seg, value, disabled); },
    getOption(value) { return segOption(seg, value); },
  };
  return proxy;
}

const els = {
  apiKey:        $('api-key'),
  btnShowKey:    $('btn-show-key'),
  langSource:    $('lang-source'),
  langTarget:    $('lang-target'),
  voice:         $('voice'),
  audioInput:    $('audio-input'),
  audioInputHint:$('audio-input-hint'),
  audioSource:   segProxy($('audio-source-segmented')),
  audioHint:     $('audio-source-hint'),
  companionApp:      $('companion-app'),
  companionAppField: $('companion-app-field'),
  companionAppHint:  $('companion-app-hint'),
  btnRefreshApps:    $('btn-refresh-apps'),
  audioOutput:   $('audio-output'),
  audioOutputSection: $('audio-output-section'),
  audioOutputHint:$('audio-output-hint'),
  modeSelect:    segProxy($('mode-segmented')),
  modeHint:      $('mode-hint'),
  dirSelect:     segProxy($('dir-segmented')),
  dirField:      $('dir-field'),
  dirHint:       $('dir-hint'),
  voiceSection:  $('voice-section'),
  micSection:    $('mic-section'),
  speechMode:    segProxy($('speech-mode-segmented')),
  speechModeHint:$('speech-mode-hint'),
  vadAutoFields: $('vad-auto-fields'),
  vadPttFields:  $('vad-ptt-fields'),
  vadPreset:     $('vad-preset'),
  vadStart:      segProxy($('vad-start-segmented')),
  vadEnd:        segProxy($('vad-end-segmented')),
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
  btnPttKey:     $('btn-ptt-key'),
  btnPttClear:   $('btn-ptt-clear'),
  pttKeyLabel:   $('ptt-key-label'),
  pttHint:       $('ptt-hint'),
  promptText:    $('prompt-text'),
  sidebar:       $('sidebar'),
  promptSheet:   $('prompt-sheet'),
  logSheet:      $('log-sheet'),
  statusPill:    $('status-pill'),
  statusText:    $('status-text'),
  sessionAge:    $('session-age'),
  tabList:       $('tab-list'),
  btnNewSession: $('btn-new-session'),
  btnStartAll:   $('btn-start-all'),
  btnStopAll:    $('btn-stop-all'),
  turnsHost:     $('turns-host'),
  modeSwitch:    $('mode-switch'),
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
    this.resumeHandle = null;      // Latest Gemini Live resumption handle

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
    this.tabLabelEl = null;        // .tab-label
    this.tabStatusEl = null;       // .tab-status-text
    this.tabAgeEl = null;          // .tab-age
    this.tabMicFill = null;        // .tab-meter.mic .tab-meter-fill
    this.tabOutFill = null;        // .tab-meter.out .tab-meter-fill
    this.transcriptEl = null;      // .session-turns

    // Last observed audio levels (0..1). Snapshotted so the chip meters keep
    // their state across tab switches without waiting for the next callback.
    this.lastMicLevel = 0;
    this.lastOutLevel = 0;

    // Set true by the TTS coordinator while this session is queued or
    // speaking; sendAudioGated swaps real audio for zero-filled buffers so
    // the model neither picks up another turn nor hears its own output.
    this.muteInput = false;

    // True while the PTT key is held down (only meaningful in pttMode === 'ptt').
    // Outside the window we send silence to keep the stream healthy without
    // triggering the model.
    this.pttHeld = false;
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
      // True after Hush is hit mid-turn: drop the rest of the model's chunks
      // for this turn so they don't immediately restart playback. Cleared on
      // the next turn-complete signal (a fresh user utterance gets a fresh slate).
      suppressed: false,
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
    // Note: entry is now gone, so any leftover chunks from gemini-live for
    // this session id will be dropped by enqueueChunk's `if (!entry) return`.
  }

  enqueueChunk(session, b64) {
    const entry = this.entries.get(session.id);
    if (!entry) return;
    // Drop chunks that arrive after Hush, until the model signals the turn
    // is over (then suppression lifts and the next utterance plays normally).
    if (entry.suppressed) return;
    const firstChunkOfTurn = !entry.wantsToSpeak;
    if (firstChunkOfTurn) {
      entry.wantsToSpeak = true;
      entry.turnComplete = false;
      session.muteInput = true;
      this._requestSpeak(session.id);
      // The session either just became the speaker (status flips via
      // onActiveChange when playChunk fires) or got queued behind someone
      // else. The queued case has no other repaint trigger, so we always
      // refresh here.
      refreshSessionDisplay(session);
    }
    if (this.currentSpeakerId === session.id) {
      entry.player.playChunk(b64);
    } else {
      entry.buffered.push(b64);
    }
  }

  // True when the session has a pending turn but isn't the speaker — i.e. its
  // chunks are buffering while another session is speaking. effectiveStatus()
  // uses this to surface a distinct "Queued" chip + pill state.
  isQueued(sessionId) {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    return entry.wantsToSpeak && this.currentSpeakerId !== sessionId;
  }

  markTurnComplete(session) {
    const entry = this.entries.get(session.id);
    if (!entry) return;
    // A turn ended — clear suppression so the next user utterance can speak.
    if (entry.suppressed) {
      entry.suppressed = false;
      // No further bookkeeping: hush() already released the slot and the
      // mic gate. We just stop dropping incoming chunks from the next turn.
      return;
    }
    if (!entry.wantsToSpeak) return;
    entry.turnComplete = true;
    if (this.currentSpeakerId === session.id) {
      this._maybeFinishSpeaking(session.id);
    }
  }

  hush(session) {
    const entry = this.entries.get(session.id);
    if (!entry) return;
    // If we were mid-turn (had wantsToSpeak set), the model is still streaming.
    // Suppress remaining chunks so they don't re-enter the queue and restart
    // playback. Suppression auto-clears on the next turn-complete.
    const wasMidTurn = entry.wantsToSpeak;
    try { entry.player.hush(); } catch (_) {}
    entry.buffered.length = 0;
    entry.wantsToSpeak = false;
    entry.turnComplete = false;
    entry.suppressed = wasMidTurn;
    session.muteInput = false;
    if (this.currentSpeakerId === session.id) {
      this.currentSpeakerId = null;
      refreshSessionDisplay(session);
      this._tryStartNext();
    } else {
      this.queue = this.queue.filter((sid) => sid !== session.id);
      // Was queued or idle — either way, repaint the chip so a "Queued"
      // indicator clears immediately rather than after the next status event.
      refreshSessionDisplay(session);
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
    // The session that just finished should flip out of "Speaking" — the
    // wrapped onActiveChange already set status=connected, but we refresh
    // again so the muteInput → mic-meter-unlocked transition is reflected.
    refreshSessionDisplay(entry.session);
    this._tryStartNext();
  }

  _tryStartNext() {
    if (this.currentSpeakerId) return;
    while (this.queue.length) {
      const nextId = this.queue.shift();
      const entry = this.entries.get(nextId);
      if (!entry) continue;
      this.currentSpeakerId = nextId;
      // The newly-promoted session was "Queued"; it's about to be "Speaking".
      // playChunk's onActiveChange will fire the proper status flip, but we
      // refresh here too so the queued indicator clears in the same frame
      // even if no chunks are immediately available.
      refreshSessionDisplay(entry.session);
      const buf = entry.buffered;
      entry.buffered = [];
      for (const b64 of buf) entry.player.playChunk(b64);
      if (entry.turnComplete) this._maybeFinishSpeaking(nextId);
      return;
    }
  }
}

// ─── PTT (push-to-talk) hotkey client ────────────────────────────────────────
// Talks to the companion app's /hotkey WebSocket. The companion installs a
// low-level keyboard hook that fires globally (even when this page isn't
// focused). When the bound key is pressed/released, we get a JSON message
// here, which we fan out to subscribed sessions.
class PttHotkeyClient {
  constructor({ wsUrl }) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.binding = null;          // {vkCode, ctrl, shift, alt, win, label}
    this.subscribers = new Map(); // sessionId -> {onDown, onUp}
    this.connected = false;
    this._reconnectTimer = 0;
    this._wantConnect = false;
    this.onAvailabilityChange = () => {};
    this._held = false;
  }

  setBinding(binding) {
    this.binding = binding;
    this._sendBinding();
  }

  clearBinding() {
    this.binding = null;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ action: 'unbind' })); } catch (_) {}
    }
    // Any session that thought a key was held loses that state.
    if (this._held) this._broadcast('up');
    this._held = false;
  }

  subscribe(sessionId, onDown, onUp) {
    this.subscribers.set(sessionId, { onDown, onUp });
    this._wantConnect = true;
    this._ensureConnection();
    if (this._held) { try { onDown(); } catch (_) {} }
  }

  unsubscribe(sessionId) {
    const sub = this.subscribers.get(sessionId);
    if (!sub) return;
    if (this._held) { try { sub.onUp(); } catch (_) {} }
    this.subscribers.delete(sessionId);
    if (this.subscribers.size === 0) {
      this._wantConnect = false;
      this._teardown();
    }
  }

  hasBinding() { return !!this.binding && Number.isFinite(this.binding.vkCode); }
  isConnected() { return this.connected; }

  _ensureConnection() {
    if (this.ws || !this._wantConnect) return;
    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.connected = true;
      this.onAvailabilityChange(true);
      if (this.hasBinding()) this._sendBinding();
    };
    this.ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.event === 'down' && !this._held) {
        this._held = true;
        this._broadcast('down');
      } else if (msg.event === 'up' && this._held) {
        this._held = false;
        this._broadcast('up');
      }
    };
    this.ws.onerror = () => {};
    this.ws.onclose = () => {
      this.ws = null;
      const wasConnected = this.connected;
      this.connected = false;
      if (this._held) {
        // Connection died with key still "held" — release it locally so
        // sessions don't get stuck in the speaking state.
        this._held = false;
        this._broadcast('up');
      }
      if (wasConnected) this.onAvailabilityChange(false);
      if (this._wantConnect) this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = 0;
      this._ensureConnection();
    }, 1500);
  }

  _teardown() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = 0; }
    if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
    this.connected = false;
  }

  _sendBinding() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.hasBinding()) return;
    const b = this.binding;
    try {
      this.ws.send(JSON.stringify({
        action: 'bind',
        vkCode: b.vkCode,
        ctrl:   !!b.ctrl,
        shift:  !!b.shift,
        alt:    !!b.alt,
        win:    !!b.win,
      }));
    } catch (_) {}
  }

  _broadcast(which) {
    for (const sub of this.subscribers.values()) {
      try { which === 'down' ? sub.onDown() : sub.onUp(); } catch (_) {}
    }
  }
}

const state = {
  sessions: new Map(),
  activeSessionId: null,
  ttsCoordinator: new TTSCoordinator(),
  micPassthrough: new LiveAudio.MicPassthrough(),

  // 'simple' hides the tab strip and advanced settings sections; 'advanced'
  // shows everything. Sessions and configs are unaffected — flipping back to
  // advanced reveals all existing tabs untouched.
  uiMode: 'simple',

  // Global PTT key binding shared across all PTT-enabled sessions.
  // Shape: { vkCode, ctrl, shift, alt, win, label } | null
  pttBinding: null,
  pttClient: null,             // PttHotkeyClient, lazily created in init
  pttCapturing: false,         // true while waiting for the user to press a key

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
    outputDeviceIds: getSelectedOutputDeviceIds(),
    companionApp:   els.companionApp ? els.companionApp.value : '',
    // 'auto' = automatic VAD on Gemini's side, 'ptt' = client signals activity
    // via the companion-app global hotkey. The hotkey binding itself is global
    // (state.pttBinding), not per-session.
    pttMode:        els.speechMode.value || 'auto',
  };
}

function newSessionId() {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── Per-session DOM ─────────────────────────────────────────────────────────
// A tab chip is the session at a glance:
//   row 1:  ● [lang pair]                ×
//   row 2:  STATUS                    00:23
//   row 3:  ▓▓▓░░░░░░ (mic) / ░░░ (out)
// Active chip gets a thick accent bar on top + bg-0 background to clearly
// indicate which session's transcript fills the panel below.
function createSessionDOM(session) {
  // Stable DOM ids let the chip and panel cross-reference via aria-controls /
  // aria-labelledby. Session ids already start with "s_…" so they're safe.
  const tabId = 'tab-' + session.id;
  const panelId = 'panel-' + session.id;

  const chip = document.createElement('div');
  chip.className = 'tab-chip';
  chip.id = tabId;
  chip.dataset.sessionId = session.id;
  chip.dataset.status = session.status;
  chip.dataset.audio  = session.isAudio ? 'true' : 'false';
  chip.setAttribute('role', 'tab');
  // Initial selection state — will be flipped by setActiveSession. Inactive
  // tabs are tabindex=-1 so Tab key lands once on the tablist (on the active
  // tab), then arrow keys move within the strip — the standard WAI-ARIA tab pattern.
  chip.setAttribute('aria-selected', 'false');
  chip.setAttribute('aria-controls', panelId);
  chip.setAttribute('tabindex', '-1');
  // tab-close is a real <button> so it's reachable by keyboard (Tab into the
  // tab, then Shift+Tab back out — or, more practically, the button shows up
  // as a separate stop while inside the tablist).
  chip.innerHTML =
    '<div class="tab-chip-head">' +
      '<span class="tab-status-dot" aria-hidden="true"></span>' +
      '<span class="tab-label"></span>' +
      '<button class="tab-close" type="button" aria-label="Close session" title="Close session" tabindex="-1">×</button>' +
    '</div>' +
    '<div class="tab-chip-mid">' +
      '<span class="tab-status-text">Idle</span>' +
      '<span class="tab-age mono">00:00</span>' +
    '</div>' +
    '<div class="tab-meters" aria-hidden="true">' +
      '<div class="tab-meter mic"><div class="tab-meter-fill"></div></div>' +
      '<div class="tab-meter out"><div class="tab-meter-fill"></div></div>' +
    '</div>';
  els.tabList.appendChild(chip);
  session.tabEl       = chip;
  session.tabLabelEl  = chip.querySelector('.tab-label');
  session.tabStatusEl = chip.querySelector('.tab-status-text');
  session.tabAgeEl    = chip.querySelector('.tab-age');
  session.tabMicFill  = chip.querySelector('.tab-meter.mic .tab-meter-fill');
  session.tabOutFill  = chip.querySelector('.tab-meter.out .tab-meter-fill');
  updateTabChip(session);
  refreshSessionDisplay(session);

  const turns = document.createElement('div');
  turns.className = 'session-turns';
  turns.id = panelId;
  turns.dataset.sessionId = session.id;
  // Tabpanel semantics + label binding back to the chip. aria-live is added
  // by setActiveSession only on the active panel (see H3 fix) so SRs don't
  // announce inactive transcripts.
  turns.setAttribute('role', 'tabpanel');
  turns.setAttribute('aria-labelledby', tabId);
  turns.setAttribute('tabindex', '0');
  els.turnsHost.appendChild(turns);
  session.transcriptEl = turns;
  renderSessionEmptyState(session);
}

function updateTabChip(session) {
  if (!session.tabEl) return;
  const cfg = session.config;
  const sym = cfg.mode === 'transcribe' ? '·' : (cfg.dir === 'oneway' ? '→' : '↔');
  const label = `${cfg.source.toUpperCase()} ${sym} ${cfg.target.toUpperCase()}`;
  if (session.tabLabelEl) session.tabLabelEl.textContent = label;
  session.tabEl.dataset.audio = session.isAudio ? 'true' : 'false';
  session.tabEl.title = `${langName(cfg.source)} → ${langName(cfg.target)}`;
}

function renderSessionEmptyState(session) {
  if (!session.transcriptEl) return;
  session.transcriptEl.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.innerHTML =
    '<div class="empty-icon" aria-hidden="true">' +
      '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-mic"/></svg>' +
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

// ─── Push-to-talk (PTT) ──────────────────────────────────────────────────────
// PTT inputs are captured in two layers:
//   - This file owns the UI (toggle, key-capture button) and the per-session
//     subscription via state.pttClient.
//   - The companion app exposes /hotkey, installs a low-level keyboard hook,
//     and emits down/up events even when the page isn't focused.
//
// When pttMode === 'ptt' is enabled on a session:
//   - manualActivity: true is passed to GeminiLiveClient (disables auto VAD).
//   - sendAudioGated sends silence whenever pttHeld is false.
//   - Key-down → session.pttHeld = true + activityStart(); audio flows.
//   - Key-up   → session.pttHeld = false + activityEnd(); silence resumes.
function vkLabel(binding) {
  if (!binding || !Number.isFinite(binding.vkCode)) return 'Not set — click to bind';
  const parts = [];
  const label = binding.label || keyLabelFromVk(binding.vkCode);
  if (binding.ctrl && label !== 'Ctrl')  parts.push('Ctrl');
  if (binding.shift && label !== 'Shift') parts.push('Shift');
  if (binding.alt && label !== 'Alt')   parts.push('Alt');
  if (binding.win && label !== 'Win')   parts.push('Win');
  parts.push(label);
  return parts.join(' + ');
}

// Best-effort label for a Windows VK code; covers the keys the user is likely
// to bind. Used as a fallback when the captured event didn't supply a code.
function keyLabelFromVk(vk) {
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);            // 0..9
  if (vk >= 0x41 && vk <= 0x5A) return String.fromCharCode(vk);            // A..Z
  if (vk >= 0x70 && vk <= 0x7B) return 'F' + (vk - 0x6F);                  // F1..F12
  const map = {
    0x08:'Backspace', 0x09:'Tab', 0x0D:'Enter', 0x10:'Shift', 0x11:'Ctrl',
    0x12:'Alt', 0x13:'Pause', 0x14:'CapsLock', 0x1B:'Esc', 0x20:'Space',
    0x21:'PageUp', 0x22:'PageDown', 0x23:'End', 0x24:'Home',
    0x25:'Left', 0x26:'Up', 0x27:'Right', 0x28:'Down',
    0x2D:'Insert', 0x2E:'Delete', 0x5B:'Win', 0x5C:'Win',
    0x90:'NumLock', 0x91:'ScrollLock',
    0xBA:';', 0xBB:'=', 0xBC:',', 0xBD:'-', 0xBE:'.', 0xBF:'/', 0xC0:'`',
    0xDB:'[', 0xDC:'\\', 0xDD:']', 0xDE:"'",
  };
  return map[vk] || ('VK_' + vk);
}

// Browser KeyboardEvent.code → human label (mostly mirrors keyLabelFromVk).
function keyLabelFromCode(code) {
  let m;
  if ((m = code.match(/^Key([A-Z])$/)))   return m[1];
  if ((m = code.match(/^Digit(\d)$/)))    return m[1];
  if ((m = code.match(/^Numpad(\d)$/)))   return 'Num ' + m[1];
  if ((m = code.match(/^F(\d+)$/)))       return 'F' + m[1];
  const map = {
    Space:'Space', Tab:'Tab', Enter:'Enter', Escape:'Esc', Backspace:'Backspace',
    ArrowLeft:'Left', ArrowUp:'Up', ArrowRight:'Right', ArrowDown:'Down',
    Home:'Home', End:'End', PageUp:'PageUp', PageDown:'PageDown',
    Insert:'Insert', Delete:'Delete', CapsLock:'CapsLock',
    Backquote:'`', Minus:'-', Equal:'=',
    BracketLeft:'[', BracketRight:']', Backslash:'\\',
    Semicolon:';', Quote:"'", Comma:',', Period:'.', Slash:'/',
    NumpadAdd:'Num +', NumpadSubtract:'Num -', NumpadMultiply:'Num *',
    NumpadDivide:'Num /', NumpadDecimal:'Num .', NumpadEnter:'Num Enter',
  };
  return map[code] || code;
}

// KeyboardEvent.code → Windows VK_* lookup. The companion's low-level keyboard
// hook stores generic VK codes (VK_SHIFT, not VK_LSHIFT) so left/right
// modifiers both map to the same value here. Anything missing (layout-specific
// keys, OEM keys, language-specific composes) falls through to the legacy
// keyCode path below — keyCode is deprecated and not portable across layouts,
// but on Windows + US-ish layouts it lines up with VK_* by coincidence and is
// good enough as a last-resort fallback for unmapped keys.
const CODE_TO_VK = {
  // Letters A-Z
  KeyA: 0x41, KeyB: 0x42, KeyC: 0x43, KeyD: 0x44, KeyE: 0x45, KeyF: 0x46,
  KeyG: 0x47, KeyH: 0x48, KeyI: 0x49, KeyJ: 0x4A, KeyK: 0x4B, KeyL: 0x4C,
  KeyM: 0x4D, KeyN: 0x4E, KeyO: 0x4F, KeyP: 0x50, KeyQ: 0x51, KeyR: 0x52,
  KeyS: 0x53, KeyT: 0x54, KeyU: 0x55, KeyV: 0x56, KeyW: 0x57, KeyX: 0x58,
  KeyY: 0x59, KeyZ: 0x5A,
  // Top-row digits
  Digit0: 0x30, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34,
  Digit5: 0x35, Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39,
  // Function keys
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
  F13: 0x7C, F14: 0x7D, F15: 0x7E, F16: 0x7F, F17: 0x80, F18: 0x81,
  F19: 0x82, F20: 0x83, F21: 0x84, F22: 0x85, F23: 0x86, F24: 0x87,
  // Numpad
  Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64,
  Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67, Numpad8: 0x68, Numpad9: 0x69,
  NumpadMultiply: 0x6A, NumpadAdd: 0x6B, NumpadSubtract: 0x6D,
  NumpadDecimal: 0x6E, NumpadDivide: 0x6F, NumpadEnter: 0x0D,
  // Modifiers — both sides collapse to the generic VK to match what the
  // companion's GetAsyncKeyState comparison normalises to.
  ShiftLeft: 0x10, ShiftRight: 0x10,
  ControlLeft: 0x11, ControlRight: 0x11,
  AltLeft: 0x12, AltRight: 0x12,
  MetaLeft: 0x5B, MetaRight: 0x5C,
  // Whitespace / navigation
  Space: 0x20, Tab: 0x09, Enter: 0x0D, Escape: 0x1B, Backspace: 0x08,
  CapsLock: 0x14, ScrollLock: 0x91, NumLock: 0x90, Pause: 0x13,
  PrintScreen: 0x2C, ContextMenu: 0x5D,
  Insert: 0x2D, Delete: 0x2E,
  Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  // Punctuation (US layout — VK_OEM_* values; non-US layouts hit the
  // keyCode fallback, which usually matches anyway).
  Semicolon: 0xBA, Equal: 0xBB, Comma: 0xBC, Minus: 0xBD, Period: 0xBE,
  Slash: 0xBF, Backquote: 0xC0, BracketLeft: 0xDB, Backslash: 0xDC,
  BracketRight: 0xDD, Quote: 0xDE,
};

function bindingFromKeyboardEvent(ev) {
  const code = ev.code || '';
  let vkCode = CODE_TO_VK[code];
  if (vkCode === undefined) {
    // Last-resort fallback. ev.keyCode is deprecated and layout-dependent,
    // but tends to line up with Windows VK on Windows; better to bind
    // something for unmapped keys than to refuse the bind entirely.
    vkCode = ev.keyCode || ev.which || 0;
  }
  if (!vkCode) return null;
  const isModifier = (vkCode === 0x10 || vkCode === 0x11 || vkCode === 0x12 ||
                      vkCode === 0x5B || vkCode === 0x5C);
  return {
    vkCode,
    isModifier,
    ctrl:  !!ev.ctrlKey,
    shift: !!ev.shiftKey,
    alt:   !!ev.altKey,
    win:   !!ev.metaKey,
    label: keyLabelFromCode(code),
  };
}

function updatePttButton() {
  if (!els.pttKeyLabel) return;
  els.pttKeyLabel.textContent = state.pttCapturing
    ? 'Press a key…'
    : vkLabel(state.pttBinding);
  if (els.btnPttKey) els.btnPttKey.classList.toggle('is-capturing', !!state.pttCapturing);
  if (els.btnPttClear) {
    els.btnPttClear.disabled = !state.pttBinding;
  }
  if (els.pttHint) {
    const companionMissing = !state.companionAvailable;
    if (companionMissing) {
      els.pttHint.textContent = 'Push-to-talk needs the companion app running. Start it, then refresh.';
    } else if (!state.pttBinding) {
      els.pttHint.textContent = 'Click "Not set" and press a key (or key combo) to bind the global hotkey.';
    } else {
      els.pttHint.textContent = 'Hotkey works system-wide via the companion app — even when this page is in the background.';
    }
  }
}

// Toggle which sub-section is visible (auto-VAD fields vs PTT fields) and
// disable the PTT option entirely when the companion app isn't reachable.
function updateSpeechModeFields() {
  const companionOk = state.companionAvailable;
  if (els.speechMode) els.speechMode.setOptionDisabled('ptt', !companionOk);

  // If the user is on PTT but the companion just went away, fall back to auto
  // and sync the change through onSettingsChange so the active session learns.
  if (!companionOk && els.speechMode && els.speechMode.value === 'ptt') {
    els.speechMode.value = 'auto';
    const session = activeSession();
    if (session) {
      session.config.pttMode = 'auto';
      saveSessions();
    }
  }

  const mode = els.speechMode ? els.speechMode.value : 'auto';
  if (els.vadAutoFields) els.vadAutoFields.style.display = mode === 'ptt' ? 'none' : '';
  if (els.vadPttFields)  els.vadPttFields.style.display  = mode === 'ptt' ? '' : 'none';

  if (els.speechModeHint) {
    els.speechModeHint.textContent = HINTS.speechMode(mode, companionOk);
  }
  updatePttButton();
}

function beginPttCapture() {
  if (state.pttCapturing) return;
  state.pttCapturing = true;
  updatePttButton();

  const finish = () => {
    state.pttCapturing = false;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    updatePttButton();
  };

  const finishCapture = (binding) => {
    finish();
    state.pttBinding = binding;
    if (state.pttClient) state.pttClient.setBinding(binding);
    savePrefs();
    updatePttButton();
    log('info', 'Push-to-talk hotkey set to ' + vkLabel(binding));
  };

  const onKeyDown = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    // Escape cancels capture without binding — gives the user an escape hatch.
    if (ev.key === 'Escape') { finish(); return; }
    const binding = bindingFromKeyboardEvent(ev);
    if (!binding) return;

    if (!binding.isModifier) {
      // Non-modifier key pressed: finish immediately.
      finishCapture(binding);
    } else {
      // Modifier key pressed: update the "Press a key" label to show current combo,
      // but wait for either a non-modifier or a keyup to finish.
      if (els.pttKeyLabel) els.pttKeyLabel.textContent = vkLabel(binding);
    }
  };

  const onKeyUp = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    // If a key is released while we're still capturing, it means the user
    // wanted to bind just that modifier (or modifier combo).
    const binding = bindingFromKeyboardEvent(ev);
    if (binding) finishCapture(binding);
  };

  // Capture-phase so the keypress doesn't trigger sidebar/sheet shortcuts.
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  // Safety: bail after 6 seconds if the user changed their mind.
  setTimeout(finish, 6000);
}

// The live capture path in beginPttCapture sets this inline. This helper stays
// for any direct callers (e.g. unit tests or future programmatic binds).
function finishPttCapture(binding) {
  state.pttCapturing = false;
  state.pttBinding = binding;
  if (state.pttClient) state.pttClient.setBinding(binding);
  savePrefs();
  updatePttButton();
  log('info', 'Push-to-talk hotkey set to ' + vkLabel(binding));
}

function clearPttBinding() {
  state.pttBinding = null;
  if (state.pttClient) state.pttClient.clearBinding();
  savePrefs();
  updatePttButton();
  log('info', 'Push-to-talk hotkey cleared.');
}

// ─── Active session switching ────────────────────────────────────────────────
function setActiveSession(id) {
  if (!state.sessions.has(id)) return;
  if (state.activeSessionId === id) return;

  const prev = activeSession();
  if (prev) {
    if (prev.tabEl) {
      prev.tabEl.classList.remove('is-active');
      // Roving tabindex: inactive tabs are skipped by Tab key; arrow keys
      // within the tablist move focus + selection (see wireUI).
      prev.tabEl.setAttribute('aria-selected', 'false');
      prev.tabEl.setAttribute('tabindex', '-1');
    }
    if (prev.transcriptEl) {
      prev.transcriptEl.classList.remove('is-active');
      // Remove the live region from the previously active panel so SRs don't
      // announce additions on a panel the user can no longer see.
      prev.transcriptEl.removeAttribute('aria-live');
      prev.transcriptEl.removeAttribute('aria-relevant');
    }
  }
  state.activeSessionId = id;
  const next = state.sessions.get(id);
  if (next.tabEl) {
    next.tabEl.classList.add('is-active');
    next.tabEl.setAttribute('aria-selected', 'true');
    next.tabEl.setAttribute('tabindex', '0');
  }
  if (next.transcriptEl) {
    next.transcriptEl.classList.add('is-active');
    // Only announce additions on the visible panel; aria-relevant=additions
    // skips the noise from MAX_TURNS-driven trimming at the top of the list.
    next.transcriptEl.setAttribute('aria-live', 'polite');
    next.transcriptEl.setAttribute('aria-relevant', 'additions');
  }

  loadSessionConfigIntoUI(next);
  refreshSessionDisplay(next);
  applyControlButtonsForActiveSession();
  els.sessionAge.textContent = next.startedAt
    ? fmtDuration(Date.now() - next.startedAt)
    : '00:00';
  // Per-session meters live inside the chip and keep painting themselves on
  // every level callback; no global meter to reset here.

  // PiP follows the active session: relabel and replay the session's transcript
  // so what's on the popout matches what's in the main window.
  if (state.pip) seedPipFromSession(next);

  // Auto-scroll the new tab's transcript to the bottom so the latest turn is
  // in view (transcripts can be scrolled up while the user is reading old ones).
  if (next.transcriptEl) {
    next.transcriptEl.scrollTop = next.transcriptEl.scrollHeight;
  }

  saveSessions();
}

function seedPipFromSession(session) {
  if (!state.pip) return;
  state.pip.setStatus(els.statusText.textContent,
    session.status === 'translating' || session.status === 'connected');
  state.pip.setLangs(langName(session.config.source), langName(session.config.target));
  if (session.liveTurn) {
    state.pip.setInput(session.liveTurn.inputText);
    state.pip.setOutput(session.liveTurn.outputText);
    return;
  }
  if (session.transcriptEl) {
    const last = session.transcriptEl.querySelector('.turn:last-child');
    if (last) {
      const it = last.querySelector('.turn-row.input .turn-text');
      const ot = last.querySelector('.turn-row.output .turn-text');
      state.pip.setInput(it && !it.classList.contains('empty') ? it.textContent : '');
      state.pip.setOutput(ot && !ot.classList.contains('empty') ? ot.textContent : '');
      return;
    }
  }
  state.pip.setInput('');
  state.pip.setOutput('');
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
  const outIds = normalizeOutputDeviceIds(cfg.outputDeviceIds, cfg.outputDeviceId);
  cfg.outputDeviceIds = outIds;
  setSelectedOutputDeviceIds(outIds);
  els.audioOutput.dataset.preferred = JSON.stringify(outIds);
  if (els.companionApp) {
    els.companionApp.value = cfg.companionApp || '';
    els.companionApp.dataset.preferred = cfg.companionApp || '';
  }
  els.vadStart.value = cfg.vad.startSensitivity;
  els.vadEnd.value = cfg.vad.endSensitivity;
  els.vadPrefix.value = String(cfg.vad.prefixPaddingMs);
  els.vadSilence.value = String(cfg.vad.silenceDurationMs);
  els.vadPreset.value = detectVadPreset();
  els.speechMode.value = cfg.pttMode === 'ptt' ? 'ptt' : 'auto';
  updateUIVisibility();
  updateCompanionAppVisibility();
  updateSpeechModeFields();
}

// Called whenever a settings input changes. Saves the snapshot as global
// "default for new sessions" prefs, and writes through to the active session's
// config so it picks up the change at the next Start.
function onSettingsChange() {
  savePrefs();
  const session = activeSession();
  if (!session) return;
  const nextConfig = readConfigFromUI();
  if (JSON.stringify(session.config) !== JSON.stringify(nextConfig)) {
    session.resumeHandle = null;
  }
  session.config = nextConfig;
  updateTabChip(session);
  saveSessions();
}

function createNewSession({ activate = true } = {}) {
  if (state.sessions.size >= MAX_SESSIONS) {
    log('warn', `Maximum of ${MAX_SESSIONS} sessions reached — close one to add another.`);
    return null;
  }
  const session = new Session({ id: newSessionId(), config: readConfigFromUI() });
  state.sessions.set(session.id, session);
  createSessionDOM(session);
  if (state.uiMode === 'simple' && state.sessions.size > 1) {
    setUIMode('advanced');
    log('info', 'Switched to Full mode so all sessions are visible.');
  }
  refreshAddSessionButton();
  refreshBulkActionButtons();
  saveSessions();
  // The new session has a fresh id, so setActiveSession's early-return won't
  // fire and the previous session's .is-active class is correctly removed.
  if (activate) setActiveSession(session.id);
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
  refreshAddSessionButton();
  refreshBulkActionButtons();

  if (state.activeSessionId === session.id) {
    state.activeSessionId = null;
    const next = state.sessions.values().next().value;
    let focusTarget = null;
    if (next) {
      setActiveSession(next.id);
      focusTarget = next.tabEl;
    } else {
      // No sessions left — create a fresh default from current UI state.
      const created = createNewSession({ activate: true });
      focusTarget = created && created.tabEl;
    }
    // The element that previously held focus (the closed chip, or its ×
    // button that just got detached) is gone. Without an explicit focus
    // move, focus falls to <body> and keyboard navigation stalls. Use
    // preventScroll so a closed tab on the right edge doesn't yank the
    // tab strip around when the new active chip is much further left.
    if (focusTarget) {
      try { focusTarget.focus({ preventScroll: true }); } catch (_) {}
    }
  } else {
    saveSessions();
  }
}

// Disables the "+" affordance and explains why when we're at the per-window
// session cap. Cheap to call after any sessions-map mutation.
function refreshAddSessionButton() {
  if (!els.btnNewSession) return;
  const atLimit = state.sessions.size >= MAX_SESSIONS;
  els.btnNewSession.disabled = atLimit;
  els.btnNewSession.title = atLimit
    ? `Maximum ${MAX_SESSIONS} sessions — close one to add another`
    : 'New session';
}

// Bulk-action button state. Start-all only makes sense when at least one
// session is idle; stop-all only when at least one is running.
function refreshBulkActionButtons() {
  if (!els.btnStartAll || !els.btnStopAll) return;
  let idle = 0, running = 0;
  for (const s of state.sessions.values()) {
    if (s.running) running++; else idle++;
  }
  els.btnStartAll.disabled = idle === 0;
  els.btnStopAll.disabled  = running === 0;
}

// Start every idle session sequentially. We don't fire them in parallel
// because each Start may surface a getUserMedia / getDisplayMedia prompt; the
// browser would only honour one of those at a time anyway.
async function startAllSessions() {
  const targets = [...state.sessions.values()].filter((s) => !s.running);
  if (targets.length === 0) return;
  log('info', `Starting ${targets.length} session${targets.length === 1 ? '' : 's'}…`);
  for (const s of targets) {
    try { await startSession(s); }
    catch (e) { log('warn', `Start failed for one session: ${e && e.message || e}`); }
  }
  refreshBulkActionButtons();
}

async function stopAllSessions() {
  const targets = [...state.sessions.values()].filter((s) => s.running);
  if (targets.length === 0) return;
  log('info', `Stopping ${targets.length} session${targets.length === 1 ? '' : 's'}…`);
  for (const s of targets) {
    try { await stopSession(s); }
    catch (_) {}
  }
  refreshBulkActionButtons();
}

// ─── Persistence (sessions) ──────────────────────────────────────────────────
function saveSessions() {
  try {
    const arr = [...state.sessions.values()].map((s) => ({
      id: s.id,
      config: s.config,
      resumeHandle: s.resumeHandle || null,
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
  // If an older build saved more than MAX_SESSIONS, keep only the first N —
  // the rest are lost on first load but no longer count against the cap.
  const entries = data.sessions.slice(0, MAX_SESSIONS);
  if (data.sessions.length > MAX_SESSIONS) {
    log('warn', `Found ${data.sessions.length} saved sessions; only the first ${MAX_SESSIONS} were restored.`);
  }
  for (const entry of entries) {
    const cfg = Object.assign({}, fallback, entry.config || {});
    cfg.vad = Object.assign({}, fallback.vad, (entry.config && entry.config.vad) || {});
    cfg.outputDeviceIds = normalizeOutputDeviceIds(cfg.outputDeviceIds, cfg.outputDeviceId);
    delete cfg.outputDeviceId;
    const session = new Session({
      id: entry.id || newSessionId(),
      config: cfg,
    });
    session.resumeHandle = entry.resumeHandle || null;
    state.sessions.set(session.id, session);
    createSessionDOM(session);
  }
  refreshAddSessionButton();
  refreshBulkActionButtons();
  const wantActive = data.activeId && state.sessions.has(data.activeId)
    ? data.activeId
    : state.sessions.keys().next().value;
  // state.activeSessionId is still null from initial state — setActiveSession
  // proceeds and activates the chosen session as expected.
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
      outputs: getSelectedOutputDeviceIds(),
      passthroughDeviceIds: getPassthroughDeviceIds(),
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
      pttBinding:  state.pttBinding || null,
    }));
  } catch (_) {}
}

function langName(code) {
  for (const [c, n] of LANGUAGES) if (c === code) return n;
  return code;
}

// ─── System prompt resolution ────────────────────────────────────────────────
// Two-state model: state.systemPromptTemplate is either a user-saved string
// (used verbatim, regardless of content) or null (use the mode default).
// The old code value-compared saved prompts against builtins, which meant a
// snapshot of yesterday's default could be silently treated as null today if
// the constant changed — and the user would unknowingly switch to a different
// system prompt at the next start. Explicit "Reset" sets null; "Save" saves
// whatever is typed.

function modeDefaultTemplate(mode, dir) {
  if (mode === 'transcribe') return GeminiLive.TRANSCRIBE_SYSTEM_PROMPT_TEMPLATE;
  if (dir === 'oneway')      return GeminiLive.ONE_WAY_SYSTEM_PROMPT_TEMPLATE;
  return GeminiLive.DEFAULT_SYSTEM_PROMPT_TEMPLATE;
}

function effectivePromptTemplateFor(mode, dir) {
  return state.systemPromptTemplate || modeDefaultTemplate(mode, dir);
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

function updateUIVisibility() {
  const mode = els.modeSelect.value;
  const source = els.audioSource.value;

  // Direction: only for translation modes
  els.dirField.style.display = (mode === 'transcribe') ? 'none' : '';

  // Voice & Audio Output: only for Translate (Voice) mode
  const showAudio = (mode === 'audio');
  els.voiceSection.style.display = showAudio ? '' : 'none';
  els.audioOutputSection.style.display = showAudio ? '' : 'none';

  // Microphone: only for Mic or Mic+Tab sources
  els.micSection.style.display = (source === 'mic' || source === 'both') ? '' : 'none';

  // Hints (table in HINTS constant at the top of this file)
  if (els.modeHint && HINTS.mode[mode]) {
    els.modeHint.textContent = HINTS.mode[mode];
  }
  if (els.dirHint) {
    els.dirHint.textContent = HINTS.dir[els.dirSelect.value] || HINTS.dir.bidir;
  }
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
  const displayOk = LiveAudio.canCaptureDisplayAudio();
  // "both" (Mic + tab audio) uses getDisplayMedia under the hood, so it
  // requires display-audio capture support, same as "display".
  els.audioSource.setOptionDisabled('display',   !displayOk);
  els.audioSource.setOptionDisabled('both',      !displayOk);
  els.audioSource.setOptionDisabled('companion', !state.companionAvailable);

  const currentBtn = els.audioSource.getOption(els.audioSource.value);
  if (currentBtn && currentBtn.disabled) {
    els.audioSource.value = 'mic';
  }

  els.audioHint.textContent = HINTS.audioSource(
    LiveAudio.canCaptureDisplayAudio(), state.companionAvailable);
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
  updateSpeechModeFields();
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
  const prefOutIds = normalizeOutputDeviceIds(prefs.outputs, prefs.output);
  els.audioOutput.dataset.preferred = JSON.stringify(prefOutIds);
  els.audioOutput.dataset.preferredPassthrough = JSON.stringify(prefs.passthroughDeviceIds || []);
  setSelectedOutputDeviceIds(prefOutIds);
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
  // Restore the global PTT binding (single hotkey shared across sessions).
  if (prefs.pttBinding && Number.isFinite(prefs.pttBinding.vkCode)) {
    state.pttBinding = prefs.pttBinding;
  }
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

  updateUIVisibility();
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
  setOutputDeviceListDisabled(!supported);
  if (!supported) {
    els.audioOutputHint.textContent = 'This browser does not allow web apps to choose a speaker.';
  }
}

function setOutputDeviceListDisabled(disabled) {
  if (!els.audioOutput) return;
  els.audioOutput.classList.toggle('is-disabled', !!disabled);
  els.audioOutput.dataset.disabled = disabled ? 'true' : 'false';
  els.audioOutput.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.disabled = !!disabled;
  });
}

function isOutputDeviceListDisabled() {
  return !!(els.audioOutput && els.audioOutput.dataset.disabled === 'true');
}

// Reads what's currently ticked. Empty array means "none selected", which
// downstream we treat as "system default" so a session never goes silent.
function getSelectedOutputDeviceIds() {
  if (!els.audioOutput) return [];
  return Array.from(els.audioOutput.querySelectorAll('input.dev-tts:checked'))
    .map((cb) => cb.value);
}

function setSelectedOutputDeviceIds(ids) {
  if (!els.audioOutput) return;
  const want = new Set((ids || []).map((id) => id || ''));
  els.audioOutput.querySelectorAll('input.dev-tts').forEach((cb) => {
    cb.checked = want.has(cb.value);
  });
}

function getPassthroughDeviceIds() {
  if (!els.audioOutput) return [];
  return Array.from(els.audioOutput.querySelectorAll('input.dev-passthrough:checked'))
    .map((cb) => cb.value);
}

// Starts/stops the global mic passthrough based on which devices have the
// mic icon toggled on. Completely independent of translation sessions.
async function applyPassthrough() {
  const ids = getPassthroughDeviceIds();
  const micId = els.audioInput ? els.audioInput.value || '' : '';
  try {
    await state.micPassthrough.update(micId, ids);
    // Drain per-sink warnings so the user learns which specific device
    // failed and why, instead of a generic "could not start".
    const warnings = state.micPassthrough.warnings || [];
    for (const w of warnings) {
      const label = describeSelectedOutputs([w.deviceId || '']);
      log('warn', `Mic passthrough to ${label}: ${w.reason}.`);
    }
    if (ids.length > 0 && !state.micPassthrough.running && warnings.length === 0) {
      log('warn', 'Mic passthrough could not start (check browser permissions).');
    }
  } catch (e) {
    log('warn', 'Mic passthrough error: ' + (e && e.message ? e.message : e));
  }
}

// Coerce legacy single-string saves and stray inputs into a clean array, then
// hand off to the shared LiveAudio.normalizeOutputIds for de-dup + empty
// coercion. The legacy migration (string → [string], legacySingle fallback)
// lives here because only app.js sees those old pref shapes.
function normalizeOutputDeviceIds(arr, legacySingle) {
  let raw;
  if (Array.isArray(arr)) raw = arr;
  else if (typeof arr === 'string') raw = [arr];
  else if (legacySingle != null) raw = [legacySingle];
  else raw = [];
  return LiveAudio.normalizeOutputIds(raw);
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
  if (!els.audioOutput || isOutputDeviceListDisabled()) return;
  try {
    let preferred = [];
    try { preferred = JSON.parse(els.audioOutput.dataset.preferred || '[]'); }
    catch (_) { preferred = []; }
    if (!Array.isArray(preferred)) preferred = [];

    let prefPassthrough = [];
    try { prefPassthrough = JSON.parse(els.audioOutput.dataset.preferredPassthrough || '[]'); }
    catch (_) { prefPassthrough = []; }
    if (!Array.isArray(prefPassthrough)) prefPassthrough = [];

    const currently = new Set(getSelectedOutputDeviceIds());
    const currentPt = new Set(getPassthroughDeviceIds());
    // Anything currently ticked wins over stale dataset values.
    const wantedTts = new Set([...currently, ...preferred.map((v) => v || '')]);
    const wantedPt  = new Set([...currentPt, ...prefPassthrough.map((v) => v || '')]);

    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    const seen = new Set();
    const frag = document.createDocumentFragment();
    frag.appendChild(buildDeviceOption('', 'System default', wantedTts.has(''), wantedPt.has('')));
    seen.add('');

    outputs.forEach((device, index) => {
      const id = device.deviceId || '';
      if (id === 'default') return;
      if (seen.has(id)) return;
      seen.add(id);
      frag.appendChild(buildDeviceOption(id, outputDeviceLabel(device, index), wantedTts.has(id), wantedPt.has(id)));
    });

    els.audioOutput.innerHTML = '';
    els.audioOutput.appendChild(frag);
    // Drop ids that no longer map to a present device.
    els.audioOutput.dataset.preferred = JSON.stringify(getSelectedOutputDeviceIds());
    els.audioOutput.dataset.preferredPassthrough = JSON.stringify(getPassthroughDeviceIds());

    if (outputs.length) {
      const hasLabels = outputs.some((d) => d.label);
      els.audioOutputHint.textContent = hasLabels
        ? 'Tick speakers for translated audio; tap the mic icon to also route your microphone there.'
        : 'Device names may appear after microphone permission.';
    } else {
      els.audioOutputHint.textContent = 'No speaker devices were reported by this browser.';
    }
    savePrefs();
    // Await so the device-refresh path doesn't race a still-applying passthrough
    // start (the audio element may not yet have finished setSinkId/play).
    await applyPassthrough();
  } catch (e) {
    setOutputDeviceListDisabled(true);
    els.audioOutputHint.textContent = 'Could not read audio output devices.';
    log('warn', 'Audio output devices unavailable: ' + (e && e.message ? e.message : e));
  }
}

function buildDeviceOption(value, label, ttsChecked, passthroughChecked) {
  const row = document.createElement('div');
  row.className = 'device-option';

  // Left side: TTS checkbox + device name
  const ttsLabel = document.createElement('label');
  ttsLabel.className = 'device-tts-label';
  const ttsCb = document.createElement('input');
  ttsCb.type = 'checkbox';
  ttsCb.className = 'dev-tts';
  ttsCb.value = value;
  ttsCb.checked = !!ttsChecked;
  const nameSpan = document.createElement('span');
  nameSpan.className = 'device-name';
  nameSpan.textContent = label;
  ttsLabel.appendChild(ttsCb);
  ttsLabel.appendChild(nameSpan);

  // Right side: passthrough mic toggle (decoupled from session lifecycle)
  const ptLabel = document.createElement('label');
  ptLabel.className = 'passthrough-toggle';
  ptLabel.title = 'Pass microphone audio to this device (runs independently of sessions)';
  const ptCb = document.createElement('input');
  ptCb.type = 'checkbox';
  ptCb.className = 'dev-passthrough';
  ptCb.value = value;
  ptCb.checked = !!passthroughChecked;
  const ptIcon = document.createElement('span');
  ptIcon.className = 'pt-icon';
  ptIcon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-mic"/></svg>';
  ptLabel.appendChild(ptCb);
  ptLabel.appendChild(ptIcon);

  row.appendChild(ttsLabel);
  row.appendChild(ptLabel);
  return row;
}

async function changeAudioOutput() {
  const ids = getSelectedOutputDeviceIds();
  els.audioOutput.dataset.preferred = JSON.stringify(ids);
  onSettingsChange();
  const session = activeSession();
  if (!session || !session.player) return;
  try {
    await session.player.setOutputDevices(ids);
    const labels = describeSelectedOutputs(ids);
    log('info', 'Audio output changed: ' + labels);
    for (const w of session.player.warnings || []) {
      const label = describeSelectedOutputs([w.deviceId || '']);
      log('warn', `Audio output ${label}: ${w.reason}.`);
    }
  } catch (e) {
    log('error', 'Audio output change failed: ' + (e && e.message ? e.message : e));
    await refreshAudioOutputDevices();
  }
}

function describeSelectedOutputs(ids) {
  if (!ids || ids.length === 0) return 'System default';
  const names = ids.map((id) => {
    const cb = els.audioOutput.querySelector(`input.dev-tts[value="${cssEscape(id)}"]`);
    if (!cb) return id || 'System default';
    const span = cb.closest('.device-option') && cb.closest('.device-option').querySelector('.device-name');
    return span ? span.textContent : (id || 'System default');
  });
  return names.join(', ');
}

function cssEscape(s) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s || '');
  return String(s || '').replace(/["\\]/g, '\\$&');
}

// ─── Per-session capture/player factories ────────────────────────────────────
function sendAudioGated(session, buf) {
  if (!session.client || session.paused) return;
  // In PTT mode we stream real audio only while the bound key is held.
  // Outside that window, send silence so the WebSocket stays warm but the
  // model receives no input to act on.
  const isPtt = session.config && session.config.pttMode === 'ptt';
  const pttMuted = isPtt && !session.pttHeld;
  if (session.muteInput || pttMuted) {
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
  // Passthrough uses the same mic — restart it with the new device.
  applyPassthrough();
}

// ─── Status pill / per-session display ────────────────────────────────────────
// Each session has a "base" status set by the Gemini Live client (idle,
// connecting, connected, translating, reconnecting, error). On top of that we
// derive two UI-only overlays:
//   - paused:  user hit the pause button; mic is gated out
//   - waiting: PTT mode is on, session is connected, but the key isn't held
// effectiveStatus combines them. refreshSessionDisplay then paints the chip
// (always) and the topbar pill (only when the session is the active one).
const STATUS_DEF = {
  idle:         { cls: 'pill-idle',         label: () => 'Idle' },
  connecting:   { cls: 'pill-connecting',   label: () => 'Connecting' },
  connected:    { cls: 'pill-listening',    label: () => 'Listening' },
  translating:  { cls: 'pill-translating',  label: () => 'Speaking' },
  reconnecting: { cls: 'pill-reconnecting', label: () => 'Reconnect' },
  error:        { cls: 'pill-error',        label: () => 'Error' },
  paused:       { cls: 'pill-paused',       label: () => 'Paused' },
  queued:       { cls: 'pill-queued',       label: () => 'Queued' },
  waiting:      { cls: 'pill-waiting',      label: () => {
    const b = state.pttBinding;
    return b ? ('Hold ' + (b.label || keyLabelFromVk(b.vkCode))) : 'Hold to talk';
  } },
};

function effectiveStatus(session) {
  if (!session || !session.running) return 'idle';
  if (session.paused) return 'paused';
  // Queued: this session has a turn ready but another session is currently
  // speaking. The mic is silenced; the chip should say so clearly rather
  // than misleadingly reading "Listening".
  if (state.ttsCoordinator && state.ttsCoordinator.isQueued(session.id)) {
    return 'queued';
  }
  // Waiting only applies while we have an open connection — there's nothing to
  // hold a key for if we're not actually listening yet.
  if (session.status === 'connected' &&
      session.config && session.config.pttMode === 'ptt' && !session.pttHeld) {
    return 'waiting';
  }
  return session.status;
}

function setSessionStatus(session, s) {
  session.status = s;
  refreshSessionDisplay(session);
}

// Repaint everything tied to a session's state — chip dot/text, topbar pill
// (if active), PiP, and per-state meter dimming. Cheap to call on any change.
function refreshSessionDisplay(session) {
  if (!session) return;
  const eff = effectiveStatus(session);
  const def = STATUS_DEF[eff] || STATUS_DEF.idle;
  const text = def.label();

  if (session.tabEl) session.tabEl.dataset.status = eff;
  if (session.tabStatusEl) session.tabStatusEl.textContent = text;

  if (isActive(session)) {
    els.statusPill.className = 'pill ' + def.cls;
    els.statusText.textContent = text;
    if (state.pip) {
      state.pip.setStatus(text, eff === 'translating' || eff === 'connected');
    }
  }
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

  // Decide BEFORE mutating: if the user has scrolled up to read earlier turns,
  // don't yank them back to the bottom on every new chunk. 64 px tolerance
  // covers "I'm at the bottom" including sub-pixel positions from native
  // smooth scrolling or a partial last line.
  const el = session.transcriptEl;
  const autoScroll = !el || (el.scrollHeight - el.scrollTop - el.clientHeight < 64);

  if (session.pendingInput) {
    if (t.inputText === '') {
      t.inputEl.classList.remove('empty');
      t.inputTextNode.nodeValue = '';
      t.inputCaret.style.display = '';
    }
    t.inputText += session.pendingInput;
    t.inputTextNode.nodeValue = t.inputText;
    session.pendingInput = '';
    if (state.pip && isActive(session)) state.pip.setInput(t.inputText);
  }
  if (session.pendingOutput) {
    if (t.outputEl) {
      if (t.outputText === '') {
        t.outputEl.classList.remove('empty');
        t.outputTextNode.nodeValue = '';
        if (t.outputCaret) t.outputCaret.style.display = '';
      }
      t.outputText += session.pendingOutput;
      t.outputTextNode.nodeValue = t.outputText;
      if (state.pip && isActive(session)) state.pip.setOutput(t.outputText);
    }
    session.pendingOutput = '';
  }
  if (el && autoScroll) {
    el.scrollTop = el.scrollHeight;
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
  // Hold an explicit text-node reference so flushPending / finalizeTurn can
  // mutate it without assuming a particular child order. The previous code
  // relied on inText.firstChild — fragile if the empty-state placeholder were
  // ever rendered differently.
  const inTextNode = document.createTextNode('listening…');
  inText.appendChild(inTextNode);
  const inCaret = document.createElement('span'); inCaret.className = 'caret'; inCaret.style.display = 'none';
  inText.appendChild(inCaret);
  inRow.appendChild(inLab); inRow.appendChild(inText);

  let outText = null, outCaret = null, outTextNode = null;
  if (!isTranscribe) {
    const outRow = document.createElement('div');
    outRow.className = 'turn-row output';
    const outLab = document.createElement('span');
    outLab.className = 'turn-label';
    outLab.textContent = '→ ' + langName(session.config.target);
    outText = document.createElement('span');
    outText.className = 'turn-text empty';
    outTextNode = document.createTextNode('…');
    outText.appendChild(outTextNode);
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
    inputTextNode: inTextNode,
    outputTextNode: outTextNode,
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
  if (!t.inputText.trim())  { t.inputEl.classList.add('empty');  t.inputTextNode.nodeValue = '(silence)'; }
  if (t.outputEl && !t.outputText.trim()) { t.outputEl.classList.add('empty'); t.outputTextNode.nodeValue = '(no translation)'; }
  t.root.classList.remove('live');
  session.liveTurn = null;
}

// Per-session level → meter-fill width. Same sqrt curve as before, just
// painted into the chip-local meter elements. Updates run for ALL sessions
// (not just the active one) so the user can see every running session's
// activity in the tab strip at once.
function levelToPct(level) {
  return level <= 0 ? 0 : Math.min(100, Math.sqrt(level) * 110);
}

function paintMeterFill(el, level) {
  if (!el) return;
  el.style.width = levelToPct(level) + '%';
}

function setMicLevelFor(session, level) {
  // Paused sessions: freeze the meter at zero so the user clearly sees the mic
  // is NOT reaching the model, even though the capture is technically still
  // open. PTT-waiting sessions still show real level — that confirms the mic
  // is hearing them, while the status text says "Hold [KEY]".
  if (session.paused) level = 0;
  session.lastMicLevel = level;
  paintMeterFill(session.tabMicFill, level);
}

function setOutLevelFor(session, level) {
  session.lastOutLevel = level;
  paintMeterFill(session.tabOutFill, level);
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
    els.btnPause.setAttribute('aria-label', 'Pause mic');
    els.btnPause.setAttribute('aria-pressed', 'false');
    setControlsLocked(false);
    return;
  }
  els.btnStart.disabled = session.running;
  els.btnStop.disabled = !session.running;
  els.btnHush.disabled = !session.running || !session.isAudio;
  els.btnPause.disabled = !session.running;
  els.btnPause.classList.toggle('is-paused', !!session.paused);
  els.btnPause.title = session.paused ? 'Resume mic' : 'Pause mic';
  // Keep aria-label and aria-pressed in sync so SR users hear the right state.
  els.btnPause.setAttribute('aria-label', session.paused ? 'Resume mic' : 'Pause mic');
  els.btnPause.setAttribute('aria-pressed', session.paused ? 'true' : 'false');
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
      outputDeviceIds: normalizeOutputDeviceIds(cfg.outputDeviceIds, cfg.outputDeviceId),
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

  const isPtt = cfg.pttMode === 'ptt';

  session.client = new GeminiLive.GeminiLiveClient({
    apiKey,
    voice: cfg.voice,
    systemInstruction,
    vad: cfg.vad,
    // manualActivity disables Gemini's auto VAD so we control turn boundaries
    // via activityStart/activityEnd (sent from the PTT key handlers below).
    manualActivity: isPtt,
    resumeHandle: session.resumeHandle || null,
    onResumeHandle: (handle) => {
      session.resumeHandle = handle || null;
      saveSessions();
    },
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

  // PTT integration: subscribe to global hotkey events. The PttHotkeyClient
  // fans out down/up to all subscribed sessions; here we translate to
  // activity signals + the pttHeld flag that gates audio streaming.
  if (isPtt && state.pttClient) {
    if (!state.companionAvailable) {
      log('warn', 'Push-to-talk needs the companion app to be running — the session will receive only silence until you switch to Auto VAD or start it.');
    } else if (!state.pttBinding) {
      log('warn', 'Push-to-talk enabled but no hotkey is bound — open Settings → Speech detection to bind a key.');
    }
    state.pttClient.subscribe(session.id,
      () => {
        session.pttHeld = true;
        if (session.client) session.client.sendActivityStart();
        // The chip status flips from "Hold KEY" → "Listening" on the same
        // frame the key goes down, so the user sees an immediate response.
        refreshSessionDisplay(session);
      },
      () => {
        session.pttHeld = false;
        if (session.client) session.client.sendActivityEnd();
        refreshSessionDisplay(session);
      });
  }

  try {
    if (isAudio) {
      await session.player.ensureCtx();
      for (const w of session.player.warnings || []) {
        const label = describeSelectedOutputs([w.deviceId || '']);
        log('warn', `Audio output ${label}: ${w.reason}.`);
      }
    }
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
  refreshBulkActionButtons();

  session.startedAt = Date.now();
  if (session.ageTimer) clearInterval(session.ageTimer);
  session.ageTimer = setInterval(() => {
    const txt = fmtDuration(Date.now() - session.startedAt);
    if (session.tabAgeEl) session.tabAgeEl.textContent = txt;
    if (isActive(session)) els.sessionAge.textContent = txt;
  }, 1000);
  // Paint once immediately so the chip doesn't read "00:00" for a full second.
  if (session.tabAgeEl) session.tabAgeEl.textContent = '00:00';

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
  // Idempotency guard. Stop can be triggered by user click, WS close, the
  // display-share track ending, or page unload — sometimes concurrently. The
  // body below isn't safe to run twice (player.destroy and friends throw on a
  // freed AudioContext), so we early-return on subsequent calls. The flag
  // stays true after we finish — once stopped, a session is only restarted
  // through startSession which resets the state we care about.
  if (!session || session._stopping) return;
  session._stopping = true;
  if (session.player) {
    try { session.player.hush(); } catch (_) {}
  }
  state.ttsCoordinator.unregister(session);
  if (state.pttClient) state.pttClient.unsubscribe(session.id);
  session.pttHeld = false;
  if (session.client && session.client.resumeHandle) {
    session.resumeHandle = session.client.resumeHandle;
    saveSessions();
  }
  try { session.client && session.client.stop(); } catch (_) {}
  try { session.capture && session.capture.stop(); } catch (_) {}
  try { if (session.player) await session.player.destroy(); } catch (_) {}
  session.client = null;
  session.capture = null;
  session.player = null;
  session.currentAudioMode = '';
  session.running = false;
  session.paused = false;
  if (session.ageTimer) { clearInterval(session.ageTimer); session.ageTimer = 0; }
  finalizeTurn(session);
  setSessionStatus(session, 'idle');
  // Stale meter state would imply audio is still flowing; zero it explicitly.
  session.lastMicLevel = 0;
  session.lastOutLevel = 0;
  paintMeterFill(session.tabMicFill, 0);
  paintMeterFill(session.tabOutFill, 0);
  if (session.tabAgeEl) session.tabAgeEl.textContent = '00:00';
  if (isActive(session)) {
    applyControlButtonsForActiveSession();
    els.sessionAge.textContent = '00:00';
  }
  refreshBulkActionButtons();
  session._stopping = false;
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
  els.speechMode.disabled    = locked;
  els.vadPreset.disabled     = locked;
  els.vadStart.disabled      = locked;
  els.vadEnd.disabled        = locked;
  els.vadPrefix.disabled     = locked;
  els.vadSilence.disabled    = locked;
  // PTT key binding is global, not session config — leave it editable when
  // a session is running so the user can change the hotkey mid-session.
}

function togglePause() {
  const session = activeSession();
  if (!session || !session.running) return;
  session.paused = !session.paused;
  // Pause-while-speaking should also stop the model's current TTS output —
  // the user explicitly wants quiet. Coordinator clears the queue slot and
  // suppresses leftover chunks of the in-flight turn.
  if (session.paused) {
    state.ttsCoordinator.hush(session);
    // Freeze the mic meter visually so the user can see the model is no
    // longer hearing them.
    paintMeterFill(session.tabMicFill, 0);
    session.lastMicLevel = 0;
  }
  applyControlButtonsForActiveSession();
  refreshSessionDisplay(session);  // chip + pill now read "Paused" / "Listening"
  log('info', session.paused ? 'Mic paused.' : 'Mic resumed.');
}

// ─── Sheets ──────────────────────────────────────────────────────────────────
// Modal dialog plumbing: focus trap, focus restore on close, and ESC handling
// for the topmost open sheet. On desktop the sidebar is a landmark, not a
// dialog — we only promote it to role=dialog while it's modally open on mobile.

// Tracks the trigger element and trap state per opened modal so we can restore
// focus exactly where the user came from, even when sheets are layered (e.g.
// opening Log from inside Settings).
const modalState = new Map(); // sheetId -> { opener, trapHandler, content, restoreRole }

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusableIn(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
}

// The sidebar's modal-ness depends on viewport: on desktop it's docked, so
// opening it is a no-op and we must not trap focus. Mirrors the CSS breakpoint.
function isSidebarDocked() {
  return window.matchMedia('(min-width: 1024px)').matches;
}

function openSheet(id) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.classList.contains('is-open')) return;

  // Sidebar on desktop is permanently visible; openSheet shouldn't promote it
  // to a modal or move focus there.
  const isSidebar = id === 'sidebar';
  if (isSidebar && isSidebarDocked()) {
    el.classList.add('is-open');
    return;
  }

  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const content = el.querySelector('.sheet-content, .sidebar-inner');
  el.classList.add('is-open');

  let restoreRole = null;
  if (isSidebar && content) {
    // Promote landmark → dialog only while modal; remember to flip back on close.
    restoreRole = content.getAttribute('role');
    content.setAttribute('role', 'dialog');
    content.setAttribute('aria-modal', 'true');
  }

  const trapHandler = (ev) => {
    if (ev.key !== 'Tab') return;
    const focusables = getFocusableIn(content);
    if (focusables.length === 0) {
      ev.preventDefault();
      if (content) content.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (ev.shiftKey && (active === first || !content.contains(active))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && (active === last || !content.contains(active))) {
      ev.preventDefault();
      first.focus();
    }
  };
  if (content) content.addEventListener('keydown', trapHandler);

  modalState.set(id, { opener, trapHandler, content, restoreRole });

  // Defer focus by one frame so the slide-up animation doesn't fight the
  // mobile keyboard or scroll the body.
  requestAnimationFrame(() => {
    const focusables = getFocusableIn(content);
    const target = focusables[0] || content;
    if (target) {
      try { target.focus({ preventScroll: false }); }
      catch (_) { try { target.focus(); } catch (__) {} }
    }
  });
}

function closeSheet(id) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!el.classList.contains('is-open')) return;
  el.classList.remove('is-open');

  const state = modalState.get(id);
  if (!state) return;                  // wasn't opened modally (e.g., docked sidebar)
  modalState.delete(id);

  if (state.content && state.trapHandler) {
    state.content.removeEventListener('keydown', state.trapHandler);
  }
  if (state.content && state.restoreRole !== null) {
    state.content.setAttribute('role', state.restoreRole);
    state.content.removeAttribute('aria-modal');
  }
  // Restore focus to whoever opened the sheet. If they vanished (e.g., a tab
  // was closed), fall back to body so focus isn't stuck on a detached element.
  if (state.opener && document.contains(state.opener)) {
    try { state.opener.focus({ preventScroll: true }); }
    catch (_) { try { state.opener.focus(); } catch (__) {} }
  }
}

// Returns the id of the topmost open modal sheet, or null if none. Iteration
// order matches the modalState insertion order (Map preserves it), so the last
// opened wins — that's the right one to close on Escape.
function topmostOpenSheet() {
  let last = null;
  for (const id of modalState.keys()) last = id;
  return last;
}

function clearConversation() {
  const session = activeSession();
  if (!session) return;
  // No confirmation when there's nothing to lose — empty state is the only
  // child, so clearing is a visual no-op anyway.
  const turnCount = session.transcriptEl
    ? session.transcriptEl.querySelectorAll(':scope > .turn').length
    : 0;
  if (turnCount > 0 && !window.confirm('Clear this session\'s conversation?')) return;
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
  // Save verbatim. Empty trimmed value clears the override (same as Reset).
  // No string-equality check with builtins — see the comment above
  // effectivePromptTemplateFor for why that was removed.
  state.systemPromptTemplate = v || null;
  savePrefs();
  closeSheet('prompt-sheet');
  log('info', state.systemPromptTemplate
        ? 'Custom system prompt saved (takes effect on next Start).'
        : 'System prompt cleared — using default for the current mode.');
}
function resetPromptEditor() {
  // Explicit "use default" — drops any custom override and closes. The user
  // can reopen to inspect the resolved default in the textarea.
  state.systemPromptTemplate = null;
  savePrefs();
  closeSheet('prompt-sheet');
  log('info', 'System prompt reset to default for the current mode.');
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
    // Pull the palette from the main document's CSS variables so the PiP
    // window can never drift from the app theme. Falls back to literal
    // hex values when a custom property is missing (host page didn't ship
    // them, or the PiP was opened from a barebones context).
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
    const palette = {
      bg0:    v('--bg-0',      '#0b0d12'),
      bg1:    v('--bg-1',      '#11141b'),
      bg3:    v('--bg-3',      '#1d2230'),
      fg0:    v('--fg-0',      '#e8ecf3'),
      fg1:    v('--fg-1',      '#aab2c4'),
      fg2:    v('--fg-2',      '#8a93a8'),
      accent: v('--accent',    '#7c9cff'),
      accent2:v('--accent-2',  '#a78bfa'),
      line:   v('--line-soft', '#1c2230'),
    };
    const style = doc.createElement('style');
    style.textContent = `
      html, body {
        margin: 0; height: 100%;
        background: ${palette.bg0}; color: ${palette.fg0};
        font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
        display: flex; flex-direction: column; overflow: hidden;
      }
      header {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 14px; border-bottom: 1px solid ${palette.line};
        background: ${palette.bg1}; flex: 0 0 auto;
      }
      .pip-pill {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 10px; border-radius: 999px;
        font-size: 11px; font-weight: 600;
        background: ${palette.bg3};
      }
      .pip-dot { width: 6px; height: 6px; border-radius: 50%; background: ${palette.fg2}; }
      .pip-dot.live { background: ${palette.accent}; animation: p 0.8s infinite; }
      @keyframes p { 0%,100%{ opacity:1; } 50%{ opacity:0.4; } }
      .pip-brand { font-weight: 600; font-size: 13px; }
      main {
        flex: 1; padding: 14px 16px; overflow-y: auto;
        display: flex; flex-direction: column; gap: 12px;
      }
      .pip-label {
        font-size: 10px; font-weight: 700; letter-spacing: 0.6px;
        text-transform: uppercase; color: ${palette.fg2}; margin-bottom: 4px;
      }
      .pip-input-lab { color: ${palette.accent}; }
      .pip-output-lab { color: ${palette.accent2}; }
      .pip-input { font-size: 15px; color: ${palette.fg1}; line-height: 1.45; word-wrap: break-word; }
      .pip-output { font-size: 20px; font-weight: 500; line-height: 1.4; word-wrap: break-word; }
      .pip-empty { color: ${palette.fg2}; font-style: italic; }
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
  if (session) {
    seedPipFromSession(session);
  } else {
    pip.setStatus(els.statusText.textContent, false);
    pip.setLangs(langName(els.langSource.value), langName(els.langTarget.value));
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
    log('info', 'Playback silenced');
  });
  els.btnClear.addEventListener('click', clearConversation);
  els.btnSwap.addEventListener('click', () => {
    const a = els.langSource.value;
    els.langSource.value = els.langTarget.value;
    els.langTarget.value = a;
    onSettingsChange();
  });
  els.btnShowKey.addEventListener('click', () => {
    const willShow = els.apiKey.type === 'password';
    els.apiKey.type = willShow ? 'text' : 'password';
    // aria-pressed reflects whether the key is currently revealed — gives
    // screen-reader users a clear "this toggle is on/off" announcement.
    els.btnShowKey.setAttribute('aria-pressed', willShow ? 'true' : 'false');
  });
  els.modeSelect.addEventListener('change', () => {
    updateUIVisibility();
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
    updateUIVisibility();
    onSettingsChange();
  });
  els.speechMode.addEventListener('change', () => {
    updateSpeechModeFields();
    onSettingsChange();
  });
  if (els.btnPttKey) {
    els.btnPttKey.addEventListener('click', beginPttCapture);
  }
  if (els.btnPttClear) {
    els.btnPttClear.addEventListener('click', clearPttBinding);
  }
  if (els.companionApp) {
    els.companionApp.addEventListener('change', () => {
      els.companionApp.dataset.preferred = els.companionApp.value;
      onSettingsChange();
    });
  }
  if (els.btnRefreshApps) {
    els.btnRefreshApps.addEventListener('click', () => refreshCompanionApps({ silent: false }));
  }
  els.dirSelect.addEventListener('change', () => {
    updateUIVisibility();
    onSettingsChange();
  });
  for (const sel of [els.langSource, els.langTarget, els.voice]) {
    sel.addEventListener('change', onSettingsChange);
  }
  els.audioInput.addEventListener('change', changeAudioInput);
  els.audioOutput.addEventListener('change', (e) => {
    if (e.target.classList.contains('dev-passthrough')) {
      savePrefs();
      applyPassthrough();
    } else {
      changeAudioOutput();
    }
  });
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
  if (els.btnStartAll) {
    els.btnStartAll.addEventListener('click', () => startAllSessions());
  }
  if (els.btnStopAll) {
    els.btnStopAll.addEventListener('click', () => stopAllSessions());
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

    // WAI-ARIA tab pattern: arrow keys move focus + selection within the
    // tablist; Home/End jump to the ends; Delete closes the focused tab; Enter
    // is redundant with click but supported for completeness. Letting arrows
    // also activate the tab (auto-activation) is fine for our use because the
    // panel switch is cheap and matches the user's mental model.
    els.tabList.addEventListener('keydown', (ev) => {
      const chip = ev.target.closest('.tab-chip');
      if (!chip || !els.tabList.contains(chip)) return;
      const keys = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete', 'Enter', ' ']);
      if (!keys.has(ev.key)) return;

      // Only consider currently visible chips — simple mode hides everything
      // but the active one, and arrow nav over an invisible target is jarring.
      const chips = Array.from(els.tabList.querySelectorAll('.tab-chip'))
        .filter((c) => c.offsetParent !== null);
      if (chips.length === 0) return;
      const here = chips.indexOf(chip);

      if (ev.key === 'Delete') {
        ev.preventDefault();
        closeSession(state.sessions.get(chip.dataset.sessionId));
        return;
      }
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        setActiveSession(chip.dataset.sessionId);
        return;
      }

      let nextIdx;
      if (ev.key === 'ArrowLeft')  nextIdx = here <= 0 ? chips.length - 1 : here - 1;
      else if (ev.key === 'ArrowRight') nextIdx = here >= chips.length - 1 ? 0 : here + 1;
      else if (ev.key === 'Home')  nextIdx = 0;
      else /* End */               nextIdx = chips.length - 1;
      ev.preventDefault();
      const target = chips[nextIdx];
      if (!target) return;
      setActiveSession(target.dataset.sessionId);
      // setActiveSession moves tabindex=0 to the new chip; focus it explicitly
      // so the user's keyboard caret follows their selection.
      try { target.focus(); } catch (_) {}
    });
  }

  // Empty-state "Settings" button is created dynamically per session — use
  // event delegation so we don't re-bind on every render. On desktop the
  // sidebar is always visible so openSheet is a no-op; either way, focusing
  // the API key field is the actually useful action.
  if (els.turnsHost) {
    els.turnsHost.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-empty-action="open-settings"]')) {
        openSheet('sidebar');
        // Give the sheet a beat to slide up on mobile before focusing, so the
        // mobile keyboard doesn't race the animation.
        setTimeout(() => {
          try { els.apiKey.focus({ preventScroll: false }); } catch (_) { els.apiKey.focus(); }
        }, 220);
      }
    });
  }

  // Generic sheet close handlers
  document.addEventListener('click', (ev) => {
    const tgt = ev.target.closest('[data-close]');
    if (tgt) closeSheet(tgt.getAttribute('data-close'));
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    // Close only the topmost open modal so layered sheets (e.g. Log opened
    // from inside Settings) close one at a time, matching native dialog UX.
    const id = topmostOpenSheet();
    if (id) {
      ev.preventDefault();
      closeSheet(id);
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
    try { state.micPassthrough.stop(); } catch (_) {}
    if (state.pip) state.pip.close();
  });
  window.addEventListener('focus', () => detectCompanionService());

  // Browsers auto-suspend AudioContexts when the tab is hidden long enough.
  // Without an explicit resume, TTS output would stay silent and capture
  // worklets would stop posting messages even after the user came back.
  // Iterate every per-session context plus the global passthrough on each
  // unhide; resume() is a no-op on already-running contexts.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const ctxs = [];
    for (const session of state.sessions.values()) {
      if (session.player && session.player.ctx) ctxs.push(session.player.ctx);
      if (session.capture && session.capture.ctx) ctxs.push(session.capture.ctx);
    }
    if (state.micPassthrough && state.micPassthrough.ctx) ctxs.push(state.micPassthrough.ctx);
    for (const ctx of ctxs) {
      if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    }
  });

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
  // Construct the PTT client up front so subscribe() works the moment a PTT
  // session starts. Apply any saved binding immediately; if no session is
  // active yet, the client stays disconnected until subscribe() arrives.
  state.pttClient = new PttHotkeyClient({ wsUrl: COMPANION_PTT_URL });
  if (state.pttBinding) state.pttClient.setBinding(state.pttBinding);
  state.pttClient.onAvailabilityChange = () => updatePttButton();
  restoreSessionsFromStorage();
  detectCompanionService();
  refreshAudioInputDevices();
  refreshAudioOutputDevices();
  updateSpeechModeFields();
  updatePttButton();
  if (checkSupport()) log('info', 'Ready.');
});
