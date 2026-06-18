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

// Target languages for the Live Translation engine (gemini-3.5-live-translate).
// These are BCP-47 codes from the model's supported list, which differ from the
// short ISO codes in LANGUAGES above — Chinese is zh-Hans/zh-Hant (not zh) and
// Portuguese is pt-BR/pt-PT (not pt) — so this engine needs its own list rather
// than reusing LANGUAGES. The model auto-detects the source, so only a target
// is ever selected. Curated subset of the ~70 supported languages.
const TRANSLATE_LANGUAGES = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt-BR', 'Portuguese (Brazil)'],
  ['pt-PT', 'Portuguese (Portugal)'],
  ['nl', 'Dutch'],
  ['pl', 'Polish'],
  ['ru', 'Russian'],
  ['uk', 'Ukrainian'],
  ['tr', 'Turkish'],
  ['ar', 'Arabic'],
  ['he', 'Hebrew'],
  ['fa', 'Persian'],
  ['hi', 'Hindi'],
  ['bn', 'Bengali'],
  ['ur', 'Urdu'],
  ['ta', 'Tamil'],
  ['te', 'Telugu'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh-Hans', 'Chinese (Simplified)'],
  ['zh-Hant', 'Chinese (Traditional)'],
  ['id', 'Indonesian'],
  ['ms', 'Malay'],
  ['vi', 'Vietnamese'],
  ['th', 'Thai'],
  ['sw', 'Swahili'],
];
const DEFAULT_TRANSLATE_TARGET = 'es';

// The Live Translation engine streams continuously and never sends turnComplete,
// so transcript turns are segmented client-side. Finalize after a pause in
// transcription (a natural utterance boundary), and hard-cap the live turn's
// duration so a gapless source (e.g. a media player) can't accumulate one
// unbounded run-on turn that never persists.
const CONTINUOUS_TURN_IDLE_MS = 1400;
const CONTINUOUS_TURN_MAX_MS = 12000;

const MAX_TURNS = 1000;
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
    audio:      'Translates speech to text, then speaks it back.',
    text:       'Translates to text only — no spoken reply.',
    transcribe: 'Transcribes what you say in the same language.',
  },
  dir: {
    bidir:  'Both speakers are translated, each into the other\'s language.',
    oneway: 'Only your speech is translated. Useful for broadcasts.',
  },
  speechMode(mode, companionOk) {
    if (mode === 'ptt') {
      return companionOk
        ? 'Tap Speak to start; tap again to stop. Or bind a system-wide hotkey below.'
        : 'Tap Speak to start; tap again to stop.';
    }
    return 'Gemini detects when you start and stop talking.';
  },
  audioSource(canDisplay, companionOk) {
    if (!canDisplay && !companionOk) return 'Tab audio needs Chrome or Edge. Install the companion for app audio.';
    if (companionOk)                  return 'Companion detected — capture app audio without sharing your screen.';
    if (!canDisplay)                  return 'Tab audio needs Chrome or Edge. Install the companion for app audio.';
    return 'Pick mic, browser tab, or — with the companion — a specific app.';
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
  engineSelect:  segProxy($('engine-segmented')),
  engineHint:    $('engine-hint'),
  langSource:    $('lang-source'),
  langTarget:    $('lang-target'),
  langPairField: $('lang-pair-field'),
  langPairHint:  $('lang-pair-hint'),
  translateTarget:      $('translate-target'),
  translateTargetField: $('translate-target-field'),
  echoTarget:           $('echo-target'),
  echoTargetField:      $('echo-target-field'),
  voice:         $('voice'),
  audioInput:    $('audio-input'),
  audioInputHint:$('audio-input-hint'),
  audioInputLive:$('audio-input-live'),
  btnMicPreview:    $('btn-mic-preview'),
  micPreviewMeter:  $('mic-preview-meter'),
  micPreviewFill:   $('mic-preview-fill'),
  audioSource:   segProxy($('audio-source-segmented')),
  audioHint:     $('audio-source-hint'),
  companionApp:      $('companion-app'),
  companionAppField: $('companion-app-field'),
  companionAppHint:  $('companion-app-hint'),
  btnRefreshApps:    $('btn-refresh-apps'),
  audioOutput:   $('audio-output'),
  audioOutputSection: $('audio-output-section'),
  audioOutputHint:$('audio-output-hint'),
  passthroughOutput: $('passthrough-output'),
  passthroughOutputSection: $('passthrough-output-section'),
  passthroughOutputHint: $('passthrough-output-hint'),
  btnDetectDevices: $('btn-detect-devices'),
  translationSection: $('translation-section'),
  modeField:     $('mode-field'),
  modeSelect:    segProxy($('mode-segmented')),
  modeHint:      $('mode-hint'),
  dirSelect:     segProxy($('dir-segmented')),
  dirField:      $('dir-field'),
  dirHint:       $('dir-hint'),
  speechSection: $('speech-section'),
  promptSection: $('prompt-section'),
  voiceSection:  $('voice-section'),
  micSection:    $('mic-section'),
  speechMode:    segProxy($('speech-mode-segmented')),
  speechModeHint:$('speech-mode-hint'),
  vadAutoFields: $('vad-auto-fields'),
  vadPttFields:  $('vad-ptt-fields'),
  vadPreset:     $('vad-preset'),
  vadCustomFields: $('vad-custom-fields'),
  vadStart:      segProxy($('vad-start-segmented')),
  vadEnd:        segProxy($('vad-end-segmented')),
  vadPrefix:     $('vad-prefix'),
  vadSilence:    $('vad-silence'),
  btnSwap:       $('btn-swap'),
  btnStart:      $('btn-start'),
  btnStop:       $('btn-stop'),
  btnHush:       $('btn-hush'),
  btnPause:      $('btn-pause'),
  btnPtt:        $('btn-ptt'),
  // Per-session Clear / Export live in each session header strip (built in
  // createSessionDOM). No global els.* lookups for those buttons.
  btnMenu:       $('btn-menu'),
  btnLog:        $('btn-log'),
  btnForceReset: $('btn-force-reset'),
  btnPip:        $('btn-pip'),
  btnPipQuick:   $('btn-pip-quick'),
  btnEditPrompt: $('btn-edit-prompt'),
  btnSavePrompt: $('btn-save-prompt'),
  btnResetPrompt:$('btn-reset-prompt'),
  btnPttKey:     $('btn-ptt-key'),
  btnPttClear:   $('btn-ptt-clear'),
  pttMode:       segProxy($('ptt-mode-segmented')),
  pttModeHint:   $('ptt-mode-hint'),
  pttExclusive:  $('ptt-exclusive'),
  pttKeyLabel:   $('ptt-key-label'),
  pttHint:       $('ptt-hint'),
  promptText:    $('prompt-text'),
  sidebar:       $('sidebar'),
  promptSheet:   $('prompt-sheet'),
  logSheet:      $('log-sheet'),
  tabList:       $('tab-list'),
  btnNewSession: $('btn-new-session'),
  btnStartAll:   $('btn-start-all'),
  btnStopAll:    $('btn-stop-all'),
  turnsHost:     $('turns-host'),
  modeSwitch:    $('mode-switch'),
  log:           $('log'),
  btnTestGoaway: $('btn-test-goaway'),
  btnTestWsclose:$('btn-test-wsclose'),
  btnLogExport:  $('btn-log-export'),
  btnLogClear:   $('btn-log-clear'),
  btnOpenCompanion:      $('btn-open-companion'),
  btnOpenCompanionLabel: $('btn-open-companion-label'),
  companionLaunchNotice: $('companion-launch-notice'),
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
    this.switching = false;        // True from GoAway received → setupComplete

    this.running = false;
    this.paused = false;
    this.status = 'idle';

    // Audio source actually in use (may differ from config if a fallback fired).
    this.currentAudioMode = '';

    // Wall-clock when the session connected; drives the age display.
    this.startedAt = 0;

    // Live transcript bookkeeping.
    this.liveTurn = null;
    this.pendingInput = '';
    this.pendingOutput = '';
    this.pendingScheduled = false;
    // Full finalized turn history kept in memory so the export captures
    // everything — the DOM only retains MAX_TURNS for performance.
    this.history = []; // [{ input, output, finalizedAt }]
    // Last value of history.length at the time of a successful per-session
    // (or "all sessions") export. Used by closeSession to warn when the user
    // is about to throw away turns that were never downloaded.
    this.exportedTurnCount = 0;
    // Scroll-to-bottom lock. When true, every appended chunk forces scrollTop
    // to the bottom (see flushPending). Scrolling away from the bottom in the
    // transcript flips this off; scrolling back flips it on. Persisted per
    // session so the user's choice survives reloads.
    this.followLatest = true;

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

    // Per-session audio passthrough. One instance per Session — its enabled
    // set (config.passthroughDeviceIds) and lifecycle are independent of
    // running/stopped. Sources (mic, display, companion PCM) attach during
    // startSession and detach during stopSession; the sink graph itself
    // survives across cycles so the user's chosen routing isn't lost.
    this.micPassthrough = new LiveAudio.CompanionPassthrough({
      onLevel: (l) => paintPassthroughLevel(this, l),
    });
  }

  // The translate engine always speaks the translation, regardless of the
  // (live-engine-only) mode field.
  get isAudio() { return this.config.engine === 'translate' || this.config.mode === 'audio'; }
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
    // Optional callback invoked the moment a session is promoted to speaker
    // (PiP uses this to follow whoever's actually talking, decoupled from
    // which session is currently active in the UI).
    this.onSpeakerStart = null;
  }

  _setCurrentSpeaker(id) {
    this.currentSpeakerId = id;
    if (id && typeof this.onSpeakerStart === 'function') {
      try { this.onSpeakerStart(id); } catch (_) {}
    }
  }

  register(session, player) {
    if (!player) return;
    const entry = {
      session,
      player,
      buffered: [],
      wantsToSpeak: false,
      turnComplete: false,
      // The Live Translation engine streams continuously and never sends a
      // turnComplete, so its "turn" ends when playback drains rather than on a
      // turn signal. Continuous entries also skip mic gating (see enqueueChunk):
      // muting the mic on output would stall a model that's meant to keep
      // translating while the user is still talking — and with no turnComplete
      // to lift the gate, it would stay muted after the first translation.
      continuous: !!(session && session.config && session.config.engine === 'translate'),
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
      // Continuous (translate) sessions are never gated — see entry.continuous.
      if (!entry.continuous) session.muteInput = true;
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
      this._setCurrentSpeaker(sessionId);
    } else if (!this.queue.includes(sessionId)) {
      this.queue.push(sessionId);
    }
  }

  _maybeFinishSpeaking(sessionId) {
    const entry = this.entries.get(sessionId);
    // Turn-based sessions finish only on an explicit turnComplete; continuous
    // (translate) sessions have none, so they finish whenever playback drains.
    if (!entry || (!entry.turnComplete && !entry.continuous)) return;
    if (entry.player.isActive()) return;
    entry.wantsToSpeak = false;
    entry.turnComplete = false;
    entry.session.muteInput = false;
    this.currentSpeakerId = null;
    // Continuous sessions get no turnComplete to drive finalizeTurn from
    // gemini-live, so a drained playback (a pause in the translation) is the
    // turn boundary: persist the accumulated transcript and start a fresh turn
    // on the next chunk. (finalizeTurn no-ops when there's no live turn, so the
    // turn-based path that already finalized via onTurnComplete is unaffected.)
    if (entry.continuous) {
      try { finalizeTurn(entry.session); } catch (_) {}
    }
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
      this._setCurrentSpeaker(nextId);
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
    this.binding = null;          // {vkCode, ctrl, shift, alt, win, label, exclusive, mode}
    this.subscribers = new Map(); // sessionId -> {onDown, onUp}
    this.connected = false;
    this._reconnectTimer = 0;
    this._wantConnect = false;
    this.onAvailabilityChange = () => {};
    // Subscriber-facing "is mic engaged" state. In 'hold' mode this tracks the
    // physical key (down = engaged, up = released). In 'toggle' mode it's a
    // virtual state flipped on each physical key-down; physical key-ups are
    // ignored.
    this._held = false;
    this.mode = 'hold';           // 'hold' | 'toggle'
  }

  setBinding(binding) {
    this.binding = binding;
    this._sendBinding();
  }

  // 'hold'   — engage while the key is physically held (current default).
  // 'toggle' — tap to engage, tap again to release; physical releases ignored.
  setMode(mode) {
    if (mode !== 'hold' && mode !== 'toggle') return;
    if (mode === this.mode) return;
    this.mode = mode;
    // Releasing on mode change avoids a "stuck on" state if the user switches
    // mid-press: e.g. toggle-mode-on then switch to hold while engaged would
    // otherwise leave subscribers thinking the mic is still live with no
    // physical release to bring it back down.
    if (this._held) {
      this._held = false;
      this._broadcast('up');
    }
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
      if (msg.event === 'down') {
        if (this.mode === 'toggle') {
          // Each physical key-down flips the virtual state. Treat the flip
          // as the corresponding subscriber event so the rest of the app
          // doesn't need to know about toggle mode.
          this._held = !this._held;
          this._broadcast(this._held ? 'down' : 'up');
        } else if (!this._held) {
          this._held = true;
          this._broadcast('down');
        }
      } else if (msg.event === 'up') {
        // Toggle mode ignores physical releases; the next key-down is what
        // ends the engaged state.
        if (this.mode === 'hold' && this._held) {
          this._held = false;
          this._broadcast('up');
        }
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
        vkCode:    b.vkCode,
        ctrl:      !!b.ctrl,
        shift:     !!b.shift,
        alt:       !!b.alt,
        win:       !!b.win,
        exclusive: !!b.exclusive,
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
  // Audio passthrough is per-session (session.micPassthrough); see the
  // Session constructor. There is no global passthrough — each session owns
  // its own routing, and its config (passthroughDeviceIds) survives
  // start/stop cycles independently of the others.

  // Lazily allocated InputPreview for the settings panel's mic visualizer.
  // Stays null until the user clicks the preview button.
  inputPreview: null,
  // Saved sessions that were over MAX_SESSIONS at restore time. Not loaded
  // into memory or rendered, but threaded through every saveSessions() write
  // so they're preserved verbatim — if MAX_SESSIONS is bumped up in a future
  // build (or the user deletes a visible session), the old ones can return.
  archivedSessions: [],

  // PIP-pane prefs: { displayMode: 'both'|'input'|'output', fontStep: int }
  // Owned by the PipController but persisted in this global prefs blob so a
  // re-pop-out picks up the user's last choices instead of resetting.
  pipPrefs: { displayMode: 'both', fontStep: 1 },

  // Most recent deviceId the OS picked when something requested "System
  // default" for the mic. Surfaced in the input dropdown so the user can see
  // which physical device is actually being recorded.
  resolvedMicDeviceId: '',
  // The session that most recently produced TTS audio. PiP tracks this rather
  // than the active session so it follows whoever's actually speaking; once
  // a session has spoken, PiP stays on it until another session speaks.
  lastSpeakingSessionId: null,
  // The session id the PiP is currently mirroring. Used to suppress redundant
  // re-seeds when chunk callbacks happen on the same session repeatedly.
  pipFollowingSessionId: null,

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
  // Companion-enumerated render endpoints for the passthrough section.
  // Refreshed by refreshPassthroughOutputDevices() whenever the companion
  // becomes available or the user clicks the refresh button.
  passthroughOutputs: [],
};

// Mirror the TTS coordinator's "who's speaking now" signal into PiP follow
// state. We point PiP at whichever session just started speaking; once that
// session falls silent, the PiP stays parked there until another session
// starts to speak (which is what the user asked for — last-speaker wins).
state.ttsCoordinator.onSpeakerStart = (sessionId) => {
  state.lastSpeakingSessionId = sessionId;
  const session = state.sessions.get(sessionId);
  if (!session || !state.pip) return;
  if (state.pipFollowingSessionId === sessionId) return;
  state.pipFollowingSessionId = sessionId;
  seedPipFromSession(session);
};

// Three UI modes (Basic / Advanced / Full) sorted by how much chrome they
// expose. Used by setUIMode for validation and by requestUIModeChange to
// detect "narrowing" transitions (which trigger a reset confirm).
const UI_MODES = ['simple', 'mid', 'full'];

function setUIMode(mode) {
  if (!UI_MODES.includes(mode)) mode = 'simple';
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

// Settings that only the "Full" mode exposes — translation mode, direction,
// and the system-prompt override. Going Full → Advanced (mid) resets them so
// hidden state can't keep affecting sessions in a way the user can't see.
function resetFullOnlySettings() {
  els.modeSelect.value = 'audio';
  els.dirSelect.value = 'bidir';
  state.systemPromptTemplate = null;
}

function resetAdvancedSettingsForBasic() {
  // Includes the Full-only resets so the "narrow all the way" path doesn't
  // skip any layer.
  resetFullOnlySettings();
  els.audioSource.value = 'mic';
  els.audioInput.value = '';
  els.audioInput.dataset.preferred = '';
  els.audioOutput.dataset.preferred = JSON.stringify(['']);
  if (els.passthroughOutput) els.passthroughOutput.dataset.preferred = JSON.stringify([]);
  setPassthroughDeviceIds([]);
  setSelectedOutputDeviceIds(['']);
  els.speechMode.value = 'auto';
  els.vadPreset.value = DEFAULT_VAD_PRESET;
  applyVadPreset(DEFAULT_VAD_PRESET);
  if (els.companionApp) {
    els.companionApp.value = '';
    els.companionApp.dataset.preferred = '';
  }
  updateUIVisibility();
  updateAudioSourceAvailability();
  updateSpeechModeFields();
  // The reset cleared passthrough checkboxes; clear the active session's
  // config so applyPassthrough tears down its sinks too.
  const session = activeSession();
  if (session) {
    session.config.passthroughDeviceIds = [];
    applyPassthrough(session);
  }
  onSettingsChange();
}

// Full factory reset — used when the last session is closed so the auto-created
// replacement starts fresh. Resets the visible language pair + voice in
// addition to everything resetAdvancedSettingsForBasic touches. (API key, PTT
// hotkey, and UI mode are credentials / global affordances and stay put.)
function resetSettingsToFactoryDefaults() {
  resetAdvancedSettingsForBasic();
  els.langSource.value = 'en';
  els.langTarget.value = 'zh';
  els.voice.value = 'Zephyr';
  onSettingsChange();
}

function resetFullSettingsForAdvanced() {
  resetFullOnlySettings();
  updateUIVisibility();
  onSettingsChange();
}

// True iff every Full-only field is already at its default — same fields
// resetFullOnlySettings() would clobber. Lets us skip the confirm dialog when
// the narrowing transition wouldn't actually change anything.
function fullOnlySettingsAtDefault() {
  return els.modeSelect.value === 'audio'
      && els.dirSelect.value === 'bidir'
      && state.systemPromptTemplate === null;
}

// True iff every field resetAdvancedSettingsForBasic() would touch is already
// at its default. Mirrors that function so the two stay in lockstep — if a new
// field is added there, add the matching check here.
function basicResetIsNoOp() {
  if (!fullOnlySettingsAtDefault()) return false;
  if ((els.audioSource.value || 'mic') !== 'mic') return false;
  if (els.audioInput.value !== '') return false;
  if (els.speechMode.value !== 'auto') return false;
  if (els.vadPreset.value !== DEFAULT_VAD_PRESET) return false;
  const outIds = getSelectedOutputDeviceIds();
  if (outIds.length !== 1 || outIds[0] !== '') return false;
  if (getPassthroughDeviceIds().length !== 0) return false;
  if (els.companionApp && els.companionApp.value !== '') return false;
  return true;
}

async function requestUIModeChange(mode) {
  if (mode === state.uiMode) return;
  // Narrowing transitions (the new mode is to the left of the current one)
  // reset the now-hidden settings. Widening (e.g. simple → mid → full) is
  // strictly additive and needs no reset/confirm.
  const fromIdx = UI_MODES.indexOf(state.uiMode);
  const toIdx   = UI_MODES.indexOf(mode);
  const narrowing = toIdx >= 0 && fromIdx >= 0 && toIdx < fromIdx;

  if (narrowing) {
    // Skip both the running-session guard and the confirm dialog when the
    // reset is a no-op — there's nothing to disrupt and nothing to confirm.
    const noOp = mode === 'simple' ? basicResetIsNoOp() : fullOnlySettingsAtDefault();
    if (!noOp) {
      const session = activeSession();
      if (session && session.running) {
        log('warn', 'Stop the active session before narrowing the UI mode and resetting settings.');
        return;
      }
      if (mode === 'simple') {
        const ok = await showConfirm({
          title: 'Switch to Basic?',
          message: 'Resets this session\'s advanced settings — voice, mic, VAD, devices, and prompt.',
          confirmLabel: 'Switch & reset',
        });
        if (!ok) return;
        resetAdvancedSettingsForBasic();
      } else if (mode === 'mid') {
        // Full → Advanced: only the Full-only fields disappear. Reset just
        // those (mode, direction, system prompt) so the active session can't
        // keep using a configuration the user can no longer see.
        const ok = await showConfirm({
          title: 'Switch to Advanced?',
          message: 'Resets mode, direction, and the system prompt to defaults.',
          confirmLabel: 'Switch & reset',
        });
        if (!ok) return;
        resetFullSettingsForAdvanced();
      }
    }
  }
  setUIMode(mode);
}

// In-app replacement for window.confirm(). Returns a Promise<boolean> that
// resolves true on confirm, false on cancel / backdrop / ESC. Only one dialog
// can be open at a time; a second call settles the prior promise with false.
let _confirmResolver = null;
function showConfirm({ title = 'Confirm', message = '', confirmLabel = 'Confirm', confirmStyle = 'primary', cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const titleEl = $('confirm-sheet-title');
    const msgEl = $('confirm-sheet-message');
    const okBtn = $('btn-confirm-ok');
    const cancelBtn = $('btn-confirm-cancel');
    if (!titleEl || !msgEl || !okBtn || !cancelBtn) {
      resolve(window.confirm(message));
      return;
    }
    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = confirmLabel;
    okBtn.className = 'btn ' + confirmStyle;
    cancelBtn.textContent = cancelLabel;

    if (_confirmResolver) {
      const prev = _confirmResolver;
      _confirmResolver = null;
      prev(false);
    }
    _confirmResolver = resolve;
    openSheet('confirm-sheet');
  });
}

function settleConfirm(value) {
  if (!_confirmResolver) return;
  const r = _confirmResolver;
  _confirmResolver = null;
  closeSheet('confirm-sheet');
  r(value);
}

function activeSession() {
  return state.activeSessionId ? state.sessions.get(state.activeSessionId) || null : null;
}

function isActive(session) {
  return !!session && session.id === state.activeSessionId;
}

// Single point of truth for the follow-latest lock. Flips session.followLatest,
// repaints the header button (class + title + aria-pressed), optionally snaps
// the transcript to the bottom (skip with opts.skipScroll when we're already
// there — eg. auto-relock from the scroll listener), and persists. Caller is
// free to invoke it with the current value as a no-op refresh of the visuals.
function setFollowLatest(session, on, opts = {}) {
  if (!session) return;
  on = !!on;
  const changed = session.followLatest !== on;
  session.followLatest = on;
  if (session.headerLockBtn) {
    session.headerLockBtn.classList.toggle('is-following', on);
    session.headerLockBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    session.headerLockBtn.title = on
      ? 'Following latest (click to pause)'
      : 'Paused — not following (click to resume)';
  }
  if (on && !opts.skipScroll && session.transcriptEl) {
    session.transcriptEl.scrollTop = session.transcriptEl.scrollHeight;
  }
  if (changed) saveSessions();
}

// True iff the session has finalized turns past the last export point, or an
// in-progress live turn with text. Used by closeSession to warn before
// throwing away content that was never downloaded.
function sessionHasUnsavedTranscript(session) {
  if (!session) return false;
  const histCount = session.history ? session.history.length : 0;
  const lt = session.liveTurn;
  const liveText = !!(lt && (
    (lt.inputText && lt.inputText.trim()) ||
    (lt.outputText && lt.outputText.trim())
  ));
  if (histCount === 0 && !liveText) return false;
  return histCount > (session.exportedTurnCount || 0) || liveText;
}

function readConfigFromUI() {
  return {
    // 'live' = prompt-based bidirectional engine (gemini-3.1-flash-live).
    // 'translate' = dedicated Live Translation model (gemini-3.5-live-translate):
    // one-way into translateTarget, source auto-detected, no prompt/VAD/PTT.
    engine: els.engineSelect.value || 'live',
    source: els.langSource.value,
    target: els.langTarget.value,
    // BCP-47 target for the translate engine (separate from `target` above,
    // which uses the live engine's short codes).
    translateTarget: els.translateTarget ? els.translateTarget.value : DEFAULT_TRANSLATE_TARGET,
    echoTarget: !!(els.echoTarget && els.echoTarget.checked),
    voice:  els.voice.value,
    // The translate engine has no mode control; pin 'audio' so the many
    // mode-based branches (audio input, output visibility, labels, export)
    // treat it as a speaking session rather than reading a stale live-engine
    // value left in the hidden control.
    mode:   els.engineSelect.value === 'translate' ? 'audio' : els.modeSelect.value,
    dir:    els.dirSelect.value,
    vad:    currentVadConfig(),
    audioSource:    els.audioSource.value || 'mic',
    micDeviceId:    els.audioInput.value || '',
    outputDeviceIds: getSelectedOutputDeviceIds(),
    // Per-session passthrough sinks. Empty array = passthrough disabled
    // for this session. Persists across the session's start/stop cycles.
    passthroughDeviceIds: getPassthroughDeviceIds(),
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

// Engine config can't be inherited from the current-UI fallback during restore:
// a pre-feature save has no `engine`, and blindly merging would tag it with
// whatever engine is selected now. Pin it from the saved entry only (absent →
// 'live'), and ensure a target is present for translate sessions.
function applySavedEngineDefaults(cfg, savedConfig) {
  cfg.engine = (savedConfig && savedConfig.engine === 'translate') ? 'translate' : 'live';
  if (!cfg.translateTarget) cfg.translateTarget = DEFAULT_TRANSLATE_TARGET;
  cfg.echoTarget = !!(savedConfig && savedConfig.echoTarget);
  // Keep translate sessions' mode pinned to 'audio' (see readConfigFromUI).
  if (cfg.engine === 'translate') cfg.mode = 'audio';
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
    '<div class="tab-chip-devices" aria-hidden="true">' +
      '<span class="tab-dev tab-dev-in">' +
        '<span class="tab-dev-ico"></span>' +
        '<span class="tab-dev-name"></span>' +
      '</span>' +
      '<span class="tab-dev-sep">→</span>' +
      '<span class="tab-dev tab-dev-out">' +
        '<span class="tab-dev-ico"></span>' +
        '<span class="tab-dev-name"></span>' +
      '</span>' +
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
  session.tabDevicesEl = chip.querySelector('.tab-chip-devices');
  session.tabDevIn    = chip.querySelector('.tab-dev-in');
  session.tabDevOut   = chip.querySelector('.tab-dev-out');
  updateTabChip(session);
  refreshSessionDisplay(session);

  // Per-session header strip: sits above the transcript and hosts the
  // session's title + turn count, Clear, and Export (with this-session /
  // all-sessions scopes). Visibility mirrors the transcript panel —
  // .is-active is added/removed by setActiveSession.
  const header = document.createElement('div');
  header.className = 'session-header';
  header.dataset.sessionId = session.id;
  header.innerHTML =
    '<div class="session-header-meta">' +
      '<span class="session-header-title"></span>' +
      '<span class="session-header-sub"></span>' +
      '<div class="session-header-devices" aria-hidden="true">' +
        '<span class="hdr-dev hdr-dev-in">' +
          '<span class="hdr-dev-ico"></span>' +
          '<span class="hdr-dev-name"></span>' +
        '</span>' +
        '<span class="hdr-dev-sep">→</span>' +
        '<span class="hdr-dev hdr-dev-out">' +
          '<span class="hdr-dev-ico"></span>' +
          '<span class="hdr-dev-name"></span>' +
        '</span>' +
      '</div>' +
    '</div>' +
    '<div class="session-header-actions">' +
      '<button class="btn ghost session-lock" type="button" aria-pressed="true" aria-label="Toggle follow latest" title="Following latest (click to pause)">' +
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>' +
        '<span class="btn-tx">Follow</span>' +
      '</button>' +
      '<button class="btn ghost session-clear" type="button" title="Clear this session\'s conversation" aria-label="Clear chat">' +
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>' +
        '<span class="btn-tx">Clear</span>' +
      '</button>' +
      '<div class="export-wrap session-export-wrap">' +
        '<button class="btn ghost session-export" type="button" aria-haspopup="menu" aria-expanded="false" title="Export chat">' +
          '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
          '<span class="btn-tx">Export</span>' +
          '<span class="dropdown-caret" aria-hidden="true">▾</span>' +
        '</button>' +
        '<div class="export-menu" role="menu" hidden>' +
          '<div class="export-menu-group">' +
            '<div class="export-menu-label">This session</div>' +
            '<button class="export-item" type="button" role="menuitem" data-scope="session" data-format="json">JSON</button>' +
            '<button class="export-item" type="button" role="menuitem" data-scope="session" data-format="text">Text</button>' +
          '</div>' +
          '<div class="export-menu-sep" role="separator"></div>' +
          '<div class="export-menu-group">' +
            '<div class="export-menu-label">All sessions</div>' +
            '<button class="export-item" type="button" role="menuitem" data-scope="all" data-format="json">JSON</button>' +
            '<button class="export-item" type="button" role="menuitem" data-scope="all" data-format="text">Text</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  // Each session owns a vertical panel: header strip on top, transcript
  // below. Only the active panel is shown — display:none otherwise.
  const panel = document.createElement('div');
  panel.className = 'session-panel';
  panel.dataset.sessionId = session.id;
  panel.appendChild(header);
  els.turnsHost.appendChild(panel);
  session.panelEl         = panel;
  session.headerEl        = header;
  session.headerTitleEl   = header.querySelector('.session-header-title');
  session.headerSubEl     = header.querySelector('.session-header-sub');
  session.headerClearBtn  = header.querySelector('.session-clear');
  session.headerExportBtn = header.querySelector('.session-export');
  session.headerExportMenu = header.querySelector('.export-menu');
  session.headerDevicesEl = header.querySelector('.session-header-devices');
  session.headerDevIn     = header.querySelector('.hdr-dev-in');
  session.headerDevOut    = header.querySelector('.hdr-dev-out');
  session.headerLockBtn   = header.querySelector('.session-lock');

  session.headerLockBtn.addEventListener('click', () => {
    setFollowLatest(session, !session.followLatest);
  });

  session.headerClearBtn.addEventListener('click', () => clearConversation(session));
  session.headerExportBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleExportMenu(session.headerExportMenu, session.headerExportBtn);
  });
  session.headerExportMenu.addEventListener('click', (ev) => {
    const item = ev.target.closest('.export-item');
    ev.stopPropagation();
    if (!item) return;
    closeExportMenu(session.headerExportMenu, session.headerExportBtn);
    const scope = item.dataset.scope === 'all' ? 'all' : 'session';
    const format = item.dataset.format === 'text' ? 'text' : 'json';
    exportConversation(format, { scope, session });
  });

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
  panel.appendChild(turns);
  session.transcriptEl = turns;

  // Floating "jump to latest" button — only visible when the user has
  // scrolled away from the bottom of this session's transcript. Clicking
  // re-engages the implicit auto-scroll (flushPending re-evaluates the
  // at-bottom threshold on every chunk, so scrolling to bottom is enough).
  const scrollBtn = document.createElement('button');
  scrollBtn.className = 'scroll-bottom-btn';
  scrollBtn.type = 'button';
  scrollBtn.title = 'Scroll to latest';
  scrollBtn.setAttribute('aria-label', 'Scroll to latest');
  scrollBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  scrollBtn.addEventListener('click', () => { turns.scrollTop = turns.scrollHeight; });
  panel.appendChild(scrollBtn);
  session.scrollBottomBtn = scrollBtn;

  // One scroll handler drives three things:
  //   1. Floating "↓" pill visibility (delta >= 64).
  //   2. Auto-unlock the follow-latest lock when the user scrolls away
  //      (delta >= 24). Tolerance is intentionally tighter than the pill
  //      threshold so even small reads-backward pause the autoscroll.
  //   3. Auto-relock when the user returns to the bottom (delta < 8). The
  //      gap between 8 and 24 prevents thrash at the boundary.
  const refreshScrollStuck = () => {
    const delta = turns.scrollHeight - turns.scrollTop - turns.clientHeight;
    panel.dataset.scrollStuck = delta >= 64 ? 'true' : 'false';
    if (session.followLatest && delta >= 24) {
      setFollowLatest(session, false, { skipScroll: true });
    } else if (!session.followLatest && delta < 8) {
      setFollowLatest(session, true, { skipScroll: true });
    }
  };
  turns.addEventListener('scroll', refreshScrollStuck, { passive: true });
  session.refreshScrollStuck = refreshScrollStuck;

  // Paint initial lock visuals (class + title + aria-pressed) without
  // scrolling — the activation path already scrolls to bottom.
  setFollowLatest(session, session.followLatest, { skipScroll: true });

  renderSessionEmptyState(session);
  refreshSessionHeader(session);
}

function updateTabChip(session) {
  if (!session.tabEl) return;
  const cfg = session.config;
  let label, sym;
  if (cfg.engine === 'translate') {
    sym = '»';
    label = `AUTO ${sym} ${shortLangCode(cfg.translateTarget)}`;
  } else {
    sym = cfg.mode === 'transcribe' ? '·' : (cfg.dir === 'oneway' ? '→' : '↔');
    label = `${cfg.source.toUpperCase()} ${sym} ${cfg.target.toUpperCase()}`;
  }
  if (session.tabLabelEl) session.tabLabelEl.textContent = label;
  session.tabEl.dataset.audio = session.isAudio ? 'true' : 'false';
  session.tabEl.title = `${sessionSourceLabel(cfg)} → ${sessionTargetLabel(cfg)}`;
  paintTabChipDevices(session);
  refreshSessionHeader(session);
}

// Pure formatters: turn a session's config into a short label + full title.
// Called from updateTabChip; cheap, so they can run on every refresh trigger.
function describeSessionInput(session) {
  const cfg = session.config || {};
  if (cfg.mode === 'text') {
    return { icon: '⌨', short: 'Text input', full: 'Text-only session (no audio input)' };
  }
  const src = cfg.audioSource || 'mic';
  if (src === 'display') {
    return { icon: '🖥', short: 'Tab audio', full: 'Browser tab / display capture' };
  }
  if (src === 'companion') {
    const exe = cfg.companionApp || '';
    if (!exe) return { icon: '🎧', short: 'All system audio', full: 'Companion: all system audio' };
    const match = state && state.companionApps && state.companionApps.find((a) => a.name === exe);
    const display = match && match.displayName && match.displayName !== exe
      ? `${match.displayName} (${exe})` : exe;
    return { icon: '🎧', short: display, full: 'Companion app: ' + display };
  }
  // 'mic' or 'both'
  const micLabel = micLabelFor(cfg.micDeviceId);
  if (src === 'both') {
    return { icon: '🎤', short: micLabel + ' + tab', full: 'Mic (' + micLabel + ') + browser tab audio' };
  }
  return { icon: '🎤', short: micLabel, full: 'Mic: ' + micLabel };
}

function describeSessionOutput(session) {
  const cfg = session.config || {};
  if (cfg.mode === 'transcribe' || cfg.mode === 'text') {
    return { icon: '📝', short: 'Transcript only', full: 'No translated speech — transcript only' };
  }
  const ids = Array.isArray(cfg.outputDeviceIds) ? cfg.outputDeviceIds : [];
  let primary = 'System default';
  let extras = 0;
  if (ids.length === 0) {
    primary = 'System default';
  } else {
    primary = deviceLabelForId(ids[0], 'output') || 'System default';
    extras = Math.max(0, ids.length - 1);
  }
  const labelShort = extras > 0 ? `${primary} (+${extras})` : primary;
  let labelFull = ids.length === 0
    ? 'System default'
    : ids.map((id) => deviceLabelForId(id, 'output') || 'System default').join(', ');
  const ptIds = Array.isArray(cfg.passthroughDeviceIds) ? cfg.passthroughDeviceIds : [];
  if (ptIds.length > 0) {
    labelFull += '  ·  Passthrough: ' + ptIds.length + ' sink' + (ptIds.length === 1 ? '' : 's');
  }
  return { icon: '🔊', short: labelShort, full: labelFull };
}

// Look up a mic device's human label from the (already-populated) input
// dropdown. Returns "System default" for empty id, "Microphone" when labels
// haven't been granted yet.
function micLabelFor(id) {
  if (!els.audioInput) return id ? 'Microphone' : 'System default';
  const opt = Array.from(els.audioInput.options).find((o) => o.value === (id || ''));
  if (opt && opt.textContent && opt.textContent.trim()) return opt.textContent.trim();
  return id ? 'Microphone' : 'System default';
}

function paintTabChipDevices(session) {
  const cfg = session.config || {};
  const inputInfo = describeSessionInput(session);
  const outputInfo = describeSessionOutput(session);
  const hideOutput = cfg.mode === 'transcribe' || cfg.mode === 'text';
  if (session.tabDevicesEl) {
    session.tabDevicesEl.dataset.mode = cfg.mode || 'audio';
    if (session.tabDevIn) {
      const ico = session.tabDevIn.querySelector('.tab-dev-ico');
      const name = session.tabDevIn.querySelector('.tab-dev-name');
      if (ico) ico.textContent = inputInfo.icon;
      if (name) name.textContent = inputInfo.short;
      session.tabDevIn.title = inputInfo.full;
    }
    if (session.tabDevOut) {
      const ico = session.tabDevOut.querySelector('.tab-dev-ico');
      const name = session.tabDevOut.querySelector('.tab-dev-name');
      if (ico) ico.textContent = outputInfo.icon;
      if (name) name.textContent = outputInfo.short;
      session.tabDevOut.title = outputInfo.full;
      session.tabDevOut.style.display = hideOutput ? 'none' : '';
    }
    const sep = session.tabDevicesEl.querySelector('.tab-dev-sep');
    if (sep) sep.style.display = hideOutput ? 'none' : '';
  }
  // Mobile mirror inside the panel header — CSS controls visibility.
  if (session.headerDevicesEl) {
    session.headerDevicesEl.dataset.mode = cfg.mode || 'audio';
    if (session.headerDevIn) {
      const ico = session.headerDevIn.querySelector('.hdr-dev-ico');
      const name = session.headerDevIn.querySelector('.hdr-dev-name');
      if (ico) ico.textContent = inputInfo.icon;
      if (name) name.textContent = inputInfo.short;
      session.headerDevIn.title = inputInfo.full;
    }
    if (session.headerDevOut) {
      const ico = session.headerDevOut.querySelector('.hdr-dev-ico');
      const name = session.headerDevOut.querySelector('.hdr-dev-name');
      if (ico) ico.textContent = outputInfo.icon;
      if (name) name.textContent = outputInfo.short;
      session.headerDevOut.title = outputInfo.full;
      session.headerDevOut.style.display = hideOutput ? 'none' : '';
    }
    const sep = session.headerDevicesEl.querySelector('.hdr-dev-sep');
    if (sep) sep.style.display = hideOutput ? 'none' : '';
  }
}

// Sync the session header strip (title + turn count). Lives separately from
// the chip so the strip is decoupled from the tablist's responsibilities.
function refreshSessionHeader(session) {
  if (!session.headerEl) return;
  const cfg = session.config || {};
  const sym = cfg.engine === 'translate'
    ? '»'
    : (cfg.mode === 'transcribe' ? '·' : (cfg.dir === 'oneway' ? '→' : '↔'));
  const title = `${sessionSourceLabel(cfg)} ${sym} ${sessionTargetLabel(cfg)}`;
  if (session.headerTitleEl) session.headerTitleEl.textContent = title;
  if (session.headerSubEl) {
    const liveActive = !!(session.liveTurn &&
      ((session.liveTurn.inputText && session.liveTurn.inputText.trim()) ||
       (session.liveTurn.outputText && session.liveTurn.outputText.trim())));
    const n = (session.history ? session.history.length : 0) + (liveActive ? 1 : 0);
    session.headerSubEl.textContent = n === 0 ? 'No turns yet' : `${n} turn${n === 1 ? '' : 's'}`;
  }
}

function refreshAllTabChipDevices() {
  if (!state || !state.sessions) return;
  for (const session of state.sessions.values()) paintTabChipDevices(session);
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
  if (els.pttMode && els.pttMode.el) {
    // Segmented control is only meaningful when there's a binding; lock it
    // when no key is bound (matches the exclusive-checkbox treatment).
    els.pttMode.disabled = !state.pttBinding;
    const mode = (state.pttBinding && state.pttBinding.mode === 'toggle') ? 'toggle' : 'hold';
    els.pttMode.value = mode;
  }
  if (els.pttExclusive) {
    // Checkbox is only meaningful when there's a binding to capture. Reflect
    // the saved flag (default false) and disable when no key is bound.
    els.pttExclusive.disabled = !state.pttBinding;
    els.pttExclusive.checked = !!(state.pttBinding && state.pttBinding.exclusive);
  }
  if (els.pttHint) {
    if (!state.companionAvailable) {
      els.pttHint.textContent = 'Install the companion to bind a system-wide hotkey. The Speak button works without it.';
    } else if (!state.pttBinding) {
      els.pttHint.textContent = 'Click "Not set" and press a key (or combo) to bind a hotkey.';
    } else {
      els.pttHint.textContent = 'Hotkey works system-wide — even when this page isn\'t focused.';
    }
  }
}

// Toggle which sub-section is visible (auto-VAD fields vs PTT fields). PTT
// itself is standalone (driven by the in-page Talk button), so the option is
// always selectable — companion availability only affects the optional global
// hotkey binding shown inside the PTT section.
function updateSpeechModeFields() {
  const companionOk = state.companionAvailable;
  if (els.speechMode) els.speechMode.setOptionDisabled('ptt', false);

  const mode = els.speechMode ? els.speechMode.value : 'auto';
  if (els.vadAutoFields) els.vadAutoFields.style.display = mode === 'ptt' ? 'none' : '';
  if (els.vadPttFields)  els.vadPttFields.style.display  = mode === 'ptt' ? '' : 'none';

  if (els.speechModeHint) {
    els.speechModeHint.textContent = HINTS.speechMode(mode, companionOk);
  }
  updatePttButton();
  refreshPttButtonState();
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
    // Carry the previous exclusive + mode preferences forward across rebinds
    // — they're about behavior, not about the specific key.
    const prev = state.pttBinding || {};
    const exclusive = !!prev.exclusive;
    const mode = prev.mode === 'toggle' ? 'toggle' : 'hold';
    state.pttBinding = Object.assign({}, binding, { exclusive, mode });
    if (state.pttClient) {
      state.pttClient.setBinding(state.pttBinding);
      state.pttClient.setMode(mode);
    }
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
  const prev = state.pttBinding || {};
  const exclusive = !!prev.exclusive;
  const mode = prev.mode === 'toggle' ? 'toggle' : 'hold';
  state.pttBinding = Object.assign({}, binding, { exclusive, mode });
  if (state.pttClient) {
    state.pttClient.setBinding(state.pttBinding);
    state.pttClient.setMode(mode);
  }
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
    if (prev.panelEl) prev.panelEl.classList.remove('is-active');
    if (prev.headerExportMenu) closeExportMenu(prev.headerExportMenu, prev.headerExportBtn);
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
  if (next.panelEl) next.panelEl.classList.add('is-active');
  refreshSessionHeader(next);

  loadSessionConfigIntoUI(next);
  refreshSessionDisplay(next);
  applyControlButtonsForActiveSession();
  paintSessionAge(next);
  // Per-session meters live inside the chip and keep painting themselves on
  // every level callback; no global meter to reset here.

  // PiP follows the last-speaking session, not the active session — so a tab
  // switch by itself doesn't yank the popout off the session that just spoke.
  // Exception: if nothing has spoken yet (no follow target), default to the
  // newly active session so the popout isn't blank.
  if (state.pip && !state.pipFollowingSessionId) {
    state.pipFollowingSessionId = next.id;
    seedPipFromSession(next);
  }

  // Auto-scroll the new tab's transcript to the bottom so the latest turn is
  // in view (transcripts can be scrolled up while the user is reading old ones).
  if (next.transcriptEl) {
    next.transcriptEl.scrollTop = next.transcriptEl.scrollHeight;
  }

  saveSessions();
}

function seedPipFromSession(session) {
  if (!state.pip) return;
  state.pip.setStatus((STATUS_DEF[effectiveStatus(session)] || STATUS_DEF.idle).label(),
    session.status === 'translating' || session.status === 'connected');
  state.pip.setLangs(sessionSourceLabel(session.config), sessionTargetLabel(session.config));
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
  els.engineSelect.value = cfg.engine === 'translate' ? 'translate' : 'live';
  els.langSource.value = cfg.source;
  els.langTarget.value = cfg.target;
  if (els.translateTarget && cfg.translateTarget) {
    els.translateTarget.value = cfg.translateTarget;
    if (!els.translateTarget.value) els.translateTarget.value = DEFAULT_TRANSLATE_TARGET;
  }
  if (els.echoTarget) els.echoTarget.checked = !!cfg.echoTarget;
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
  // Restore the active session's passthrough checkbox selection so the UI
  // reflects this session's config (rather than the previously active
  // session's). Empty array = passthrough disabled.
  const ptIds = Array.isArray(cfg.passthroughDeviceIds) ? cfg.passthroughDeviceIds : [];
  cfg.passthroughDeviceIds = ptIds;
  setPassthroughDeviceIds(ptIds);
  if (els.passthroughOutput) {
    els.passthroughOutput.dataset.preferred = JSON.stringify(ptIds);
  }
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
  // Leaving PTT mode releases any sticky engaged state so a later toggle
  // back to PTT starts from "not engaged" instead of an inherited true.
  if (session.config && session.config.pttMode === 'ptt'
      && nextConfig.pttMode !== 'ptt' && session.pttHeld) {
    session.pttHeld = false;
    if (session.client) { try { session.client.sendActivityEnd(); } catch (_) {} }
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
    // Promote to the lowest non-Basic mode that surfaces the tab strip
    // affordances (close button, "+", multi-chip layout) so the new chip
    // is actually visible. "mid" is enough — no need to jump to "full".
    setUIMode('mid');
    log('info', 'Switched to Full mode so all sessions are visible.');
  }
  refreshAddSessionButton();
  refreshBulkActionButtons();
  saveSessions();
  // The new session has a fresh id, so setActiveSession's early-return won't
  // fire and the previous session's .is-active class is correctly removed.
  if (activate) setActiveSession(session.id);
  // Start the new session's passthrough sinks if its config has any. Fire
  // and forget — failures inside applyPassthrough are logged, not thrown.
  if ((session.config.passthroughDeviceIds || []).length > 0) {
    applyPassthrough(session);
  }
  return session;
}

async function closeSession(session) {
  if (!session) return;
  const running = !!session.running;
  const unsaved = sessionHasUnsavedTranscript(session);
  if (running || unsaved) {
    let title, message, confirmLabel;
    if (running && unsaved) {
      title = 'Stop and close without saving?';
      message = 'This session is running and has translated turns that haven\'t been downloaded. Stop and close anyway?';
      confirmLabel = 'Stop & discard';
    } else if (running) {
      title = 'Stop running session?';
      message = 'This session is running. Stop it and remove?';
      confirmLabel = 'Stop & remove';
    } else {
      title = 'Close without saving?';
      message = 'This session has translated turns that haven\'t been downloaded. Close anyway?';
      confirmLabel = 'Discard & close';
    }
    const ok = await showConfirm({ title, message, confirmLabel, confirmStyle: 'danger' });
    if (!ok) return;
  }
  if (session.running) await stopSession(session);
  if (session.micPassthrough) {
    try { await session.micPassthrough.stop(); } catch (_) {}
    session.micPassthrough = null;
  }
  if (session.tabEl) session.tabEl.remove();
  if (session.panelEl) session.panelEl.remove();
  state.sessions.delete(session.id);
  // Closing a session opens a visible slot — surface the next archived
  // session if there is one. They're FIFO: the first archived entry is the
  // oldest excess from restore time.
  maybePromoteArchivedSession();
  // If PiP was tracking this session, drop the anchor and re-seed from a
  // surviving session so the popout doesn't stay stuck on a removed one.
  // (Re-seed before the setActiveSession path below so it sees a clean
  // state.pipFollowingSessionId and can pick a sensible default.)
  const wasFollowing = state.pipFollowingSessionId === session.id;
  if (state.lastSpeakingSessionId === session.id) state.lastSpeakingSessionId = null;
  if (wasFollowing) {
    state.pipFollowingSessionId = null;
    if (state.pip) {
      // Defer to setActiveSession's "no follow target, seed from active"
      // path when this was the active session too; otherwise pick any
      // remaining session so the popout has live content.
      const fallback = state.sessions.values().next().value;
      if (fallback && state.activeSessionId !== session.id) {
        state.pipFollowingSessionId = fallback.id;
        seedPipFromSession(fallback);
      }
    }
  }
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
      // No sessions left — reset every visible setting to factory defaults so
      // the auto-created replacement isn't carrying over the closed session's
      // configuration.
      resetSettingsToFactoryDefaults();
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

// If there's room and at least one archived session waiting, promote the
// oldest archived entry back into the visible set. Mirrors the restore path
// but for a single entry, fired after closeSession frees a slot.
function maybePromoteArchivedSession() {
  if (!state.archivedSessions || state.archivedSessions.length === 0) return;
  if (state.sessions.size >= MAX_SESSIONS) return;
  const entry = state.archivedSessions.shift();
  const fallback = readConfigFromUI();
  const cfg = Object.assign({}, fallback, entry.config || {});
  cfg.vad = Object.assign({}, fallback.vad, (entry.config && entry.config.vad) || {});
  applySavedEngineDefaults(cfg, entry.config);
  cfg.outputDeviceIds = normalizeOutputDeviceIds(cfg.outputDeviceIds, cfg.outputDeviceId);
  delete cfg.outputDeviceId;
  if (!Array.isArray(cfg.passthroughDeviceIds)) cfg.passthroughDeviceIds = [];
  const session = new Session({ id: entry.id || newSessionId(), config: cfg });
  // Stored resume handles are never restored. Resurfacing an archived session
  // is a user-visible fresh start; only automatic reconnects inside a running
  // GeminiLiveClient may resume.
  session.resumeHandle = null;
  if (Array.isArray(entry.history)) {
    session.history = entry.history
      .filter((h) => h && typeof h === 'object')
      .map((h) => ({
        input: typeof h.input === 'string' ? h.input : '',
        output: typeof h.output === 'string' ? h.output : '',
        finalizedAt: Number.isFinite(h.finalizedAt) ? h.finalizedAt : 0,
      }));
  }
  session.exportedTurnCount = Number.isFinite(entry.exportedTurnCount)
    ? entry.exportedTurnCount
    : session.history.length;
  session.followLatest = typeof entry.followLatest === 'boolean'
    ? entry.followLatest
    : true;
  state.sessions.set(session.id, session);
  createSessionDOM(session);
  renderSessionHistory(session);
  log('info', `Restored an archived session (${state.archivedSessions.length} remaining).`);
}

// Disables the "+" affordance and explains why when we're at the per-window
// session cap. Cheap to call after any sessions-map mutation. Also pushes
// the new count into the PIP so its cycle button can show/hide.
function refreshAddSessionButton() {
  if (!els.btnNewSession) return;
  const atLimit = state.sessions.size >= MAX_SESSIONS;
  els.btnNewSession.disabled = atLimit;
  els.btnNewSession.title = atLimit
    ? `Maximum ${MAX_SESSIONS} sessions — close one to add another`
    : 'New session';
  if (typeof refreshPipSessionCount === 'function') refreshPipSessionCount();
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
// Cap how many history turns we persist per session. This is intentionally
// high enough for long meetings; localStorage still has a finite browser
// quota, so very large transcripts may need IndexedDB later.
const MAX_PERSISTED_HISTORY = 10000;
function saveSessions() {
  // Cancel any pending debounced write — we're writing immediately, so the
  // debounced fire would just clobber this snapshot with a stale one (well,
  // same data; cheaper to just skip).
  if (_pendingSaveSessionsTimer) {
    clearTimeout(_pendingSaveSessionsTimer);
    _pendingSaveSessionsTimer = 0;
  }
  try {
    const visible = [...state.sessions.values()].map((s) => ({
      id: s.id,
      config: s.config,
      resumeHandle: s.resumeHandle || null,
      history: (s.history || []).slice(-MAX_PERSISTED_HISTORY),
      exportedTurnCount: s.exportedTurnCount || 0,
      followLatest: s.followLatest !== false,
    }));
    // Append archivedSessions (extras we hid at restore time) so they're
    // preserved across writes. They never become active sessions in this
    // process — they just round-trip through storage.
    const arr = visible.concat(state.archivedSessions || []);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify({
      sessions: arr,
      activeId: state.activeSessionId,
    }));
  } catch (_) {}
}

// Trailing-edge debounce for the per-turn save path. During active translation
// `finalizeTurn` fires saveSessions ~once/sec/session; with 3 sessions that's
// up to 3 multi-KB JSON.stringify + localStorage writes per second. Coalesce
// to one write every 1.5s. Lifecycle saves (create/close/resume/stop) still
// call saveSessions() directly so the write hits disk before navigation.
let _pendingSaveSessionsTimer = 0;
function scheduleSaveSessions() {
  if (_pendingSaveSessionsTimer) return;
  _pendingSaveSessionsTimer = setTimeout(() => {
    _pendingSaveSessionsTimer = 0;
    saveSessions();
  }, 1500);
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
  // Seed for sessions saved before passthroughDeviceIds moved into per-session
  // config — they took the value from global prefs. The new section's
  // dataset.preferred was populated by loadPrefs already; read it here so
  // entries that lacked the field inherit the user's last choice. Stored
  // values are now WASAPI endpoint ids (from the companion); any legacy
  // browser deviceIds get dropped silently the first time
  // refreshPassthroughOutputDevices rebuilds the list.
  let legacyPassthrough = [];
  try {
    const seed = els.passthroughOutput && els.passthroughOutput.dataset.preferred;
    legacyPassthrough = JSON.parse(seed || '[]');
    if (!Array.isArray(legacyPassthrough)) legacyPassthrough = [];
  } catch (_) { legacyPassthrough = []; }
  // If an older build saved more than MAX_SESSIONS, keep only the first N
  // visible. The rest are stashed in state.archivedSessions so saveSessions()
  // can write them back verbatim — they're not destroyed, just hidden until
  // MAX_SESSIONS goes up or a visible slot frees up.
  const entries = data.sessions.slice(0, MAX_SESSIONS);
  state.archivedSessions = data.sessions.slice(MAX_SESSIONS);
  if (state.archivedSessions.length > 0) {
    log('warn',
      `Found ${data.sessions.length} saved sessions; showing the first ${MAX_SESSIONS}. ` +
      `${state.archivedSessions.length} kept in storage and will resurface if a slot frees up.`);
  }
  for (const entry of entries) {
    const cfg = Object.assign({}, fallback, entry.config || {});
    cfg.vad = Object.assign({}, fallback.vad, (entry.config && entry.config.vad) || {});
    applySavedEngineDefaults(cfg, entry.config);
    cfg.outputDeviceIds = normalizeOutputDeviceIds(cfg.outputDeviceIds, cfg.outputDeviceId);
    delete cfg.outputDeviceId;
    // Migration: older saves don't carry passthroughDeviceIds (it lived in
    // global prefs). If the saved entry omits the field, adopt the legacy
    // prefs.passthroughDeviceIds (already staged into the audioOutput
    // dataset by loadPrefs). Sessions saved by this build will have the
    // field present and skip this fallback.
    const savedHadPt = entry.config && Array.isArray(entry.config.passthroughDeviceIds);
    if (!savedHadPt) cfg.passthroughDeviceIds = legacyPassthrough.slice();
    else if (!Array.isArray(cfg.passthroughDeviceIds)) cfg.passthroughDeviceIds = [];
    const session = new Session({
      id: entry.id || newSessionId(),
      config: cfg,
    });
    // Do not restore saved resume handles after a page reload. User-initiated
    // starts should open a fresh Gemini Live session; only automatic reconnects
    // within the same running client preserve resumption.
    session.resumeHandle = null;
    if (Array.isArray(entry.history)) {
      // Defensive: only accept well-formed entries so a corrupted store can't
      // crash the renderer or the export downstream.
      session.history = entry.history
        .filter((h) => h && typeof h === 'object')
        .map((h) => ({
          input: typeof h.input === 'string' ? h.input : '',
          output: typeof h.output === 'string' ? h.output : '',
          finalizedAt: Number.isFinite(h.finalizedAt) ? h.finalizedAt : 0,
        }));
    }
    // Legacy saves don't carry exportedTurnCount — grandfather them as
    // "already accounted for" so the close-warning only fires for new turns
    // recorded after the upgrade.
    session.exportedTurnCount = Number.isFinite(entry.exportedTurnCount)
      ? entry.exportedTurnCount
      : session.history.length;
    // Follow-latest defaults to true (matches new-session default + previous
    // implicit "always at bottom on restore" behavior).
    session.followLatest = typeof entry.followLatest === 'boolean'
      ? entry.followLatest
      : true;
    state.sessions.set(session.id, session);
    createSessionDOM(session);
    renderSessionHistory(session);
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
      engine: els.engineSelect.value || 'live',
      source: els.langSource.value,
      target: els.langTarget.value,
      translateTarget: els.translateTarget ? els.translateTarget.value : DEFAULT_TRANSLATE_TARGET,
      echoTarget: !!(els.echoTarget && els.echoTarget.checked),
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
      pipPrefs:    state.pipPrefs || null,
    }));
  } catch (_) {}
}

function langName(code) {
  for (const [c, n] of LANGUAGES) if (c === code) return n;
  return code;
}

function translateLangName(code) {
  for (const [c, n] of TRANSLATE_LANGUAGES) if (c === code) return n;
  return code;
}

// Short uppercase tag for a chip label, e.g. 'zh-Hans' → 'ZH', 'en' → 'EN'.
function shortLangCode(code) {
  return String(code || '').split('-')[0].toUpperCase();
}

// Source / target display labels for a session, accounting for the engine.
// The translate engine auto-detects the source and targets a BCP-47 code.
function sessionSourceLabel(cfg) {
  return cfg.engine === 'translate' ? 'Auto' : langName(cfg.source);
}
function sessionTargetLabel(cfg) {
  return cfg.engine === 'translate' ? translateLangName(cfg.translateTarget) : langName(cfg.target);
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
  const engine = els.engineSelect.value || 'live';
  const isTranslate = engine === 'translate';
  document.body.dataset.engine = engine;

  // Languages section: the translate engine auto-detects the source and uses a
  // BCP-47 target, so swap the live engine's source⇄target pair for a single
  // target picker plus the echo toggle.
  if (els.langPairField)       els.langPairField.style.display       = isTranslate ? 'none' : '';
  if (els.langPairHint)        els.langPairHint.style.display        = isTranslate ? 'none' : '';
  if (els.translateTargetField) els.translateTargetField.style.display = isTranslate ? '' : 'none';
  if (els.echoTargetField)     els.echoTargetField.style.display     = isTranslate ? '' : 'none';

  // The translate model is config-driven: no prompt, no turn/VAD controls, no
  // mode/direction. Hide those whole sections so they can't feed stale config
  // into a translate session. (They're full-only via CSS too, but engine can be
  // 'translate' in any UI mode, so gate them here as well.)
  if (els.translationSection) els.translationSection.style.display = isTranslate ? 'none' : '';
  if (els.speechSection)      els.speechSection.style.display      = isTranslate ? 'none' : '';
  if (els.promptSection)      els.promptSection.style.display      = isTranslate ? 'none' : '';

  if (els.engineHint) {
    els.engineHint.textContent = isTranslate
      ? 'Dedicated low-latency model. Auto-detects what you say and speaks the target language. One-way; no prompt or push-to-talk.'
      : 'Prompt-based engine. Bidirectional, with text-only and transcribe modes.';
  }

  // Direction: only for translation modes (live engine)
  els.dirField.style.display = (mode === 'transcribe') ? 'none' : '';

  // Voice & Audio Output: for Translate (Voice) mode, or any translate session
  // (which always speaks the translation).
  const showAudio = isTranslate || (mode === 'audio');
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

  // VAD detail fields (start/end sensitivity, prefix padding, silence ms)
  // only matter when the user picks "Custom" — the named presets are
  // self-explanatory and the numeric knobs just add visual clutter the rest
  // of the time. Hidden fields still hold their values, so changing presets
  // back and forth doesn't lose state.
  if (els.vadCustomFields) {
    els.vadCustomFields.style.display = (els.vadPreset && els.vadPreset.value === 'custom') ? '' : 'none';
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
  const wasAvailable = state.companionAvailable;
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
  // Companion dropped while we were depending on it. PTT sessions used to be
  // killed here (the global hotkey was the only input), but with the Talk
  // button driving session.pttHeld directly we just lose the optional
  // hotkey — the session keeps working. Companion-audio capture has no
  // standalone fallback though, so those sessions still need to stop.
  if (wasAvailable && !state.companionAvailable) {
    const stuckCompanionAudio = [...state.sessions.values()].filter(
      (s) => s.running && (s.currentAudioMode === 'companion'));
    if (stuckCompanionAudio.length > 0) {
      log('error',
        `Companion service disconnected — stopping ${stuckCompanionAudio.length} ` +
        `companion-audio session${stuckCompanionAudio.length === 1 ? '' : 's'}.`);
      Promise.all(stuckCompanionAudio.map((s) => stopSession(s).catch(() => {})));
    }
  }
  document.body.classList.toggle('no-companion', !state.companionAvailable);
  updateAudioSourceAvailability();
  updateSpeechModeFields();
  updateCompanionLaunchButton();
  if (state.companionAvailable && els.companionApp) {
    refreshCompanionApps({ silent: true });
  }
  // Passthrough sinks live entirely on the companion now — refresh the
  // device list (or hide the section if companion just dropped).
  if (els.passthroughOutput) {
    refreshPassthroughOutputDevices().catch(() => {});
  }
  // Tear down passthrough WS on sessions when companion disappears so
  // the per-session client doesn't keep retrying a dead endpoint.
  if (wasAvailable && !state.companionAvailable) {
    for (const s of state.sessions.values()) {
      if (s.micPassthrough) {
        try { s.micPassthrough.stop(); } catch (_) {}
      }
    }
  }
  return state.companionAvailable;
}

// ─── Companion launch button ──────────────────────────────────────────────────

// Update the "Open Companion App" button label and style based on whether the
// companion HTTP service is currently reachable (state.companionAvailable).
function updateCompanionLaunchButton() {
  const btn = els.btnOpenCompanion;
  const lbl = els.btnOpenCompanionLabel;
  if (!btn || !lbl) return;
  if (state.companionAvailable) {
    lbl.textContent = 'Companion is already running';
    btn.classList.add('is-companion-connected');
    btn.disabled = true;
  } else {
    lbl.textContent = 'Open Companion App';
    btn.classList.remove('is-companion-connected');
    btn.disabled = false;
  }
}

// Attempt to launch the companion via the translatorcompanion:// URL protocol.
// If the protocol is not registered Chrome will silently do nothing, so we
// use a short timer: if the page is still in focus after ~2 s we assume the
// protocol fired no OS handler and show the install notice instead.
function launchCompanion() {
  if (state.companionAvailable) return; // guard: button should already be disabled

  const notice = els.companionLaunchNotice;
  if (notice) notice.hidden = true; // hide any previous notice

  // Fire the custom protocol URL.
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  document.body.appendChild(iframe);
  iframe.src = 'translatorcompanion://launch';

  // Fallback: if the page is still focused after the OS had time to hand off
  // the protocol to a registered handler, assume the protocol is unregistered.
  const TIMEOUT_MS = 2500;
  let launched = false;
  const onBlur = () => { launched = true; };
  window.addEventListener('blur', onBlur, { once: true });
  setTimeout(() => {
    window.removeEventListener('blur', onBlur);
    // Remove the helper iframe regardless.
    try { document.body.removeChild(iframe); } catch (_) {}
    if (!launched && notice) {
      notice.hidden = false;
    }
  }, TIMEOUT_MS);
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
        ? 'Pick an app. Refresh ↻ after starting playback in a new one.'
        : 'No app is playing sound. Start playback, then refresh ↻.';
    }
    if (!silent) log('info', `Companion: found ${apps.length} app${apps.length === 1 ? '' : 's'} with active audio.`);
    refreshAllTabChipDevices();
  } catch (e) {
    if (!silent) log('warn', 'Could not list companion apps: ' + (e && e.message ? e.message : e));
    if (els.companionAppHint) {
      els.companionAppHint.textContent = 'Couldn\'t reach the companion service.';
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

  // Translate-engine target list (BCP-47 codes; source is auto-detected).
  if (els.translateTarget) {
    const fragT = document.createDocumentFragment();
    for (const [code, name] of TRANSLATE_LANGUAGES) {
      const o = document.createElement('option');
      o.value = code; o.textContent = name; fragT.appendChild(o);
    }
    els.translateTarget.appendChild(fragT);
  }

  const prefs = loadPrefs();
  els.apiKey.value      = prefs.apiKey || '';
  els.engineSelect.value = prefs.engine === 'translate' ? 'translate' : 'live';
  els.langSource.value  = prefs.source || 'en';
  els.langTarget.value  = prefs.target || 'zh';
  if (els.translateTarget) {
    els.translateTarget.value = prefs.translateTarget || DEFAULT_TRANSLATE_TARGET;
    // A select snaps to '' when the saved code isn't an option (e.g. a list
    // change between builds) — fall back to the default so it's never blank.
    if (!els.translateTarget.value) els.translateTarget.value = DEFAULT_TRANSLATE_TARGET;
  }
  if (els.echoTarget)      els.echoTarget.checked = !!prefs.echoTarget;
  els.voice.value       = prefs.voice  || 'Zephyr';
  els.audioInput.dataset.preferred = prefs.input || '';
  els.audioInput.value  = prefs.input  || '';
  els.audioSource.value = prefs.audio  || 'mic';
  const prefOutIds = normalizeOutputDeviceIds(prefs.outputs, prefs.output);
  els.audioOutput.dataset.preferred = JSON.stringify(prefOutIds);
  if (els.passthroughOutput) {
    els.passthroughOutput.dataset.preferred = JSON.stringify(prefs.passthroughDeviceIds || []);
  }
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
  // Restore PIP-pane prefs (display mode + font size). Validate so a hand-
  // edited localStorage entry can't crash the PIP at open time.
  if (prefs.pipPrefs && typeof prefs.pipPrefs === 'object') {
    const dm = prefs.pipPrefs.displayMode;
    const fs = prefs.pipPrefs.fontStep;
    if (dm === 'both' || dm === 'input' || dm === 'output') {
      state.pipPrefs.displayMode = dm;
    }
    if (Number.isInteger(fs) && fs >= 0 && fs <= 3) {
      state.pipPrefs.fontStep = fs;
    }
  }
  // Pref migration: pre-three-mode builds saved 'advanced' to mean "Full"
  // (the only non-Basic mode at the time). After the Basic/Advanced/Full
  // split, treat that legacy value as 'full'. New 'mid' value is only ever
  // written by post-migration builds, so it's safe to pass through.
  let savedMode = prefs.uiMode;
  if (savedMode === 'advanced') savedMode = 'full';
  if (!UI_MODES.includes(savedMode)) savedMode = 'simple';
  setUIMode(savedMode);

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
    els.audioInputHint.textContent = 'Browser doesn\'t support picking a microphone.';
  }
}

function updateAudioOutputSupport() {
  if (!els.audioOutput) return;
  const canSelect = LiveAudio.canSelectOutputDevice && LiveAudio.canSelectOutputDevice();
  const canList = !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices);
  const supported = canSelect && canList;
  setOutputDeviceListDisabled(!supported);
  if (!supported) {
    els.audioOutputHint.textContent = 'Browser doesn\'t support picking a speaker.';
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

// Guarantees at least one TTS sink is ticked so the UI never shows "nothing
// selected" while audio still plays via the System-default fallback. Returns
// true if the System-default checkbox was force-re-checked, false otherwise.
function ensureAtLeastOneOutputTicked() {
  if (!els.audioOutput) return false;
  const ticked = els.audioOutput.querySelectorAll('input.dev-tts:checked');
  if (ticked.length > 0) return false;
  const defaultCb = els.audioOutput.querySelector('input.dev-tts[value=""]');
  if (defaultCb) defaultCb.checked = true;
  return true;
}

// Reads passthrough checkboxes from the dedicated companion-output section.
// The values stored here are WASAPI render endpoint ids (returned by the
// companion's /outputs enumeration) — distinct ID space from the browser's
// MediaDeviceInfo.deviceId values that live in the TTS section above.
function getPassthroughDeviceIds() {
  if (!els.passthroughOutput) return [];
  return Array.from(els.passthroughOutput.querySelectorAll('input.dev-passthrough:checked'))
    .map((cb) => cb.value);
}

function setPassthroughDeviceIds(ids) {
  if (!els.passthroughOutput) return;
  const want = new Set((ids || []).map((id) => id || ''));
  els.passthroughOutput.querySelectorAll('input.dev-passthrough').forEach((cb) => {
    cb.checked = want.has(cb.value);
  });
}

async function refreshPassthroughOutputDevices() {
  if (!els.passthroughOutput) return;
  if (!state.companionAvailable) {
    setPassthroughSectionVisible(false);
    return;
  }
  let endpoints = [];
  try {
    const res = await fetchWithTimeout(`${COMPANION_HTTP_URL}/outputs`, {
      mode: 'cors',
      cache: 'no-store',
      headers: { 'X-Live-Translator': 'outputs' },
    }, 1500);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    endpoints = Array.isArray(data && data.outputs) ? data.outputs : [];
  } catch (e) {
    log('warn', 'Could not list passthrough outputs: ' + (e && e.message ? e.message : e));
    setPassthroughSectionVisible(false);
    return;
  }
  state.passthroughOutputs = endpoints;

  // Same "honour live selection over snapshot" pattern the TTS list uses —
  // any in-flight checkbox click survives the rebuild.
  let preferred = [];
  try { preferred = JSON.parse(els.passthroughOutput.dataset.preferred || '[]'); }
  catch (_) {}
  if (!Array.isArray(preferred)) preferred = [];
  const currently = new Set(getPassthroughDeviceIds());
  const wanted = new Set([...currently, ...preferred.map((v) => v || '')]);

  const frag = document.createDocumentFragment();
  for (const ep of endpoints) {
    const id = ep.id || '';
    const label = ep.isDefault && ep.name ? `${ep.name} (default)` : (ep.name || id);
    frag.appendChild(buildPassthroughDeviceOption(id, label, wanted.has(id)));
  }
  els.passthroughOutput.innerHTML = '';
  els.passthroughOutput.appendChild(frag);
  els.passthroughOutput.dataset.preferred = JSON.stringify(getPassthroughDeviceIds());

  if (els.passthroughOutputHint) {
    els.passthroughOutputHint.textContent = endpoints.length
      ? 'Tick any device to route this session\'s source audio there.'
      : 'Companion reported no render endpoints.';
  }
  setPassthroughSectionVisible(true);
  refreshActiveDeviceIndicators();

  // Re-apply every running session's passthrough so a refresh that surfaces
  // a newly-added endpoint immediately starts routing if it was already in
  // the saved selection.
  for (const session of state.sessions.values()) {
    await applyPassthrough(session);
  }
}

function setPassthroughSectionVisible(show) {
  if (!els.passthroughOutputSection) return;
  els.passthroughOutputSection.style.display = show ? '' : 'none';
}

// Drive a single session's passthrough configuration on the companion. The
// sink list comes from config.passthroughDeviceIds (WASAPI render endpoint
// ids, populated by the Passthrough output section in the UI). The source
// descriptor mirrors what the session is feeding Gemini — mic label and/or
// loopback pid — so the companion captures the same audio that's being
// translated and fans it out to the user's chosen virtual cables. Display/
// tab passthrough is unavailable on the companion side (only the browser
// can do getDisplayMedia) and is silently dropped from the source set; the
// "both" audioSource still routes its mic half.
async function applyPassthrough(session) {
  if (!session || !session.micPassthrough) return;
  const ids = (session.config.passthroughDeviceIds || []).slice();
  const sources = buildPassthroughSources(session);
  try {
    await session.micPassthrough.configure(ids, sources);
    const warnings = session.micPassthrough.warnings || [];
    for (const w of warnings) {
      const label = w.deviceId
          ? describePassthroughOutput(w.deviceId)
          : 'passthrough';
      log('warn', `Audio passthrough ${label}: ${w.reason}.`);
    }
  } catch (e) {
    log('warn', 'Audio passthrough error: ' + (e && e.message ? e.message : e));
  }
  refreshActiveDeviceIndicators();
}

// Source descriptor for the companion's per-session passthrough engine.
// Mirrors the session's current audioSource so the virtual cable hears the
// same thing being translated. Returns an empty descriptor when the session
// isn't running — the WS still has its sinks remembered in passthroughDeviceIds,
// but the companion has nothing to capture until startSession brings sources
// online again.
function buildPassthroughSources(session) {
  const empty = { micId: '', micLabel: '', pid: 0, loopback: false };
  if (!session || !session.running) return empty;
  const mode = session.currentAudioMode || session.config.audioSource || 'mic';
  const out = { ...empty };
  if (mode === 'mic' || mode === 'both') {
    // Browser device ids are origin-hashed and can't be used outside this
    // page — the companion matches by friendly name instead. The mic dropdown
    // option text is sourced from MediaDeviceInfo.label, which is what the
    // companion's WASAPI capture endpoints report as their friendly name.
    out.micLabel = lookupMicLabel(session.config.micDeviceId);
  }
  if (mode === 'companion') {
    out.loopback = true;
    const exe = session.config.companionApp;
    if (exe) {
      const match = state.companionApps && state.companionApps.find((a) => a.name === exe);
      if (match) out.pid = match.pid;
    }
  }
  // 'display' alone has no companion-capturable source; the passthrough goes
  // silent for that mode (cable plays silence). Documented limitation.
  return out;
}

function hasAnyPassthroughSource(s) {
  return !!s && (s.micId || s.micLabel || s.pid || s.loopback);
}

function lookupMicLabel(deviceId) {
  if (!els.audioInput) return '';
  const value = deviceId || '';
  const opts = els.audioInput.querySelectorAll('option');
  for (const o of opts) {
    if (o.value === value) return o.textContent || '';
  }
  return '';
}

function describePassthroughOutput(id) {
  if (!els.passthroughOutput) return id || 'output';
  const cb = els.passthroughOutput.querySelector(`input.dev-passthrough[value="${cssEscape(id)}"]`);
  if (!cb) return id || 'output';
  const row = cb.closest('.device-option');
  const span = row && row.querySelector('.device-name');
  return span ? span.textContent : (id || 'output');
}

// ─── Input device preview ────────────────────────────────────────────────────
// Opens a short-lived mic stream just for the visualizer in the settings
// panel. Auto-closes after ~10 s so we don't keep the OS mic indicator on
// indefinitely when the user forgets to stop it.
const MIC_PREVIEW_MS = 10000;

function paintMicPreviewLevel(level) {
  if (!els.micPreviewFill) return;
  // Same quantize/skip pattern as paintMeterFill — saves wasted DOM writes
  // when the level hasn't moved a whole percent.
  if (document.hidden) return;
  const pct = levelToPct(level) | 0;
  if (els.micPreviewFill._lastPct === pct) return;
  els.micPreviewFill._lastPct = pct;
  els.micPreviewFill.style.width = pct + '%';
}

function setMicPreviewActive(active) {
  if (els.btnMicPreview) {
    els.btnMicPreview.classList.toggle('is-active', !!active);
    els.btnMicPreview.setAttribute('aria-pressed', active ? 'true' : 'false');
    els.btnMicPreview.title = active
      ? 'Stop microphone preview'
      : 'Preview microphone level (10s)';
    els.btnMicPreview.setAttribute('aria-label',
      active ? 'Stop microphone preview' : 'Preview microphone level');
  }
  if (els.micPreviewMeter) {
    els.micPreviewMeter.classList.toggle('is-active', !!active);
  }
  if (!active) paintMicPreviewLevel(0);
}

async function stopMicPreview() {
  if (state.inputPreview && state.inputPreview.running) {
    try { await state.inputPreview.stop(); } catch (_) {}
  }
  setMicPreviewActive(false);
}

async function startMicPreview() {
  if (!state.inputPreview) {
    state.inputPreview = new LiveAudio.InputPreview({
      onLevel: (l) => paintMicPreviewLevel(l),
      onAutoStop: () => setMicPreviewActive(false),
      autoStopMs: MIC_PREVIEW_MS,
    });
  }
  const micId = els.audioInput ? els.audioInput.value || '' : '';
  try {
    await state.inputPreview.start(micId);
    setMicPreviewActive(true);
  } catch (e) {
    setMicPreviewActive(false);
    log('warn', 'Mic preview failed: ' + (e && e.message ? e.message : e));
  }
}

async function toggleMicPreview() {
  if (state.inputPreview && state.inputPreview.running) {
    await stopMicPreview();
  } else {
    await startMicPreview();
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
  // We never render 'default'/'communications' rows (they're filtered out
  // before this is called) so we only need a fallback for unlabelled real
  // devices — typically "no permission yet, so labels are empty".
  return `Microphone ${index + 1}`;
}

function outputDeviceLabel(device, index) {
  if (device.label) return device.label;
  return `Speaker ${index + 1}`;
}

// `select.value = X` silently falls back to the first option when X has no
// matching <option>. That's the cause of "non-default device gets selected"
// when a stored deviceId disappears. This helper finds the option explicitly
// and falls back to '' (System default) when missing.
function selectOptionByValue(selectEl, value) {
  if (!selectEl) return;
  const wanted = value == null ? '' : String(value);
  let match = null;
  for (const opt of selectEl.options) {
    if (opt.value === wanted) { match = opt; break; }
  }
  if (!match) {
    for (const opt of selectEl.options) {
      if (opt.value === '') { match = opt; break; }
    }
  }
  if (match) {
    selectEl.selectedIndex = match.index;
  }
}

// One-shot: ask for mic permission, immediately release the stream, then
// re-render the device lists. This is the recommended way to surface device
// names without committing the browser to a long-lived recording — useful at
// startup when no session is running yet.
async function detectAudioDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    log('warn', 'This browser does not support detecting devices.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Stop immediately — we only needed the permission grant.
    stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    await refreshAudioInputDevices();
    await refreshAudioOutputDevices();
    log('info', 'Audio devices detected.');
  } catch (e) {
    log('warn', 'Could not detect devices: ' + (e && e.message ? e.message : e));
  }
}

// Re-runs enumerate-and-render when the data is likely stale (input dropdown
// only has the placeholder, or no device labels yet). Cheap; harmless when
// nothing has changed.
async function refreshDeviceListsIfStale() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const inputs = devs.filter((d) => d.kind === 'audioinput');
    const outputs = devs.filter((d) => d.kind === 'audiooutput');
    const inputsLackLabels = inputs.length > 0 && inputs.every((d) => !d.label);
    const outputsLackLabels = outputs.length > 0 && outputs.every((d) => !d.label);
    // Always refresh if dropdowns are still empty (just placeholder), or if
    // labels are still hidden (permission may have been granted since).
    const inputEmpty = els.audioInput && els.audioInput.options.length <= 1;
    const outputEmpty = els.audioOutput && els.audioOutput.querySelectorAll('.device-option').length <= 1;
    if (inputEmpty || inputsLackLabels) refreshAudioInputDevices();
    if (outputEmpty || outputsLackLabels) refreshAudioOutputDevices();
  } catch (_) { /* device enumeration failures are non-fatal here */ }
}

async function refreshAudioInputDevices() {
  if (!els.audioInput || els.audioInput.disabled) return;
  try {
    const selected = els.audioInput.value || els.audioInput.dataset.preferred || '';
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const seen = new Set();
    const frag = document.createDocumentFragment();

    // "System default" gets a richer label when we know which physical device
    // the OS resolved it to. Two sources, in priority order:
    //   1. state.resolvedMicDeviceId — captured by AudioCapture post-start
    //      from track.getSettings().deviceId (most authoritative; this is the
    //      device actually being recorded).
    //   2. The 'default' entry from enumerateDevices (browsers expose this
    //      pre-session, label like "Default - Realtek Microphone").
    const resolved = state.resolvedMicDeviceId
      ? inputs.find((d) => d.deviceId === state.resolvedMicDeviceId)
      : null;
    const defaultEntry = inputs.find((d) => d.deviceId === 'default');
    let defaultLabel = 'System default';
    if (resolved && resolved.label) defaultLabel = `System default (${resolved.label})`;
    else if (defaultEntry && defaultEntry.label) defaultLabel = defaultEntry.label;
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = defaultLabel;
    frag.appendChild(defaultOpt);
    seen.add('');

    inputs.forEach((device, index) => {
      const id = device.deviceId || '';
      // Windows browsers report two pseudo-devices ('default' and
      // 'communications') alongside the real ones. We already render
      // "System default" with value '', so listing both confuses users —
      // skip them and only show concrete devices.
      if (id === 'default' || id === 'communications') return;
      if (seen.has(id)) return;
      seen.add(id);
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = inputDeviceLabel(device, index);
      frag.appendChild(opt);
    });

    els.audioInput.innerHTML = '';
    els.audioInput.appendChild(frag);
    // Explicitly find and select the option rather than relying on
    // `select.value = X`, which silently falls back to the first option when
    // X isn't present — that's the root of the "selects a non-default device"
    // report when a stored deviceId vanishes between sessions.
    const target = seen.has(selected) ? selected : '';
    selectOptionByValue(els.audioInput, target);
    els.audioInput.dataset.preferred = target;

    if (inputs.length) {
      const hasLabels = inputs.some((d) => d.label);
      els.audioInputHint.textContent = hasLabels
        ? 'Switching applies immediately. Mic + Tab asks you to repick the tab.'
        : 'Tap Start once to grant mic access — names appear after.';
    } else {
      els.audioInputHint.textContent = 'No microphones found.';
    }
    savePrefs();
    refreshAllTabChipDevices();
  } catch (e) {
    els.audioInput.disabled = true;
    els.audioInputHint.textContent = 'Couldn\'t read your microphones.';
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

    const devices = await navigator.mediaDevices.enumerateDevices();

    // Re-read selection AFTER the enumerate await — a user click that landed
    // during the async gap must not be clobbered by a snapshot we took before
    // the await. (Race fix: previously we snapshotted before the await and
    // any toggle made during enumeration was reverted by the rebuild.)
    const currently = new Set(getSelectedOutputDeviceIds());
    const wantedTts = new Set([...currently, ...preferred.map((v) => v || '')]);
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    const seen = new Set();
    const frag = document.createDocumentFragment();
    // Same idea as the input dropdown: surface which physical device the OS
    // actually resolved "System default" to. Web Audio doesn't tell us the
    // actual physical sink for ctx.destination, so the 'default' device entry
    // from enumerateDevices is our best signal.
    const defaultOutEntry = outputs.find((d) => d.deviceId === 'default');
    const sysDefaultLabel = (defaultOutEntry && defaultOutEntry.label)
      ? defaultOutEntry.label
      : 'System default';
    frag.appendChild(buildDeviceOption('', sysDefaultLabel, wantedTts.has('')));
    seen.add('');

    outputs.forEach((device, index) => {
      const id = device.deviceId || '';
      // Same reasoning as the input list: skip the pseudo-device aliases the
      // browser exposes alongside the real ones. The single "System default"
      // row at value '' is the only default we surface.
      if (id === 'default' || id === 'communications') return;
      if (seen.has(id)) return;
      seen.add(id);
      frag.appendChild(buildDeviceOption(id, outputDeviceLabel(device, index), wantedTts.has(id)));
    });

    els.audioOutput.innerHTML = '';
    els.audioOutput.appendChild(frag);
    // Drop ids that no longer map to a present device. Enforce the invariant
    // that at least one TTS sink is always ticked — if everything got pruned,
    // or the user previously saved an empty selection, System default wins.
    ensureAtLeastOneOutputTicked();
    els.audioOutput.dataset.preferred = JSON.stringify(getSelectedOutputDeviceIds());

    if (outputs.length) {
      const hasLabels = outputs.some((d) => d.label);
      els.audioOutputHint.textContent = hasLabels
        ? 'Translated speech plays on every ticked device.'
        : 'Names appear after granting mic access.';
    } else {
      els.audioOutputHint.textContent = 'No speakers found.';
    }
    savePrefs();
    refreshActiveDeviceIndicators();
    refreshAllTabChipDevices();
  } catch (e) {
    setOutputDeviceListDisabled(true);
    els.audioOutputHint.textContent = 'Couldn\'t read your speakers.';
    log('warn', 'Audio output devices unavailable: ' + (e && e.message ? e.message : e));
  }
}

function buildDeviceOption(value, label, ttsChecked) {
  const row = document.createElement('div');
  row.className = 'device-option';
  row.dataset.deviceId = value;

  // Left side: TTS checkbox + device name + live indicator
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
  const liveBadge = document.createElement('span');
  liveBadge.className = 'live-badge';
  liveBadge.setAttribute('aria-hidden', 'true');
  liveBadge.innerHTML = '<span class="live-dot"></span><span class="live-text">live</span>';
  ttsLabel.appendChild(ttsCb);
  ttsLabel.appendChild(nameSpan);
  ttsLabel.appendChild(liveBadge);

  const testBtn = document.createElement('button');
  testBtn.className = 'device-test';
  testBtn.type = 'button';
  testBtn.dataset.deviceId = value;
  testBtn.title = 'Test speaker';
  testBtn.setAttribute('aria-label', `Test ${label}`);
  testBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor"/><path d="M16 9.5a4 4 0 0 1 0 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M19 7a8 8 0 0 1 0 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  row.appendChild(ttsLabel);
  row.appendChild(testBtn);
  return row;
}

// Row for the companion-enumerated passthrough output section. Distinct from
// buildDeviceOption() because:
//   - the device id here is a WASAPI endpoint id (companion-owned, stable per
//     OS) rather than the browser's per-origin opaque MediaDeviceInfo.deviceId;
//   - there is no "test speaker" affordance — the companion owns playback and
//     we don't have a quick way to trigger a test tone through it;
//   - the live indicator surfaces companion-reported sink activity instead of
//     browser-side `<audio>` element state.
function buildPassthroughDeviceOption(value, label, checked) {
  const row = document.createElement('div');
  row.className = 'device-option passthrough-row';
  row.dataset.deviceId = value;
  const wrap = document.createElement('label');
  wrap.className = 'device-tts-label';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'dev-passthrough';
  cb.value = value;
  cb.checked = !!checked;
  const nameSpan = document.createElement('span');
  nameSpan.className = 'device-name';
  nameSpan.textContent = label;
  const liveBadge = document.createElement('span');
  liveBadge.className = 'live-badge';
  liveBadge.setAttribute('aria-hidden', 'true');
  liveBadge.innerHTML = '<span class="live-dot"></span><span class="live-text">routing</span>';
  wrap.appendChild(cb);
  wrap.appendChild(nameSpan);
  wrap.appendChild(liveBadge);
  row.appendChild(wrap);
  return row;
}

async function testOutputDevice(deviceId) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('AudioContext unavailable.');
  const ctx = new Ctx();
  let el = null;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    // Three-note arpeggio (C5–E5–G5) over ~1.6 s. Easier to identify which
    // speaker is playing than the previous quarter-second blip, especially on
    // small Bluetooth devices where the first 200 ms can be lost to wake-up.
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    const notes = [523.25, 659.25, 783.99];
    const noteDur = 0.45;
    const totalDur = noteDur * notes.length + 0.1;
    const oscillators = notes.map((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + i * noteDur;
      osc.connect(gain);
      osc.start(t0);
      osc.stop(t0 + noteDur);
      return osc;
    });
    // One envelope per note: 20 ms attack, 380 ms decay, 50 ms gap.
    notes.forEach((_, i) => {
      const t0 = ctx.currentTime + i * noteDur;
      gain.gain.exponentialRampToValueAtTime(0.6, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + noteDur - 0.05);
    });

    if (typeof HTMLMediaElement !== 'undefined' &&
        HTMLMediaElement.prototype &&
        typeof HTMLMediaElement.prototype.setSinkId === 'function') {
      const dest = ctx.createMediaStreamDestination();
      gain.connect(dest);
      el = new Audio();
      el.autoplay = true;
      el.playsInline = true;
      el.srcObject = dest.stream;
      await el.setSinkId(deviceId || '');
      await el.play();
    } else {
      gain.connect(ctx.destination);
    }

    await new Promise((resolve) => setTimeout(resolve, totalDur * 1000 + 100));
    oscillators.forEach((o) => { try { o.disconnect(); } catch (_) {} });
  } finally {
    try { el && el.pause(); } catch (_) {}
    if (el) el.srcObject = null;
    await ctx.close().catch(() => {});
  }
}

async function changeAudioOutput() {
  // Enforce: never zero ticks. The System-default checkbox is auto-re-ticked
  // so the UI always reflects where TTS is actually going.
  if (ensureAtLeastOneOutputTicked()) {
    log('info', 'At least one output device must stay selected — System default re-enabled.');
  }
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

// Walks every running session and reports which concrete deviceIds are
// actually attached to a live mic track or a wired-up sink right now. Used
// to paint the "live" badges in the device list. Each session's
// passthrough contributes its own mic + sink ids; the union across all
// sessions is what the UI shows.
function collectLiveDeviceState() {
  const micIds = new Set();
  const ttsIds = new Set();
  const passthroughIds = new Set();
  for (const session of state.sessions.values()) {
    if (session.running) {
      if (session.capture && typeof session.capture.getActiveMicId === 'function') {
        const mid = session.capture.getActiveMicId();
        if (mid !== null) micIds.add(mid);
      }
      if (session.player && typeof session.player.getActiveSinkIds === 'function') {
        for (const sid of session.player.getActiveSinkIds()) ttsIds.add(sid);
      }
    }
    const pt = session.micPassthrough;
    if (pt && pt.running) {
      if (typeof pt.getActiveMicId === 'function') {
        const mid = pt.getActiveMicId();
        if (mid !== null) micIds.add(mid);
      }
      if (typeof pt.getActiveSinkIds === 'function') {
        for (const sid of pt.getActiveSinkIds()) passthroughIds.add(sid);
      }
    }
  }
  return { micIds, ttsIds, passthroughIds };
}

// Paints the current passthrough level (0..1) into the --pt-level CSS
// variable on every .is-live-passthrough row in the passthrough section.
// Wired to each session's CompanionPassthrough onLevel, which fires when
// the companion emits its periodic level events. Only the active session
// drives the visual — other sessions running in the background don't fight
// the indicator.
function paintPassthroughLevel(session, level) {
  if (!els.passthroughOutput) return;
  if (!session || !isActive(session)) return;
  if (document.hidden) return;
  const pct = levelToPct(level) | 0;
  if (session._lastPassthroughPct === pct) return;
  session._lastPassthroughPct = pct;
  els.passthroughOutput
    .querySelectorAll('.device-option.is-live-passthrough')
    .forEach((row) => { row.style.setProperty('--pt-level', pct + '%'); });
}

// Paints the live indicators on the device lists and the input dropdown.
// Idempotent and cheap; safe to call on a timer or any event.
function refreshActiveDeviceIndicators() {
  const { micIds, ttsIds, passthroughIds } = collectLiveDeviceState();

  if (els.audioOutput) {
    els.audioOutput.querySelectorAll('.device-option').forEach((row) => {
      const id = row.dataset.deviceId || '';
      row.classList.toggle('is-live-tts', ttsIds.has(id));
    });
  }

  if (els.passthroughOutput) {
    els.passthroughOutput.querySelectorAll('.device-option').forEach((row) => {
      const id = row.dataset.deviceId || '';
      const wasPt = row.classList.contains('is-live-passthrough');
      const isPt = passthroughIds.has(id);
      row.classList.toggle('is-live-passthrough', isPt);
      // Zero out the level when a row drops out of live state so the meter
      // bar doesn't freeze at its last value after passthrough is disabled.
      if (wasPt && !isPt) row.style.setProperty('--pt-level', '0%');
    });
  }

  // Input: a single dropdown can only show one row, so we surface the live
  // device(s) in a status pill under it. When the user picked "System default"
  // we also reveal what device that actually resolved to.
  if (els.audioInputLive) {
    const liveIds = Array.from(micIds);
    if (liveIds.length === 0) {
      els.audioInputLive.textContent = '';
      els.audioInputLive.classList.remove('is-visible');
    } else {
      const names = liveIds.map((id) => deviceLabelForId(id, 'input'));
      els.audioInputLive.textContent = 'Live: ' + names.join(', ');
      els.audioInputLive.classList.add('is-visible');
    }
  }
}

// Resolve a deviceId to its human label by reading the cached enumeration
// (input select or output checkbox list). Falls back to the raw id.
function deviceLabelForId(id, kind) {
  if (kind === 'input') {
    if (!els.audioInput) return id || 'System default';
    const opt = Array.from(els.audioInput.options).find((o) => o.value === id);
    if (opt) return opt.textContent;
    // 'System default' has value=''; if a real id is live but the option list
    // hasn't enumerated it (no permission yet), say so.
    if (!id) return 'System default';
    return id.slice(0, 8) + '…';
  }
  // output
  const cb = els.audioOutput
    ? els.audioOutput.querySelector(`input.dev-tts[value="${cssEscape(id)}"]`) : null;
  if (cb) {
    const span = cb.closest('.device-option').querySelector('.device-name');
    if (span) return span.textContent;
  }
  return id || 'System default';
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
  // During a mid-session mic swap, two captures briefly run in parallel (the
  // new one starts before the old one stops, so the user doesn't hear a gap
  // in their meter). Treat both feeds as silence for the overlap so the model
  // doesn't receive doubled audio and Gemini's VAD doesn't get confused.
  if (session.muteInput || pttMuted || session._swappingCapture) {
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
  // The browser used to fan companion PCM into a local passthrough mixer;
  // with the companion handling its own per-session passthrough, the loopback
  // it captures for Gemini is the same loopback it routes to the cable, so
  // no PCM forwarding from this side is needed.
  return new LiveAudio.CompanionAudioCapture({
    onChunk: (buf) => {
      sendAudioGated(session, buf);
    },
    onLevel: (l) => setMicLevelFor(session, l),
    onDisplayEnded: () => {
      if (!session.running) return;
      log('warn', 'Companion audio service disconnected.');
      stopSession(session);
    },
    onReconnectState: ({ state: reconnectState, attempt, delay }) => {
      if (!session.running) return;
      if (reconnectState === 'reconnecting') {
        setSessionStatus(session, 'reconnecting');
        if (attempt === 1 || attempt % 5 === 0) {
          log('warn', `Companion audio disconnected; retrying in ${(delay / 1000).toFixed(1)}s.`);
        }
      } else if (reconnectState === 'reconnected') {
        log('info', 'Companion audio reconnected.');
        setSessionStatus(session, 'connected');
      }
    },
  });
}

async function changeAudioInput() {
  els.audioInput.dataset.preferred = els.audioInput.value;
  onSettingsChange();
  // Keep the preview meter pointed at the user's current pick — restart it
  // against the new device so the visualizer doesn't keep listening to the
  // old one until the auto-stop timer fires.
  if (state.inputPreview && state.inputPreview.running) {
    startMicPreview();
  }
  const session = activeSession();
  if (!session || !session.running) return;

  const audioMode = session.currentAudioMode || session.config.audioSource || 'mic';
  if (audioMode === 'display' || audioMode === 'companion') {
    log('info', 'Microphone changed; it will apply when microphone input is used.');
    return;
  }

  // Gate sendAudioGated → silence while the new capture is starting and the
  // old one is still feeding chunks. Without this, the model receives an
  // overlap of both mics for the ~tens of milliseconds between start() and
  // stop(), occasionally producing a stuck "speaking" turn.
  session._swappingCapture = true;
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
  } finally {
    session._swappingCapture = false;
  }
  // Re-apply this session's passthrough so any sink-list change picked up
  // alongside the device swap is applied; the mic attachment above already
  // routes the new stream into the existing mix.
  applyPassthrough(session);
}

// ─── Status pill / per-session display ────────────────────────────────────────
// Each session has a "base" status set by the Gemini Live client (idle,
// connecting, connected, translating, reconnecting, error). On top of that we
// derive two UI-only overlays:
//   - paused:  user hit the pause button; mic is gated out
//   - waiting: PTT mode is on, session is connected, but the key isn't held
// Switching is deliberately not part of effectiveStatus. It is a GoAway renewal
// overlay shown in the age/timer slot, so the state text can keep tracking the
// real connection/listening/speaking transition underneath.
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
    if (b) {
      const key = b.label || keyLabelFromVk(b.vkCode);
      return (b.mode === 'toggle') ? ('Tap ' + key) : ('Hold ' + key);
    }
    return 'Tap to talk';
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
  // Renew's enabled state depends on ws.readyState, which only flips alongside
  // these status transitions — keep the button in sync here so we don't have
  // to hook every WS open/close site.
  if (isActive(session)) applyControlButtonsForActiveSession();
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

  paintSessionAge(session);
  // PiP mirrors the followed session's status, not the active one — so the
  // popout stays consistent with the transcript it's showing. setEffectiveStatus
  // drives the background tint (calm listening, lit speaking, amber reconnect,
  // red error); setRunning toggles the playing/paused/idle visual.
  if (state.pip && state.pipFollowingSessionId === session.id) {
    state.pip.setStatus(text, eff === 'translating' || eff === 'connected');
    state.pip.setEffectiveStatus(eff);
    state.pip.setRunning(!!session.running, !!session.paused, !!session.isAudio);
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

// When a GoAway is pending, surface the countdown to the renewal deadline in
// the chip's timer slot and on the Renew button so the user sees the limit
// approaching. During the brief close+reconnect tail (deadline cleared but
// switching flag still raised), fall back to "Renewing" — there's no
// countdown to show and the session is genuinely between WS sockets.
function renewLabelFor(session) {
  if (!session || !session.switching) return null;
  const deadline = session.client && session.client.goAwayDeadlineMs;
  if (deadline && deadline > Date.now()) {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    return `Renew in ${left}s`;
  }
  return 'Renewing';
}

function sessionAgeText(session) {
  if (!session || !session.running) return '00:00';
  const renew = renewLabelFor(session);
  if (renew) return renew;
  return session.startedAt ? fmtDuration(Date.now() - session.startedAt) : '00:00';
}

// Refreshes the Renew button's enabled state + label. Disabled unless an
// active session has an OPEN ws. Label shows the countdown / "Renewing"
// during a GoAway window, otherwise "Renew". Called from both
// applyControlButtonsForActiveSession (state transitions) and paintSessionAge
// (1Hz countdown tick).
function applyRenewButtonForActiveSession() {
  const btn = els.btnForceReset;
  if (!btn) return;
  const session = activeSession();
  const label = btn.querySelector('.btn-tx');
  const renewMsg = session && session.running ? renewLabelFor(session) : null;
  if (label) label.textContent = renewMsg || 'Renew';
  if (renewMsg && session && session.client && session.client.goAwayDeadlineMs > Date.now()) {
    btn.title = `Auto-${renewMsg.toLowerCase()} — click to renew now`;
  } else {
    btn.title = 'Reconnect with a fresh context';
  }
  const ws = session && session.client && session.client.ws;
  btn.disabled = !(session && session.running && ws && ws.readyState === WebSocket.OPEN);
}

function paintSessionAge(session) {
  if (!session) return;
  const txt = sessionAgeText(session);
  const isSwitching = !!session.switching;
  if (session.tabEl) session.tabEl.classList.toggle('is-switching', isSwitching);
  if (session.tabAgeEl) {
    session.tabAgeEl.textContent = txt;
    session.tabAgeEl.classList.toggle('is-switching', isSwitching);
  }
  // Mirror the countdown onto the Renew button each tick so "Renew in Ns"
  // decrements in lockstep with the chip's age slot. Only the active
  // session's switching state can be reflected on the single global button.
  if (isSwitching && isActive(session)) applyRenewButtonForActiveSession();
}

// One global 1Hz tick that paints the age of every running session. Previously
// each session owned its own setInterval, drifting in phase and burning extra
// timer slots. Lifecycle: ensure on the first running session, stop when none
// remain. ensureAgeTick() is idempotent; maybeStopAgeTick() is a no-op when
// any session is still running.
let _ageTickHandle = 0;
function _anyRunningSession() {
  for (const s of state.sessions.values()) if (s.running) return true;
  return false;
}
function ensureAgeTick() {
  if (_ageTickHandle) return;
  _ageTickHandle = setInterval(() => {
    for (const s of state.sessions.values()) {
      if (s.running) paintSessionAge(s);
    }
  }, 1000);
}
function maybeStopAgeTick() {
  if (!_ageTickHandle) return;
  if (_anyRunningSession()) return;
  clearInterval(_ageTickHandle);
  _ageTickHandle = 0;
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

// Dump the visible log lines (up to MAX_LOG) as a plain .txt file. Reads from
// the DOM rather than a parallel buffer so what you download matches what you
// see — and so the export honours the same ring-buffer trimming.
function exportLog() {
  const lines = Array.from(els.log.children).map((line) => {
    const ts = line.querySelector('.ts')?.textContent || '';
    const lv = line.querySelector('.level')?.textContent || '';
    const msg = line.querySelector('.msg')?.textContent || '';
    return `${ts} ${lv.padEnd(5)} ${msg}`;
  });
  if (lines.length === 0) {
    log('warn', 'Log is empty — nothing to export.');
    return;
  }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  a.href = url;
  a.download = `translator-log_${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

  // Whether to autoscroll is now strictly driven by session.followLatest (the
  // lock). The scroll listener auto-unlocks the moment the user scrolls away,
  // so by the time we get here followLatest is already false if the user is
  // reading backward — we just have to honor it.
  const el = session.transcriptEl;
  const autoScroll = !!session.followLatest;

  if (session.pendingInput) {
    if (t.inputText === '') {
      t.inputEl.classList.remove('empty');
      t.inputTextNode.nodeValue = '';
      t.inputCaret.style.display = '';
    }
    t.inputText += session.pendingInput;
    t.inputTextNode.nodeValue = t.inputText;
    session.pendingInput = '';
    if (state.pip && state.pipFollowingSessionId === session.id) state.pip.setInput(t.inputText);
    if (!t.outputText) t.root.classList.add('is-thinking');
  }
  if (session.pendingOutput) {
    t.root.classList.remove('is-thinking');
    if (t.outputEl) {
      if (t.outputText === '') {
        t.outputEl.classList.remove('empty');
        t.outputTextNode.nodeValue = '';
        if (t.outputCaret) t.outputCaret.style.display = '';
      }
      t.outputText += session.pendingOutput;
      t.outputTextNode.nodeValue = t.outputText;
      if (state.pip && state.pipFollowingSessionId === session.id) state.pip.setOutput(t.outputText);
    }
    session.pendingOutput = '';
  }
  if (el && autoScroll) {
    el.scrollTop = el.scrollHeight;
  }
  // scrollHeight just grew — re-evaluate the stuck flag so the jump-to-latest
  // button surfaces the first time the transcript exceeds the viewport while
  // the user is reading older turns. The scroll event from autoscroll would
  // refresh this too, but only if autoScroll was true.
  if (session.refreshScrollStuck) session.refreshScrollStuck();

  noteContinuousActivity(session);
}

// Segment the live turn for continuous (translate) sessions, which get no
// turnComplete from the model. Called after each flush: resets an idle timer so
// the turn finalizes ~CONTINUOUS_TURN_IDLE_MS after transcription stops (a
// natural pause), and force-finalizes once the turn exceeds CONTINUOUS_TURN_MAX_MS
// so a gapless source still produces readable, persisted turns. No-op for the
// turn-based live engine, which finalizes on onTurnComplete instead.
function noteContinuousActivity(session) {
  if (!session || session._finalizing || !session.running || !session.liveTurn) return;
  if (!session.config || session.config.engine !== 'translate') return;
  const t = session.liveTurn;
  if (t.startedAt && (Date.now() - t.startedAt) >= CONTINUOUS_TURN_MAX_MS) {
    // finalizeTurn clears the idle timer; the next chunk opens a fresh turn.
    finalizeTurn(session);
    return;
  }
  if (session._contIdleTimer) clearTimeout(session._contIdleTimer);
  session._contIdleTimer = setTimeout(() => {
    session._contIdleTimer = 0;
    finalizeTurn(session);
  }, CONTINUOUS_TURN_IDLE_MS);
}

function formatTurnTimestamp(ts, { includeDate = false } = {}) {
  if (!ts) return '';
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  return includeDate ? d.toLocaleString() : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isoTurnTimestamp(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function createTurnTimestampEl(ts) {
  const el = document.createElement('time');
  el.className = 'turn-time';
  el.textContent = formatTurnTimestamp(ts);
  const iso = isoTurnTimestamp(ts);
  if (iso) {
    el.dateTime = iso;
    el.title = formatTurnTimestamp(ts, { includeDate: true });
  }
  return el;
}

function trimTranscriptDOM(host) {
  while (host && host.children.length > MAX_TURNS) {
    host.removeChild(host.firstChild);
  }
}

function renderHistoryTurn(session, h) {
  const host = session && session.transcriptEl;
  if (!host) return;
  removeSessionEmptyState(session);
  const isTranscribe = session.config.mode === 'transcribe';
  const root = document.createElement('div');
  root.className = 'turn' + (isTranscribe ? ' turn-single' : '');

  const time = createTurnTimestampEl(h.finalizedAt);
  if (time.textContent) root.appendChild(time);

  const inRow = document.createElement('div');
  inRow.className = 'turn-row input';
  const inLab = document.createElement('span');
  inLab.className = 'turn-label';
  inLab.textContent = '🎙 ' + sessionSourceLabel(session.config);
  const inText = document.createElement('span');
  const input = h.input || '';
  inText.className = 'turn-text' + (input ? '' : ' empty');
  inText.textContent = input || '(silence)';
  inRow.appendChild(inLab);
  inRow.appendChild(inText);
  root.appendChild(inRow);

  if (!isTranscribe) {
    const outRow = document.createElement('div');
    outRow.className = 'turn-row output';
    const outLab = document.createElement('span');
    outLab.className = 'turn-label';
    outLab.textContent = '→ ' + sessionTargetLabel(session.config);
    const outText = document.createElement('span');
    const output = h.output || '';
    outText.className = 'turn-text' + (output ? '' : ' empty');
    outText.textContent = output || '(no translation)';
    outRow.appendChild(outLab);
    outRow.appendChild(outText);
    root.appendChild(outRow);
  }

  host.appendChild(root);
  trimTranscriptDOM(host);
}

function renderSessionHistory(session) {
  if (!session || !session.transcriptEl || !Array.isArray(session.history) || session.history.length === 0) return;
  for (const h of session.history.slice(-MAX_TURNS)) renderHistoryTurn(session, h);
  session.transcriptEl.scrollTop = session.transcriptEl.scrollHeight;
}

function ensureLiveTurn(session) {
  if (session.liveTurn) return session.liveTurn;
  const host = session.transcriptEl;
  if (!host) return null;
  removeSessionEmptyState(session);

  const isTranscribe = session.config.mode === 'transcribe';

  const root = document.createElement('div');
  root.className = 'turn live' + (isTranscribe ? ' turn-single' : '');
  const startedAt = Date.now();
  const time = createTurnTimestampEl(startedAt);
  if (time.textContent) root.appendChild(time);

  const inRow = document.createElement('div');
  inRow.className = 'turn-row input';
  const inLab = document.createElement('span');
  inLab.className = 'turn-label';
  inLab.textContent = '🎙 ' + sessionSourceLabel(session.config);
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
    outLab.textContent = '→ ' + sessionTargetLabel(session.config);
    outText = document.createElement('span');
    outText.className = 'turn-text empty';
    outTextNode = document.createTextNode('…');
    outText.appendChild(outTextNode);
    outCaret = document.createElement('span'); outCaret.className = 'caret'; outCaret.style.display = 'none';
    outText.appendChild(outCaret);
    outRow.appendChild(outLab); outRow.appendChild(outText);
    root.appendChild(inRow); root.appendChild(outRow);
    const thinking = document.createElement('span');
    thinking.className = 'turn-thinking';
    thinking.setAttribute('aria-hidden', 'true');
    thinking.innerHTML = '<span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span>';
    root.appendChild(thinking);
  } else {
    root.appendChild(inRow);
  }

  host.appendChild(root);

  trimTranscriptDOM(host);

  session.liveTurn = {
    root,
    timeEl: time,
    startedAt,
    inputEl: inText,
    outputEl: outText,
    inputTextNode: inTextNode,
    outputTextNode: outTextNode,
    inputCaret: inCaret,
    outputCaret: outCaret,
    inputText: '',
    outputText: '',
  };

  if (state.pip && state.pipFollowingSessionId === session.id) {
    state.pip.setLangs(sessionSourceLabel(session.config), sessionTargetLabel(session.config));
    state.pip.setInput('');
    state.pip.setOutput('');
  }
  return session.liveTurn;
}

function appendInputFor(session, chunk)  { session.pendingInput  += chunk; scheduleFlush(session); }
function appendOutputFor(session, chunk) { session.pendingOutput += chunk; if (session.liveTurn) session.liveTurn.root.classList.remove('is-thinking'); scheduleFlush(session); }
function clearThinkingFor(session) { if (session && session.liveTurn) session.liveTurn.root.classList.remove('is-thinking'); }

function finalizeTurn(session) {
  if (session._contIdleTimer) { clearTimeout(session._contIdleTimer); session._contIdleTimer = 0; }
  // Guard the flush below from re-triggering segmentation (flushPending →
  // noteContinuousActivity → finalizeTurn) while we're already finalizing.
  session._finalizing = true;
  flushPending(session);
  session._finalizing = false;
  if (!session.liveTurn) return;
  const t = session.liveTurn;
  t.root.classList.remove('is-thinking');
  t.inputCaret.remove();
  if (t.outputCaret) t.outputCaret.remove();
  if (!t.inputText.trim())  { t.inputEl.classList.add('empty');  t.inputTextNode.nodeValue = '(silence)'; }
  if (t.outputEl && !t.outputText.trim()) { t.outputEl.classList.add('empty'); t.outputTextNode.nodeValue = '(no translation)'; }
  t.root.classList.remove('live');
  // Persist into the per-session history so the export survives DOM trimming.
  // Skip turns that produced literally nothing (mic open but no speech) so the
  // exported file isn't padded with (silence)/(no translation) noise.
  const inText = t.inputText.trim();
  const outText = t.outputEl ? t.outputText.trim() : '';
  if (inText || outText) {
    const finalizedAt = Date.now();
    if (t.timeEl) {
      t.timeEl.textContent = formatTurnTimestamp(finalizedAt);
      const iso = isoTurnTimestamp(finalizedAt);
      if (iso) {
        t.timeEl.dateTime = iso;
        t.timeEl.title = formatTurnTimestamp(finalizedAt, { includeDate: true });
      }
    }
    session.history.push({ input: inText, output: outText, finalizedAt });
    scheduleSaveSessions();
  }
  session.liveTurn = null;
  refreshSessionHeader(session);
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
  // Quantize to integer percent and skip the write when nothing visibly changed.
  // LevelMeter callbacks fire at ~60Hz; with 3 sessions × 2 meters this is
  // ~360 DOM writes/sec at baseline. Most of those produce no visual delta —
  // the rounded percent only steps about a dozen times per second of audio.
  // Background-tab paints are also wasted; the rAF still ticks slowly there.
  if (document.hidden) return;
  const pct = levelToPct(level) | 0;
  if (el._lastPct === pct) return;
  el._lastPct = pct;
  el.style.width = pct + '%';
}

function setMicLevelFor(session, level) {
  // Paused sessions: freeze the meter at zero so the user clearly sees the mic
  // is NOT reaching the model, even though the capture is technically still
  // open. PTT-waiting sessions still show real level — that confirms the mic
  // is hearing them, while the status text says "Hold [KEY]".
  session.lastMicLevel = level;
  paintMeterFill(session.tabMicFill, level);
}

function setOutLevelFor(session, level) {
  session.lastOutLevel = level;
  paintMeterFill(session.tabOutFill, level);
}

// ─── Control-bar state ───────────────────────────────────────────────────────
// Flips the visible face of the combined Start/Stop control. The two <button>s
// remain in the DOM (so existing .disabled wiring is untouched); CSS shows one
// based on this attribute.
function setStartStopRunning(running) {
  const wrap = els.btnStart && els.btnStart.parentElement;
  if (wrap) wrap.dataset.running = running ? 'true' : 'false';
}

function applyControlButtonsForActiveSession() {
  const session = activeSession();
  if (!session) {
    els.btnStart.disabled = true;
    els.btnStop.disabled = true;
    setStartStopRunning(false);
    els.btnHush.disabled = true;
    els.btnPause.disabled = true;
    els.btnPause.classList.remove('is-paused');
    els.btnPause.title = 'Pause mic';
    els.btnPause.setAttribute('aria-label', 'Pause mic');
    els.btnPause.setAttribute('aria-pressed', 'false');
    applyRenewButtonForActiveSession();
    setControlsLocked(false);
    if (state.pip) state.pip.setRunning(false, false, true);
    refreshPttButtonState();
    return;
  }
  els.btnStart.disabled = session.running;
  els.btnStop.disabled = !session.running;
  setStartStopRunning(!!session.running);
  els.btnHush.disabled = !session.running || !session.isAudio;
  els.btnPause.disabled = !session.running;
  // Renew button: enable/disable + label (countdown / "Renewing" / "Renew").
  // See applyRenewButtonForActiveSession for the full rules.
  applyRenewButtonForActiveSession();
  els.btnPause.classList.toggle('is-paused', !!session.paused);
  els.btnPause.title = session.paused ? 'Resume mic' : 'Pause mic';
  // Keep aria-label and aria-pressed in sync so SR users hear the right state.
  els.btnPause.setAttribute('aria-label', session.paused ? 'Resume mic' : 'Pause mic');
  els.btnPause.setAttribute('aria-pressed', session.paused ? 'true' : 'false');
  setControlsLocked(session.running);
  // Mirror into PIP so its Start/Stop/Pause/Hush buttons stay in sync — eg.
  // when togglePause runs from the main control bar, the PIP's pause label
  // flips on the same frame.
  if (state.pip) state.pip.setRunning(!!session.running, !!session.paused, !!session.isAudio);
  refreshPttButtonState();
}

// ─── Push-to-talk button (standalone) ────────────────────────────────────────
// The footer Talk button and the PIP popup Talk button are toggles for the
// active session's PTT engagement. Both write through setPttEngaged below,
// which flips session.pttHeld — the same flag sendAudioGated already uses to
// decide whether to send real audio or silence.

// Reflect the active session's PTT visibility + engagement state into both
// the footer and the PIP buttons. Idempotent — safe to call after any state
// change that could affect either.
function refreshPttButtonState() {
  const session = activeSession();
  const isPtt = !!(session && session.config && session.config.pttMode === 'ptt');
  const engaged = !!(session && session.pttHeld);
  // The button stays clickable while the model speaks back so the user can
  // disengage mid-response. Audio gating during TTS is handled by
  // session.muteInput inside sendAudioGated — flipping pttHeld is harmless
  // while the mic is silenced anyway.
  const canEngage = isPtt && !!session && !!session.running && !session.paused;

  if (els.btnPtt) {
    els.btnPtt.classList.toggle('is-hidden', !isPtt);
    els.btnPtt.disabled = !canEngage;
    els.btnPtt.dataset.engaged = engaged ? 'true' : 'false';
    els.btnPtt.setAttribute('aria-pressed', engaged ? 'true' : 'false');
    els.btnPtt.title = engaged ? 'Tap to stop' : 'Push to talk — tap to start, tap to stop';
    const tx = els.btnPtt.querySelector('.btn-tx');
    if (tx) tx.textContent = engaged ? 'Translate' : 'Speak';
  }
  if (state.pip) {
    state.pip.setPttVisible(isPtt);
    state.pip.setPttEngaged(engaged);
    state.pip.setPttDisabled(!canEngage);
  }
}

function setPttEngaged(session, engaged) {
  if (!session) return;
  if (!session.running) return;
  if (!session.config || session.config.pttMode !== 'ptt') return;
  if (!!session.pttHeld === !!engaged) return;
  session.pttHeld = !!engaged;
  if (session.client) {
    try {
      if (engaged) session.client.sendActivityStart();
      else session.client.sendActivityEnd();
    } catch (_) {}
  }
  refreshSessionDisplay(session);
  refreshPttButtonState();
}

// TODO: togglePtt always acts on the main window's activeSession(), which
// may differ from the session the PiP window is currently following.
function togglePtt() {
  const session = activeSession();
  if (!session) return;
  setPttEngaged(session, !session.pttHeld);
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

  // Release the preview mic if it's open — the live session is about to grab
  // the same device and the user no longer needs the standalone visualizer
  // (the per-session tab meter takes over).
  await stopMicPreview();

  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    openSheet('sidebar');
    log('error', 'Paste your Gemini API key first.');
    els.apiKey.focus();
    return;
  }
  const cfg = session.config;
  const isTranslate = cfg.engine === 'translate';
  // The translate engine auto-detects the source, so there's no source/target
  // pair to validate — only the live engine needs distinct languages.
  if (!isTranslate && cfg.source === cfg.target) {
    log('error', 'Source and target languages must differ.');
    return;
  }
  savePrefs();

  const isAudio = isTranslate ? true : cfg.mode === 'audio';

  setSessionStatus(session, 'connecting');
  // Eagerly disable Start while the pipeline negotiates so a double-click
  // doesn't fire a second startSession. session.running flips true after
  // session.client.start() succeeds.
  if (isActive(session)) {
    els.btnStart.disabled = true;
    els.btnStop.disabled = false;
    setStartStopRunning(true);
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

  // PTT is a live-engine affordance only; the translate model streams
  // continuously and has no manual-activity signalling.
  const isPtt = !isTranslate && cfg.pttMode === 'ptt';

  // Output transcription is on for everything except live transcribe mode.
  const wantsOutputText = isTranslate || cfg.mode !== 'transcribe';

  const clientOpts = {
    apiKey,
    voice: cfg.voice,
    resumeHandle: session.resumeHandle || null,
    onResumeHandle: (handle) => {
      session.resumeHandle = handle || null;
      scheduleSaveSessions();
    },
    useOutputTranscription: wantsOutputText,
    onAudio: isAudio ? (b64) => { clearThinkingFor(session); state.ttsCoordinator.enqueueChunk(session, b64); } : () => {},
    onInputChunk:  (chunk) => appendInputFor(session, chunk),
    onOutputChunk: wantsOutputText ? (chunk) => appendOutputFor(session, chunk) : () => {},
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
    onSwitching: (on) => {
      session.switching = !!on;
      refreshSessionDisplay(session);
    },
    onLog: log,
  };

  if (isTranslate) {
    // Dedicated translation model: config-driven, no system prompt, no VAD.
    clientOpts.model = GeminiLive.TRANSLATE_MODEL;
    clientOpts.translationConfig = {
      targetLanguageCode: cfg.translateTarget || DEFAULT_TRANSLATE_TARGET,
      echoTargetLanguage: !!cfg.echoTarget,
    };
    clientOpts.manualActivity = false;
  } else {
    clientOpts.systemInstruction = GeminiLive.renderSystemPrompt(
      effectivePromptTemplateFor(cfg.mode, cfg.dir),
      langName(cfg.source), langName(cfg.target));
    clientOpts.vad = cfg.vad;
    // manualActivity disables Gemini's auto VAD so we control turn boundaries
    // via activityStart/activityEnd (sent from the PTT key handlers below).
    clientOpts.manualActivity = isPtt;
  }

  session.client = new GeminiLive.GeminiLiveClient(clientOpts);

  // PTT integration:
  //   - The in-page Talk button (footer + popup) is the primary input and
  //     drives session.pttHeld directly via setPttEngaged().
  //   - When the companion app is reachable AND a hotkey is bound, we also
  //     subscribe to its global key events so the same engaged state can be
  //     driven from outside the browser. Both inputs share session.pttHeld,
  //     so the two paths stay in sync as long as the user picks one at a
  //     time. (Cross-talking — toggling via button mid-companion-toggle —
  //     can briefly desync until the next user input.)
  if (isPtt && state.pttClient) {
    state.pttClient.subscribe(session.id,
      () => {
        session.pttHeld = true;
        if (session.client) session.client.sendActivityStart();
        refreshSessionDisplay(session);
        refreshPttButtonState();
      },
      () => {
        session.pttHeld = false;
        if (session.client) session.client.sendActivityEnd();
        refreshSessionDisplay(session);
        refreshPttButtonState();
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
      // Source feeding for the passthrough is no longer hand-wired here:
      // the companion captures its own mic/loopback when applyPassthrough()
      // sends the session's source descriptor. Display/tab passthrough was
      // dropped along with the in-browser mix (the companion can't open
      // getDisplayMedia); a `'display'` mode passthrough now goes silent.
    }
    session.currentAudioMode = audioMode;
    // Capture which physical mic getUserMedia resolved to so the dropdown's
    // "System default" label can grow into "System default (X)".
    if (session.capture && session.capture.actualMicDeviceId) {
      state.resolvedMicDeviceId = session.capture.actualMicDeviceId;
    }
    await refreshAudioInputDevices();
    await refreshAudioOutputDevices();
    refreshActiveDeviceIndicators();
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

  // Now that the session is officially running and its currentAudioMode is
  // set, push the source descriptor to the companion. If passthroughDeviceIds
  // is empty (user hasn't selected any virtual cable) configure() is a no-op
  // and the WS stays closed.
  applyPassthrough(session);

  session.startedAt = Date.now();
  ensureAgeTick();
  // Paint once immediately so the chip doesn't read "00:00" for a full second.
  paintSessionAge(session);

  if (isTranslate) {
    log('info', `Session started: Auto → ${sessionTargetLabel(cfg)} (live translate)`);
  } else {
    const dirLabel = cfg.dir === 'oneway' ? '→' : '⇄';
    const modeLabel = cfg.mode !== 'audio' ? ` (${cfg.mode === 'text' ? 'text only' : 'transcribe'})` : '';
    log('info', `Session started: ${langName(cfg.source)} ${dirLabel} ${langName(cfg.target)}${modeLabel}`);
  }
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
  // Stop is a clean ending — drop the resume handle so the next Start opens
  // a fresh session instead of silently resuming the prior conversation.
  // (Real reconnects within a running session still resume via the client's
  // in-memory handle; this only affects the *next* startSession.)
  session.resumeHandle = null;
  if (session.client) session.client.resumeHandle = null;
  saveSessions();
  try { session.client && session.client.stop(); } catch (_) {}
  try { session.capture && session.capture.stop(); } catch (_) {}
  // Tear down the companion-side passthrough sources. configure() with an
  // empty source descriptor while sinks remain in the saved selection
  // closes the WS (the companion has nothing to capture or render); the
  // sink list survives in session.config.passthroughDeviceIds so the next
  // startSession reopens with the user's routing intact.
  if (session.micPassthrough) {
    try { session.micPassthrough.configure([], { micId: '', micLabel: '', pid: 0, loopback: false }); } catch (_) {}
  }
  try { if (session.player) await session.player.destroy(); } catch (_) {}
  session.client = null;
  session.capture = null;
  session.player = null;
  session.currentAudioMode = '';
  session.running = false;
  session.paused = false;
  session.switching = false;
  maybeStopAgeTick();
  finalizeTurn(session);
  setSessionStatus(session, 'idle');
  // Stale meter state would imply audio is still flowing; zero it explicitly.
  session.lastMicLevel = 0;
  session.lastOutLevel = 0;
  paintMeterFill(session.tabMicFill, 0);
  paintMeterFill(session.tabOutFill, 0);
  paintSessionAge(session);
  if (isActive(session)) {
    applyControlButtonsForActiveSession();
    paintSessionAge(session);
  }
  refreshBulkActionButtons();
  refreshActiveDeviceIndicators();
  session._stopping = false;
}

function setControlsLocked(locked) {
  els.engineSelect.disabled  = locked;
  els.langSource.disabled    = locked;
  els.langTarget.disabled    = locked;
  if (els.translateTarget) els.translateTarget.disabled = locked;
  if (els.echoTarget)      els.echoTarget.disabled      = locked;
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

// Force-disconnect the active session's WebSocket and wipe its resume handle.
// The reconnect ladder fires automatically and reopens as a fresh session
// (no handle = new context). Destructive — loses all in-flight context.
// Shared by the main page's "Force reconnect" button and the PiP header ↻.
function forceResetActiveSession() {
  const session = activeSession();
  if (!session || !session.client) {
    log('warn', 'No active session to force-reset.');
    return;
  }
  log('warn', 'Force reconnect: clearing resume handle and dropping WebSocket.');
  session.resumeHandle = null;
  session.client.resumeHandle = null;
  session.switching = false;
  refreshSessionDisplay(session);
  saveSessions();
  session.client.forceCloseWebSocket(4001, 'user-reset');
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
  // Re-probe device labels every time the sidebar comes up. Once mic
  // permission is granted (by a previous session start, by user action in
  // browser UI, or by another tab), enumerateDevices starts returning labels
  // — but only after we call it again. This is cheap and silent.
  if (isSidebar) refreshDeviceListsIfStale();
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

  // Local `modal` (not `state`) so we don't shadow the module-level `state`
  // object — a future maintainer adding `state.foo` to this function would
  // otherwise silently read from the wrong object.
  const modal = modalState.get(id);
  if (!modal) return;                  // wasn't opened modally (e.g., docked sidebar)
  modalState.delete(id);

  if (modal.content && modal.trapHandler) {
    modal.content.removeEventListener('keydown', modal.trapHandler);
  }
  if (modal.content && modal.restoreRole !== null) {
    modal.content.setAttribute('role', modal.restoreRole);
    modal.content.removeAttribute('aria-modal');
  }
  // Restore focus to whoever opened the sheet. If they vanished (e.g., a tab
  // was closed), fall back to body so focus isn't stuck on a detached element.
  if (modal.opener && document.contains(modal.opener)) {
    try { modal.opener.focus({ preventScroll: true }); }
    catch (_) { try { modal.opener.focus(); } catch (__) {} }
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

async function clearConversation(session) {
  if (!session) session = activeSession();
  if (!session) return;
  // No confirmation when there's nothing to lose — empty state is the only
  // child, so clearing is a visual no-op anyway.
  const turnCount = session.transcriptEl
    ? session.transcriptEl.querySelectorAll(':scope > .turn').length
    : 0;
  if (turnCount > 0 || session.history.length > 0) {
    const ok = await showConfirm({
      title: 'Clear conversation?',
      message: 'Clear this session\'s conversation? This cannot be undone.',
      confirmLabel: 'Clear',
      confirmStyle: 'danger',
    });
    if (!ok) return;
  }
  session.liveTurn = null;
  session.history = [];
  session.exportedTurnCount = 0;
  session.pendingInput = '';
  session.pendingOutput = '';
  if (session.transcriptEl) {
    session.transcriptEl.innerHTML = '';
    renderSessionEmptyState(session);
  }
  if (state.pip && isActive(session)) { state.pip.setInput(''); state.pip.setOutput(''); }
  refreshSessionHeader(session);
  saveSessions();
}

function conversationTurns(session) {
  if (!session) return [];
  // Pull from the in-memory history (survives the MAX_TURNS DOM trim) plus
  // the in-progress live turn so a quick export-mid-conversation isn't off
  // by one. Drain any pending chunks first so the live turn's text is fresh.
  if (session.pendingScheduled) flushPending(session);
  const out = session.history.map((h, i) => ({
    index: i + 1,
    input: h.input || '',
    output: h.output || '',
    finalizedAt: isoTurnTimestamp(h.finalizedAt),
    finalizedAtMs: h.finalizedAt || null,
  }));
  if (session.liveTurn) {
    const inText = (session.liveTurn.inputText || '').trim();
    const outText = (session.liveTurn.outputText || '').trim();
    if (inText || outText) {
      const ts = session.liveTurn.startedAt || Date.now();
      out.push({
        index: out.length + 1,
        input: inText,
        output: outText,
        finalizedAt: isoTurnTimestamp(ts),
        finalizedAtMs: ts,
      });
    }
  }
  return out;
}

// Export popup menus live per-session in the session header strip. The
// menu groups "this session" and "all sessions" exports. Each menu is keyed
// off its own (menu, trigger) pair so multiple chips can co-exist without
// clobbering each other's open state. Outside-click and Escape close any
// open menu (handlers in wireUI).
function isExportMenuOpen(menuEl) {
  return !!(menuEl && !menuEl.hasAttribute('hidden'));
}
function openExportMenu(menuEl, triggerEl) {
  if (!menuEl) return;
  closeAllExportMenus(menuEl);
  menuEl.removeAttribute('hidden');
  if (triggerEl) triggerEl.setAttribute('aria-expanded', 'true');
  const firstItem = menuEl.querySelector('.export-item');
  if (firstItem) firstItem.focus();
}
function closeExportMenu(menuEl, triggerEl) {
  if (!menuEl) return;
  if (!isExportMenuOpen(menuEl)) return;
  menuEl.setAttribute('hidden', '');
  if (triggerEl) triggerEl.setAttribute('aria-expanded', 'false');
}
function toggleExportMenu(menuEl, triggerEl) {
  if (isExportMenuOpen(menuEl)) closeExportMenu(menuEl, triggerEl);
  else openExportMenu(menuEl, triggerEl);
}
function closeAllExportMenus(exceptEl) {
  if (!state || !state.sessions) return;
  for (const s of state.sessions.values()) {
    if (!s.headerExportMenu || s.headerExportMenu === exceptEl) continue;
    closeExportMenu(s.headerExportMenu, s.headerExportBtn);
  }
}
function anyExportMenuOpen() {
  if (!state || !state.sessions) return false;
  for (const s of state.sessions.values()) {
    if (isExportMenuOpen(s.headerExportMenu)) return true;
  }
  return false;
}
function findOpenExportMenu() {
  if (!state || !state.sessions) return null;
  for (const s of state.sessions.values()) {
    if (isExportMenuOpen(s.headerExportMenu)) return s;
  }
  return null;
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportableSessionEntries() {
  return [...state.sessions.values()]
    .map((session, i) => ({
      index: i + 1,
      session,
      turns: conversationTurns(session),
    }))
    .filter((entry) => entry.turns.length > 0);
}

function exportTimeline(entries) {
  let collected = 0;
  return entries
    .flatMap((entry) => entry.turns.map((turn) => ({
      index: 0,
      sessionIndex: entry.index,
      sessionId: entry.session.id,
      engine: entry.session.config.engine,
      source: entry.session.config.source,
      target: entry.session.config.target,
      translateTarget: entry.session.config.translateTarget,
      mode: entry.session.config.mode,
      input: turn.input,
      output: turn.output,
      finalizedAt: turn.finalizedAt,
      finalizedAtMs: turn.finalizedAtMs,
      turnIndex: turn.index,
      collectionIndex: collected++,
    })))
    .sort((a, b) => {
      const at = Number.isFinite(a.finalizedAtMs) ? a.finalizedAtMs : Infinity;
      const bt = Number.isFinite(b.finalizedAtMs) ? b.finalizedAtMs : Infinity;
      if (at !== bt) return at - bt;
      if (a.sessionIndex !== b.sessionIndex) return a.sessionIndex - b.sessionIndex;
      if (a.turnIndex !== b.turnIndex) return a.turnIndex - b.turnIndex;
      return a.collectionIndex - b.collectionIndex;
    })
    .map((turn, i) => {
      const { collectionIndex, ...exported } = turn;
      return Object.assign(exported, { index: i + 1 });
    });
}

function exportConversation(format, opts) {
  const scope = (opts && opts.scope === 'all') ? 'all' : 'session';
  let sessions;
  if (scope === 'session') {
    const targetSession = (opts && opts.session) || activeSession();
    if (!targetSession) {
      log('warn', 'No session selected to export.');
      return;
    }
    const turns = conversationTurns(targetSession);
    if (turns.length === 0) {
      log('warn', 'Nothing to export for this session.');
      return;
    }
    sessions = [{ index: 1, session: targetSession, turns }];
  } else {
    sessions = exportableSessionEntries();
    if (sessions.length === 0) {
      log('warn', 'Nothing to export for any session.');
      return;
    }
  }
  const turns = exportTimeline(sessions);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let base;
  if (scope === 'session') {
    const cfg = sessions[0].session.config || {};
    const pair = cfg.engine === 'translate'
      ? `auto-${(cfg.translateTarget || '').toLowerCase()}`
      : `${(cfg.source || '').toLowerCase()}-${(cfg.target || '').toLowerCase()}`;
    base = `live-translator-${pair}-${stamp}`;
  } else {
    base = `live-translator-all-sessions-${stamp}`;
  }
  const exportedAt = new Date();
  if (format === 'json') {
    downloadText(base + '.json', JSON.stringify({
      exportedAt: exportedAt.toISOString(),
      scope,
      sessionCount: sessions.length,
      sessions: sessions.map((entry) => ({
        index: entry.index,
        sessionId: entry.session.id,
        source: entry.session.config.source,
        target: entry.session.config.target,
        mode: entry.session.config.mode,
        config: entry.session.config,
      })),
      turns,
    }, null, 2), 'application/json');
  } else {
    const lines = [
      'Live Translator export',
      `Scope: ${scope === 'session' ? 'single session' : 'all sessions'}`,
      `Sessions: ${sessions.length}`,
      `Exported: ${exportedAt.toLocaleString()}`,
      '',
      ...turns.flatMap((t) => [
        `#${t.index}${t.finalizedAtMs ? ` - ${formatTurnTimestamp(t.finalizedAtMs, { includeDate: true })}` : ''}${scope === 'all' ? ` - Session ${t.sessionIndex}` : ''} - ${sessionSourceLabel(t)} -> ${sessionTargetLabel(t)}`,
        `${sessionSourceLabel(t)}: ${t.input || '(empty)'}`,
        t.mode === 'transcribe' ? '' : `${sessionTargetLabel(t)}: ${t.output || '(empty)'}`,
        '',
      ]),
    ];
    downloadText(base + '.txt', lines.filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n'), 'text/plain');
  }
  // Mark covered sessions as "downloaded up to here" so closeSession doesn't
  // warn about throwing them away. We use history.length (not turns.length),
  // since turns may include the live partial — which will keep growing.
  for (const entry of sessions) {
    entry.session.exportedTurnCount = entry.session.history.length;
  }
  saveSessions();
  if (scope === 'session') {
    log('info', `Exported session as ${format.toUpperCase()}.`);
  } else {
    log('info', `Exported ${sessions.length} session${sessions.length === 1 ? '' : 's'} as ${format.toUpperCase()}.`);
  }
}

// ─── System prompt editor ────────────────────────────────────────────────────
// Snapshot of the textarea contents at last open/save. We compare on close
// (and at beforeunload) to detect unsaved edits and prompt before discarding.
let promptEditorBaseline = '';

function isPromptEditorDirty() {
  if (!els.promptText) return false;
  // Sheet not open and never opened → baseline is '', textarea is '' → clean.
  return els.promptText.value !== promptEditorBaseline;
}

function openPromptEditor() {
  els.promptText.value = effectivePromptTemplate();
  promptEditorBaseline = els.promptText.value;
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
  promptEditorBaseline = els.promptText.value;   // clean again
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
  promptEditorBaseline = els.promptText ? els.promptText.value : '';
  savePrefs();
  closeSheet('prompt-sheet');
  log('info', 'System prompt reset to default for the current mode.');
}

// Confirm-then-close wrapper used by the close × / backdrop / Escape paths.
// If there are no unsaved edits, closes immediately. Otherwise opens the
// in-app confirm sheet on top of the prompt sheet and closes the prompt sheet
// only if the user confirms discard. Callers should fire-and-forget — the
// dialog stack handles ordering.
async function tryClosePromptSheet() {
  if (!isPromptEditorDirty()) { closeSheet('prompt-sheet'); return; }
  const ok = await showConfirm({
    title: 'Discard edits?',
    message: 'You have unsaved changes to the system prompt. Discard them?',
    confirmLabel: 'Discard',
    confirmStyle: 'danger',
  });
  if (ok) closeSheet('prompt-sheet');
}

// ─── Picture-in-Picture ──────────────────────────────────────────────────────
// PipController lives in js/pip.js and is loaded on first Pop-out click via
// dynamic <script> injection. Keeping the ~750-line class out of the main
// bundle saves cold-start parse cost; the parse moves to first-pop-out, which
// is itself a user-initiated action so a short delay there is acceptable.
let _pipModulePromise = null;
function loadPipModule() {
  if (typeof PipController !== 'undefined') return Promise.resolve();
  if (_pipModulePromise) return _pipModulePromise;
  _pipModulePromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'js/pip.js';
    s.onload = () => resolve();
    s.onerror = () => { _pipModulePromise = null; reject(new Error('Failed to load js/pip.js')); };
    document.head.appendChild(s);
  });
  return _pipModulePromise;
}


async function togglePip() {
  if (state.pip && state.pip.isOpen()) {
    state.pip.close();
    return;
  }
  // First-Pop-out cost: download + parse js/pip.js (~24 KB). Subsequent clicks
  // resolve immediately because loadPipModule caches the promise.
  try {
    await loadPipModule();
  } catch (e) {
    log('error', 'Pop out failed: ' + (e && e.message ? e.message : e));
    return;
  }
  const pip = new PipController({
    onStart: () => startPipeline(),
    onStop:  () => stopPipeline(),
    onPause: () => togglePause(),
    onHush: () => {
      const session = activeSession();
      if (session) state.ttsCoordinator.hush(session);
    },
    onClear: () => clearConversation(),
    // Cycle to the next session in iteration order. Wraps from the end back
    // to the beginning. Hidden when there's <= 1 session (PipController
    // class+visibility is driven by setSessionCount).
    onCycleSession: () => {
      const ids = [...state.sessions.keys()];
      if (ids.length <= 1) return;
      const here = ids.indexOf(state.activeSessionId);
      const next = ids[(here + 1) % ids.length];
      setActiveSession(next);
    },
    // PTT toggle: tap to engage, tap to release. Shares session.pttHeld with
    // the footer Talk button and the optional companion hotkey, so all three
    // inputs stay in sync via setPttEngaged() called from refreshPttButtonState.
    onPttToggle: togglePtt,
    onPrefsChange: (prefs) => {
      // Mirror PIP-side prefs (display mode + font size) into global prefs so
      // they stick across pop-out sessions and page reloads. The PIP class
      // owns the values; the main page only persists them.
      state.pipPrefs = Object.assign({}, state.pipPrefs || {}, prefs);
      savePrefs();
    },
    onForceReset: forceResetActiveSession,
  });
  // Seed PIP-side state BEFORE open() so _setup paints with the user's saved
  // preferences instead of flashing the defaults for one frame.
  const seedPrefs = state.pipPrefs || {};
  if (seedPrefs.displayMode) pip._displayMode = seedPrefs.displayMode;
  if (Number.isInteger(seedPrefs.fontStep)) pip._fontStep = seedPrefs.fontStep;
  try {
    await pip.open();
  } catch (e) {
    log('error', 'Pop out failed: ' + (e && e.message ? e.message : e));
    return;
  }
  state.pip = pip;
  pip.onClose = () => {
    if (state.pip === pip) state.pip = null;
    // Forget the follow target on close so the next pop-out starts on
    // whatever session is currently active rather than a stale memory.
    state.pipFollowingSessionId = null;
  };

  // Prefer the session that spoke most recently; if nothing has spoken yet,
  // fall back to the active tab. Either way, anchor the follow target so
  // chunk callbacks know where to route updates.
  const followSession = (state.lastSpeakingSessionId
    ? state.sessions.get(state.lastSpeakingSessionId)
    : null) || activeSession();
  if (followSession) {
    state.pipFollowingSessionId = followSession.id;
    seedPipFromSession(followSession);
    // refreshSessionDisplay also drives PIP setEffectiveStatus + setRunning,
    // which need the just-opened PIP to be present in state.pip first.
    refreshSessionDisplay(followSession);
  } else {
    state.pipFollowingSessionId = null;
    pip.setStatus('Idle', false);
    pip.setEffectiveStatus('idle');
    pip.setRunning(false, false, true);
    if (els.engineSelect.value === 'translate') {
      pip.setLangs('Auto', translateLangName(els.translateTarget ? els.translateTarget.value : DEFAULT_TRANSLATE_TARGET));
    } else {
      pip.setLangs(langName(els.langSource.value), langName(els.langTarget.value));
    }
  }
  // Seed the cycle-button visibility now that the PIP exists. Subsequent
  // session add/close/restore paths re-call this via refreshPipSessionCount.
  refreshPipSessionCount();
  // Seed the popup's PTT visibility + engaged state from the active session.
  refreshPttButtonState();
  log('info', PipController.isDocPipSupported() ? 'Pop-out window opened.' : 'Pop-out (popup fallback) opened.');
}

// Push the current session count into the PIP so it can hide/show the cycle
// button. Cheap no-op when the PIP isn't open.
function refreshPipSessionCount() {
  if (state.pip) state.pip.setSessionCount(state.sessions.size);
}

// ─── Wire UI ─────────────────────────────────────────────────────────────────
function wireUI() {
  els.btnStart.addEventListener('click', startPipeline);
  els.btnStop.addEventListener('click', stopPipeline);
  els.btnPause.addEventListener('click', togglePause);
  if (els.btnPtt) els.btnPtt.addEventListener('click', togglePtt);
  els.btnHush.addEventListener('click', () => {
    const session = activeSession();
    if (session) state.ttsCoordinator.hush(session);
    log('info', 'Playback silenced');
  });
  // Per-session Clear / Export live in each session header strip and are
  // wired in createSessionDOM. The previous sidebar Actions buttons were
  // removed in favour of those — see CLAUDE.md plan note.
  els.btnSwap.addEventListener('click', () => {
    const a = els.langSource.value;
    els.langSource.value = els.langTarget.value;
    els.langTarget.value = a;
    onSettingsChange();
  });
  els.btnShowKey.addEventListener('click', () => {
    // Read the current visibility BEFORE flipping it, then derive the next
    // state. Earlier code used `willShow = (type === 'password')` which is
    // correct but read confusingly — the variable was named for what becomes
    // true, not what *is* true.
    const wasHidden = els.apiKey.type === 'password';
    const isNowVisible = wasHidden;
    els.apiKey.type = isNowVisible ? 'text' : 'password';
    // aria-pressed reflects whether the key is currently revealed — gives
    // screen-reader users a clear "this toggle is on/off" announcement.
    els.btnShowKey.setAttribute('aria-pressed', isNowVisible ? 'true' : 'false');
  });
  els.modeSelect.addEventListener('change', () => {
    updateUIVisibility();
    onSettingsChange();
  });
  els.engineSelect.addEventListener('change', () => {
    updateUIVisibility();
    onSettingsChange();
  });
  if (els.translateTarget) {
    els.translateTarget.addEventListener('change', onSettingsChange);
  }
  if (els.echoTarget) {
    els.echoTarget.addEventListener('change', onSettingsChange);
  }
  els.vadPreset.addEventListener('change', () => {
    if (els.vadPreset.value !== 'custom') applyVadPreset(els.vadPreset.value);
    updateUIVisibility();
    onSettingsChange();
  });
  for (const el of [els.vadStart, els.vadEnd, els.vadPrefix, els.vadSilence]) {
    el.addEventListener('change', () => {
      els.vadPreset.value = detectVadPreset();
      updateUIVisibility();
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
    // Sync session.config first so the refresh below sees the new pttMode.
    // Inverting these lines hides/shows the Talk button against stale config
    // and the user has to click somewhere else before the visibility settles.
    onSettingsChange();
    updateSpeechModeFields();
  });
  if (els.btnPttKey) {
    els.btnPttKey.addEventListener('click', beginPttCapture);
  }
  if (els.btnPttClear) {
    els.btnPttClear.addEventListener('click', clearPttBinding);
  }
  if (els.pttMode && els.pttMode.el) {
    els.pttMode.addEventListener('change', () => {
      if (!state.pttBinding) return;
      const mode = els.pttMode.value === 'toggle' ? 'toggle' : 'hold';
      state.pttBinding = Object.assign({}, state.pttBinding, { mode });
      savePrefs();
      if (state.pttClient) state.pttClient.setMode(mode);
      log('info', mode === 'toggle'
        ? 'PTT mode: tap to toggle (key press starts/stops the mic).'
        : 'PTT mode: hold to talk (mic engaged while key is held).');
    });
  }
  if (els.pttExclusive) {
    els.pttExclusive.addEventListener('change', () => {
      if (!state.pttBinding) return;
      state.pttBinding = Object.assign({}, state.pttBinding, {
        exclusive: !!els.pttExclusive.checked,
      });
      savePrefs();
      if (state.pttClient && state.pttClient.hasBinding()) {
        // Push the updated binding through; the companion replaces the
        // previous binding atomically when it sees a new bind frame.
        state.pttClient.setBinding(state.pttBinding);
      }
      log('info', els.pttExclusive.checked
        ? 'PTT key capture: exclusive (other apps will not see the key).'
        : 'PTT key capture: shared (key still reaches other apps).');
    });
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
  if (els.btnMicPreview) {
    els.btnMicPreview.addEventListener('click', () => { toggleMicPreview(); });
  }
  if (els.btnDetectDevices) {
    els.btnDetectDevices.addEventListener('click', detectAudioDevices);
  }
  els.audioOutput.addEventListener('change', () => { changeAudioOutput(); });

  if (els.passthroughOutput) {
    els.passthroughOutput.addEventListener('change', (e) => {
      if (!e.target.classList.contains('dev-passthrough')) return;
      const session = activeSession();
      if (session) {
        session.config.passthroughDeviceIds = getPassthroughDeviceIds();
        saveSessions();
        applyPassthrough(session);
      }
      els.passthroughOutput.dataset.preferred = JSON.stringify(getPassthroughDeviceIds());
      // Also persist as the default for newly-created sessions so a
      // freshly-opened tab inherits the user's most recent selection.
      savePrefs();
    });
  }
  els.audioOutput.addEventListener('click', async (e) => {
    const btn = e.target.closest('.device-test');
    if (!btn || !els.audioOutput.contains(btn)) return;
    e.preventDefault();
    btn.disabled = true;
    // Visual busy state: CSS animates the speaker icon while .is-playing is
    // on, so the user has unambiguous feedback that the test is running.
    // Previously the button just went disabled — easy to miss on a Bluetooth
    // sink that takes 200 ms to wake up before producing sound.
    btn.classList.add('is-playing');
    try {
      await testOutputDevice(btn.dataset.deviceId || '');
      const label = btn.getAttribute('aria-label').replace(/^Test\s+/, '');
      log('info', 'Speaker test: ' + label);
    } catch (err) {
      log('warn', 'Speaker test failed: ' + (err && err.message ? err.message : err));
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-playing');
    }
  });
  // API key is global, not per-session — savePrefs only. Listen on 'input' so
  // a paste-then-reload doesn't lose the key (the 'change' event only fires
  // on blur, which is too late for the user who pastes and immediately
  // reloads, switches tabs, or experiences a crash). Debounce 500ms: typing
  // a 40-char key would otherwise fire 40 synchronous localStorage writes.
  const debouncedSavePrefs = (() => {
    let t = 0;
    return () => { clearTimeout(t); t = setTimeout(savePrefs, 500); };
  })();
  els.apiKey.addEventListener('input', debouncedSavePrefs);
  // Flush on blur and before unload so a paste-then-tab-away can't lose it.
  els.apiKey.addEventListener('blur', savePrefs);

  els.btnMenu.addEventListener('click', () => openSheet('sidebar'));
  els.btnLog.addEventListener('click', () => openSheet('log-sheet'));
  if (els.btnForceReset) {
    els.btnForceReset.addEventListener('click', forceResetActiveSession);
  }

  // Dev test hooks in the Log sheet. Both operate on the active session's
  // live GeminiLive client; warn cleanly if there isn't one yet.
  if (els.btnTestGoaway) {
    els.btnTestGoaway.addEventListener('click', () => {
      const session = activeSession();
      if (!session || !session.client) {
        log('warn', 'No active session to test. Start a session first.');
        return;
      }
      session.client.simulateGoAway(60);
    });
  }
  if (els.btnTestWsclose) {
    els.btnTestWsclose.addEventListener('click', () => {
      const session = activeSession();
      if (!session || !session.client) {
        log('warn', 'No active session to test. Start a session first.');
        return;
      }
      session.client.forceCloseWebSocket(4000, 'test force-close');
    });
  }
  if (els.btnLogClear) {
    els.btnLogClear.addEventListener('click', () => {
      els.log.textContent = '';
    });
  }
  if (els.btnLogExport) {
    els.btnLogExport.addEventListener('click', exportLog);
  }
  els.btnEditPrompt.addEventListener('click', openPromptEditor);
  els.btnSavePrompt.addEventListener('click', savePromptEditor);
  els.btnResetPrompt.addEventListener('click', resetPromptEditor);
  els.btnPip.addEventListener('click', togglePip);
  els.btnPipQuick.addEventListener('click', togglePip);

  const okConfirm = $('btn-confirm-ok');
  const cancelConfirm = $('btn-confirm-cancel');
  if (okConfirm) okConfirm.addEventListener('click', () => settleConfirm(true));
  if (cancelConfirm) cancelConfirm.addEventListener('click', () => settleConfirm(false));

  // Simple/Advanced toggle.
  if (els.modeSwitch) {
    els.modeSwitch.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.mode-opt');
      if (!btn) return;
      requestUIModeChange(btn.dataset.uiMode);
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

  // Generic sheet close handlers. Prompt-sheet additionally guards against
  // discarding unsaved edits — see tryClosePromptSheet.
  document.addEventListener('click', (ev) => {
    // Any click outside an open per-session export menu / its trigger
    // dismisses it. Each menu's own click handler stopPropagation()s to
    // avoid this firing on menuitem clicks (we want those to run the export
    // AND close).
    if (anyExportMenuOpen()) {
      const inWrap = ev.target.closest && ev.target.closest('.session-export-wrap');
      if (!inWrap) closeAllExportMenus();
    }
    const tgt = ev.target.closest('[data-close]');
    if (!tgt) return;
    const id = tgt.getAttribute('data-close');
    if (id === 'prompt-sheet') { tryClosePromptSheet(); return; }
    // Confirm dialog: dismissal (× / backdrop) is "cancel". settleConfirm
    // closes the sheet, so don't double-close.
    if (id === 'confirm-sheet') { settleConfirm(false); return; }
    closeSheet(id);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    // Export menu wins over sheets when both are open — it's the most
    // recently-opened transient UI and closing it first matches user intent
    // (and matches how native menus stack with dialogs).
    const openOwner = findOpenExportMenu();
    if (openOwner) {
      ev.preventDefault();
      closeExportMenu(openOwner.headerExportMenu, openOwner.headerExportBtn);
      if (openOwner.headerExportBtn) openOwner.headerExportBtn.focus();
      return;
    }
    // Close only the topmost open modal so layered sheets (e.g. Log opened
    // from inside Settings) close one at a time, matching native dialog UX.
    const id = topmostOpenSheet();
    if (!id) return;
    if (id === 'prompt-sheet') {
      ev.preventDefault();
      tryClosePromptSheet();
      return;
    }
    if (id === 'confirm-sheet') {
      ev.preventDefault();
      settleConfirm(false);
      return;
    }
    ev.preventDefault();
    closeSheet(id);
  });

  window.addEventListener('beforeunload', (ev) => {
    const hasRunning = [...state.sessions.values()].some((session) => session.running);
    // Either a live session OR a dirty prompt is enough to warrant the
    // browser's "leave site?" prompt — both represent unrecoverable state.
    if (hasRunning || isPromptEditorDirty()) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });
  window.addEventListener('pagehide', () => {
    // Flush any pending debounced saveSessions so per-turn updates aren't lost
    // when the user closes the tab between turn boundaries.
    if (_pendingSaveSessionsTimer) saveSessions();
    for (const session of state.sessions.values()) {
      if (session.running) {
        try { session.client && session.client.stop(); } catch (_) {}
        try { session.capture && session.capture.stop(); } catch (_) {}
        try { session.player && session.player.destroy(); } catch (_) {}
      }
    }
    // The global age tick survives across BFCache restore (Safari especially) —
    // a restored page would tick the age display against destroyed sessions.
    // Clear unconditionally; the tick also stops in stopSession but not every
    // running-state path here was guaranteed to flow through it.
    if (_ageTickHandle) { clearInterval(_ageTickHandle); _ageTickHandle = 0; }
    for (const session of state.sessions.values()) {
      try { session.micPassthrough && session.micPassthrough.stop(); } catch (_) {}
    }
    try { state.inputPreview && state.inputPreview.stop(); } catch (_) {}
    if (state.pip) state.pip.close();
  });
  window.addEventListener('focus', () => detectCompanionService());
  if (els.btnOpenCompanion) {
    els.btnOpenCompanion.addEventListener('click', launchCompanion);
  }

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
      if (session.micPassthrough && session.micPassthrough.ctx) ctxs.push(session.micPassthrough.ctx);
    }
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

  // Live-state poller. Active mic/sink ids only change on start/stop/swap,
  // and we call refreshActiveDeviceIndicators at every one of those points.
  // The 2 s tick is the safety net for cases we can't observe (e.g. the OS
  // changing the default device while the user picked "System default", or a
  // BT speaker reconnecting under us). Skipped when nothing is producing or
  // consuming audio — no point polling an idle app.
  setInterval(() => {
    if (!hasActiveAudio()) return;
    refreshActiveDeviceIndicators();
  }, 2000);

  // Watch microphone permission state. The moment it flips to 'granted'
  // (from a previous session, an OS prompt, or another tab), re-enumerate so
  // device names appear without needing a start-stop dance. Permissions API
  // for 'microphone' is widely supported; if missing, devicechange still
  // covers most cases.
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'microphone' }).then((perm) => {
      perm.addEventListener && perm.addEventListener('change', () => {
        if (perm.state === 'granted') {
          refreshAudioInputDevices();
          refreshAudioOutputDevices();
        }
      });
    }).catch(() => { /* not all browsers expose microphone perms — ignore */ });
  }
}

// True when any session is running OR any session's audio passthrough is
// live — i.e. there is at least one device the indicators might need to
// reflect.
function hasActiveAudio() {
  for (const s of state.sessions.values()) {
    if (s.running) return true;
    if (s.micPassthrough && s.micPassthrough.running) return true;
  }
  return false;
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
  // Inline check matches PipController.isDocPipSupported(). Done here without
  // loading js/pip.js because checkSupport runs at boot, before any Pop-out.
  if (!('documentPictureInPicture' in window)) {
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
  if (state.pttBinding) {
    state.pttClient.setBinding(state.pttBinding);
    if (state.pttBinding.mode === 'toggle') state.pttClient.setMode('toggle');
  }
  state.pttClient.onAvailabilityChange = () => updatePttButton();
  restoreSessionsFromStorage();
  // Defer the companion-service probe out of DOMContentLoaded — it does a 600ms
  // HTTP request that blocks time-to-interactive when the companion is offline.
  // The companion-only UI reveals itself when detection lands, same as before.
  const _kickCompanionDetect = () => detectCompanionService();
  if ('requestIdleCallback' in window) {
    requestIdleCallback(_kickCompanionDetect, { timeout: 1000 });
  } else {
    setTimeout(_kickCompanionDetect, 0);
  }
  refreshAudioInputDevices();
  refreshAudioOutputDevices();
  updateSpeechModeFields();
  updatePttButton();
  if (checkSupport()) log('info', 'Ready.');
});
