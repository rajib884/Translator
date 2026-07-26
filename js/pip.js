// ─── Picture-in-Picture ──────────────────────────────────────────────────────
// Loaded on demand by app.js via dynamic <script> injection on first Pop-out
// click. Keeping the ~750-line class out of the main bundle saves cold-start
// parse cost; the cost moves to first-Pop-out, which is fine because Pop-out
// is itself a user-initiated action.

// PIP_DISPLAY_MODES: keys are persisted in prefs; do not rename.
const PIP_DISPLAY_MODES = ['both', 'input', 'output'];
// Font-size steps in rem multipliers. Index 1 ('normal') is the default; the
// step is small enough to be useful on tiny PiP windows without overflowing.
const PIP_FONT_STEPS = [0.78, 1.00, 1.22, 1.50];
const PIP_FONT_LABELS = ['xs', 'sm', 'md', 'lg'];

class PipController {
  constructor({ onStart, onStop, onPause, onHush, onClear,
                onCycleSession, onPttToggle, onPrefsChange,
                onForceReset, onMicChange } = {}) {
    this.win = null;
    this.doc = null;

    // Callbacks back into the main page. PIP runs in a same-origin window, so
    // closures here execute in the main JS context — these wire the PIP's
    // header buttons to the same actions the main controls already trigger.
    // Callers pass them so PipController stays decoupled from main-page
    // globals.
    this.onStart = onStart || (() => {});
    this.onStop = onStop || (() => {});
    this.onPause = onPause || (() => {});
    this.onHush = onHush || (() => {});
    this.onClear = onClear || (() => {});
    // Cycle through running/idle sessions when more than one exists. Hidden
    // when the count is <= 1.
    this.onCycleSession = onCycleSession || (() => {});
    // PTT button — tap to engage, tap to release. Standalone implementation:
    // main page wires this to togglePtt(), which flips session.pttHeld and
    // tells the GeminiLive client via activityStart/activityEnd. The button
    // hides itself when the active session isn't in PTT mode (setPttVisible).
    this.onPttToggle = onPttToggle || (() => {});
    this.onPrefsChange = onPrefsChange || (() => {});
    this.onForceReset = onForceReset || (() => {});
    // Microphone picked in the overlay — main window applies it.
    this.onMicChange = onMicChange || (() => {});
    this.onClose = () => {};

    // Element references — set by _setup, nulled by _cleanup.
    this.statusEl = null;
    this.dotEl = null;
    this.inputLabelEl = null;
    this.outputLabelEl = null;
    this.inputEl = null;
    this.outputEl = null;
    this.inputRowEl = null;
    this.outputRowEl = null;
    // Level meters (mic in / translation out).
    this.micFillEl = null;
    this.outFillEl = null;
    this.outMeterEl = null;
    // Microphone picker (mirrors the main window's dropdown).
    this.micFieldEl = null;
    this.micSelectEl = null;
    this._micOptions = [];
    this._micSelected = '';
    this._micHasChoice = false;
    this._micOptionsSig = null;
    // Header action buttons + settings slide-over.
    this.btnStartStopEl = null;
    this.btnPttEl = null;
    this.btnCycleEl = null;
    this.btnSettingsToggleEl = null;
    this.settingsPanelEl = null;
    this.settingsBackdropEl = null;
    this.btnPauseEl = null;
    this.btnHushEl = null;
    this.btnClearEl = null;
    this.displaySegEl = null;
    this.fontDecEl = null;
    this.fontIncEl = null;
    this.fontLabelEl = null;

    // Persisted view state. setDisplayMode / setFontStep update these and
    // fire onPrefsChange so the main page can save into prefs.
    this._displayMode = 'both';
    this._fontStep = 1;
    this._settingsOpen = false;
    this._sessionCount = 1;
    this._pttHeld = false;

    // Mirror of upstream state — used both to seed _setup on (re)open and to
    // update the visible DOM whenever the main page calls a setter.
    this._currentInput = '';
    this._currentOutput = '';
    this._currentStatus = 'Idle';
    this._currentLive = false;
    this._currentEffStatus = 'idle';
    this._currentRunning = false;
    this._currentPaused = false;
    this._currentIsAudio = true;
    this._inLang = '';
    this._outLang = '';
  }

  static isDocPipSupported() {
    return 'documentPictureInPicture' in window;
  }

  isOpen() { return !!(this.win && !this.win.closed); }

  async open() {
    if (this.isOpen()) { try { this.win.focus(); } catch (_) {} return; }
    if (PipController.isDocPipSupported()) {
      this.win = await window.documentPictureInPicture.requestWindow({
        // Compact default; the new single-row header lets us reclaim the
        // ~44 px the old tab bar used. User can resize, container queries
        // collapse buttons as it shrinks.
        width: 380, height: 280,
      });
    } else {
      this.win = window.open('', 'live-translator-pip',
        'width=380,height=280,resizable=yes,scrollbars=yes,noopener=no');
      if (!this.win) throw new Error('Popup blocked. Allow popups for this site.');
    }
    this._setup();
    this.win.addEventListener('pagehide', () => this._cleanup());
    if (this.win.document) this.win.document.title = 'Live Translator';
  }

  _setup() {
    const doc = this.win.document;
    this.doc = doc;
    doc.documentElement.lang = 'en';
    // Without this, mobile browsers fall back to a 980px virtual viewport and
    // render the PiP content shrunk to a fraction of the real window width.
    const viewport = doc.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    doc.head.appendChild(viewport);
    // Container queries (below) need a known container. Body is the natural
    // root and `inline-size` lets buttons hide based on PIP width without JS.
    doc.documentElement.style.height = '100%';
    // Pull the palette from the main document's CSS variables so the PiP
    // window can never drift from the app theme. Falls back to literal
    // hex values when a custom property is missing (host page didn't ship
    // them, or the PiP was opened from a barebones context).
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
    const palette = {
      bg0:    v('--bg-0',      '#0b0d12'),
      bg1:    v('--bg-1',      '#11141b'),
      bg2:    v('--bg-2',      '#161a23'),
      bg3:    v('--bg-3',      '#1d2230'),
      fg0:    v('--fg-0',      '#e8ecf3'),
      fg1:    v('--fg-1',      '#aab2c4'),
      fg2:    v('--fg-2',      '#8a93a8'),
      accent: v('--accent',    '#7c9cff'),
      accent2:v('--accent-2',  '#a78bfa'),
      warn:   v('--warn',      '#f0b429'),
      bad:    v('--bad',       '#ef4444'),
      good:   v('--good',      '#34d399'),
      line:   v('--line-soft', '#1c2230'),
    };
    const style = doc.createElement('style');
    style.textContent = `
      html, body {
        margin: 0; height: 100%;
        background: ${palette.bg0}; color: ${palette.fg0};
        font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
        display: flex; flex-direction: column; overflow: hidden;
        /* Container query target — every responsive hide rule below keys off
           the body's inline-size, so the PIP collapses gracefully as the user
           drags it down to a tiny sliver. */
        container: pip / inline-size;
        --pip-scale: 1;
        transition: background-color 0.25s ease, color 0.25s ease;
      }

      /* ─── Header (single compact action row) ─── */
      header {
        display: flex; align-items: center; gap: 4px;
        padding: 4px 6px;
        border-bottom: 1px solid ${palette.line};
        background: ${palette.bg1}; flex: 0 0 auto;
        font-size: 12px;
        min-height: 0;
      }
      /* The pill is the priority element — never hides. Its label collapses
         to just the dot when space gets very tight. */
      .pip-pill {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 3px 8px; border-radius: 999px;
        font-size: 10.5px; font-weight: 600;
        background: ${palette.bg3};
        flex-shrink: 0;
      }
      .pip-dot { width: 6px; height: 6px; border-radius: 50%; background: ${palette.fg2}; }
      .pip-dot.live { background: ${palette.accent}; animation: pip-pulse 0.8s infinite; }
      @keyframes pip-pulse { 0%,100%{ opacity:1; } 50%{ opacity:0.4; } }

      /* Brand sits at the far right, takes leftover space, and is the FIRST
         thing to disappear when the user shrinks the PIP. */
      .pip-brand-wrap {
        flex: 1 1 0; min-width: 0;
        display: flex; align-items: center; justify-content: flex-end; gap: 4px;
        color: ${palette.fg2}; font-size: 11px;
        overflow: hidden;
      }
      .pip-brand-text {
        font-weight: 600;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .pip-brand-globe { flex-shrink: 0; font-size: 11px; opacity: 0.6; }

      /* Header icon buttons. Square 28px so the whole header stays compact;
         touch targets still get the 44px effective via padding+focus ring. */
      .pip-iconbtn {
        flex-shrink: 0;
        width: 28px; height: 28px; padding: 0;
        background: transparent; color: ${palette.fg1};
        border: 1px solid transparent;
        border-radius: 6px;
        font: inherit; font-size: 14px; line-height: 1;
        cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .pip-iconbtn:hover:not(:disabled) { background: ${palette.bg3}; color: ${palette.fg0}; }
      .pip-iconbtn:disabled { opacity: 0.35; cursor: not-allowed; }
      .pip-iconbtn:focus-visible { outline: 2px solid ${palette.accent}; outline-offset: -1px; }
      /* Start/Stop tint — green when stopped (ready to start), red when running. */
      .pip-iconbtn.pip-startstop[data-running="false"] { color: ${palette.good}; }
      .pip-iconbtn.pip-startstop[data-running="true"]  { color: ${palette.bad}; }
      .pip-iconbtn.pip-ptt[data-held="true"] {
        background: ${palette.accent}; color: #0b0d12;
      }
      .pip-iconbtn.pip-settings-toggle[data-open="true"] {
        background: ${palette.bg3}; color: ${palette.accent};
      }
      /* Force-reconnect: warn tint hints at destructive action (loses model context). */
      .pip-iconbtn.pip-reset { color: ${palette.warn}; }
      .pip-iconbtn.pip-reset:hover:not(:disabled) {
        background: ${palette.bg3}; color: ${palette.warn};
      }
      .pip-iconbtn.is-hidden { display: none; }

      /* ─── Container-query responsive hiding ─────────────────────────
         Priority of disappearance as the PIP gets narrower:
           > 360px   everything visible
           ≤ 360px   brand text drops, only globe stays
           ≤ 310px   brand wrap fully drops
           ≤ 270px   pill label drops (pill becomes just the dot)
           ≤ 240px   PTT button drops
           ≤ 225px   force-reconnect button drops
           ≤ 210px   cycle button drops
         Settings cog + Start/Stop always remain — they're the essentials. */
      @container pip (max-width: 360px) {
        .pip-brand-text { display: none; }
      }
      @container pip (max-width: 310px) {
        .pip-brand-wrap { display: none; }
      }
      @container pip (max-width: 270px) {
        .pip-pill-label { display: none; }
        .pip-pill { padding: 5px 6px; }
      }
      @container pip (max-width: 240px) {
        .pip-iconbtn.pip-ptt { display: none; }
      }
      @container pip (max-width: 225px) {
        .pip-iconbtn.pip-reset { display: none; }
      }
      @container pip (max-width: 210px) {
        .pip-iconbtn.pip-cycle { display: none; }
      }

      /* ─── Level meters ───
         Mirrors the main window's tab-chip meters: mic on top, translation
         output below. A glance at the overlay then answers "is it hearing me
         / is it speaking" without parsing the status pill. Kept to 3px so the
         strip costs almost nothing at the tiny sizes the PIP gets dragged to. */
      .pip-meters {
        display: flex; flex-direction: column; gap: 2px;
        padding: 4px 6px;
        background: ${palette.bg1};
        border-bottom: 1px solid ${palette.line};
        flex: 0 0 auto;
      }
      .pip-meter {
        position: relative; height: 3px;
        background: ${palette.bg3};
        border-radius: 2px; overflow: hidden;
      }
      .pip-meter.is-hidden { display: none; }
      .pip-meter-fill {
        height: 100%; width: 0%;
        border-radius: 2px; will-change: width;
        transition: background-color 0.18s ease, opacity 0.18s ease;
      }
      .pip-meter.mic .pip-meter-fill { background: ${palette.accent}; }
      .pip-meter.out .pip-meter-fill { background: ${palette.accent2}; }
      /* Stopped or paused: the model is not receiving audio. Grey the fill so a
         live mic level can't be mistaken for "you're being heard" — same
         reasoning as the main window's per-status meter dimming. */
      body.pip-meters-muted .pip-meter-fill {
        background: ${palette.fg2} !important; opacity: 0.55;
      }
      /* The strip is the first thing to go when the window gets very short on
         width — status and transcript matter more than the levels. */
      @container pip (max-width: 200px) {
        .pip-meters { display: none; }
      }

      /* ─── Transcript ─── */
      main.pip-transcript {
        padding: 12px 14px; overflow-y: auto;
        display: flex; flex-direction: column; gap: 10px;
        flex: 1; min-height: 0;
      }
      .pip-row { transition: opacity 0.2s ease; }
      .pip-row.is-hidden { display: none; }
      .pip-label {
        font-size: calc(10px * var(--pip-scale)); font-weight: 700;
        letter-spacing: 0.6px; text-transform: uppercase;
        color: ${palette.fg2}; margin-bottom: 4px;
      }
      .pip-input-lab { color: ${palette.accent}; }
      .pip-output-lab { color: ${palette.accent2}; }
      .pip-input  { font-size: calc(15px * var(--pip-scale)); color: ${palette.fg1};
                    line-height: 1.45; word-wrap: break-word; }
      .pip-output { font-size: calc(20px * var(--pip-scale)); font-weight: 500;
                    line-height: 1.4; word-wrap: break-word; }
      .pip-empty { color: ${palette.fg2}; font-style: italic; }

      /* ─── Settings slide-over panel ─────────────────────────────────
         Sits on top of the transcript, slides in from the right. Backdrop
         is interactive (closes the panel on click) but very subtle so the
         underlying transcript stays readable. */
      .pip-settings-backdrop {
        position: absolute; inset: 0;
        background: rgba(0, 0, 0, 0.35);
        opacity: 0; pointer-events: none;
        transition: opacity 0.18s ease;
        z-index: 5;
      }
      .pip-settings-backdrop.is-open { opacity: 1; pointer-events: auto; }
      .pip-settings-panel {
        position: absolute; top: 0; right: 0; bottom: 0;
        width: min(280px, 92vw);
        background: ${palette.bg1};
        border-left: 1px solid ${palette.line};
        transform: translateX(100%);
        transition: transform 0.22s ease-out;
        z-index: 6;
        display: flex; flex-direction: column;
        overflow: hidden;
      }
      .pip-settings-panel.is-open { transform: translateX(0); }
      .pip-settings-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 10px 8px 14px;
        border-bottom: 1px solid ${palette.line};
        flex: 0 0 auto;
      }
      .pip-settings-title {
        font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
        text-transform: uppercase; color: ${palette.fg1};
      }
      .pip-settings-body {
        padding: 12px 14px;
        display: flex; flex-direction: column; gap: 14px;
        overflow-y: auto; flex: 1; min-height: 0;
      }
      .pip-field { display: flex; flex-direction: column; gap: 6px; }
      .pip-field-label {
        font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em;
        text-transform: uppercase; color: ${palette.fg2};
      }
      .pip-row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
      .pip-btn {
        background: ${palette.bg3}; color: ${palette.fg0};
        border: 1px solid ${palette.line}; border-radius: 7px;
        padding: 7px 10px; font: inherit; font-size: 12px; font-weight: 600;
        cursor: pointer; min-height: 34px;
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      }
      .pip-btn:hover:not(:disabled) { background: ${palette.bg2}; }
      .pip-btn:disabled { opacity: 0.45; cursor: not-allowed; }
      .pip-btn.warn   { background: ${palette.warn}; color: #0b0d12; border-color: transparent; }
      .pip-btn.danger { background: ${palette.bad};  color: #fff;    border-color: transparent; }
      .pip-btn.flex { flex: 1 1 0; }
      .pip-btn:focus-visible { outline: 2px solid ${palette.accent}; outline-offset: 2px; }
      .pip-field.is-hidden { display: none; }
      .pip-select {
        width: 100%;
        background: ${palette.bg3}; color: ${palette.fg0};
        border: 1px solid ${palette.line}; border-radius: 7px;
        padding: 7px 8px; font: inherit; font-size: 12px;
        min-height: 34px; cursor: pointer;
      }
      .pip-select:focus-visible { outline: 2px solid ${palette.accent}; outline-offset: 2px; }

      .pip-seg {
        display: flex; gap: 0;
        background: ${palette.bg3}; border: 1px solid ${palette.line};
        border-radius: 7px; padding: 2px; overflow: hidden;
      }
      .pip-seg-opt {
        flex: 1; background: transparent; color: ${palette.fg1};
        border: 0; border-radius: 5px; padding: 6px 6px;
        font: inherit; font-size: 11.5px; font-weight: 600;
        cursor: pointer; min-height: 28px;
      }
      .pip-seg-opt.is-active { background: ${palette.accent}; color: #0b0d12; }
      .pip-seg-opt:focus-visible { outline: 2px solid ${palette.accent}; outline-offset: -1px; }
      .pip-font-row { display: flex; align-items: center; gap: 6px; }
      .pip-font-row .pip-btn { padding: 6px 10px; min-width: 40px; }
      .pip-font-label {
        flex: 1; text-align: center; font-size: 11px;
        color: ${palette.fg2}; text-transform: uppercase; letter-spacing: 0.06em;
      }

      /* The transcript area needs to be the positioning context for the
         absolutely-positioned settings panel + backdrop so the slide-over
         covers only the body, not the header. */
      .pip-body-wrap {
        position: relative;
        flex: 1; min-height: 0; display: flex; flex-direction: column;
      }

      /* State-driven background tints + a 4 px stripe along the top of the
         body. The stripe is a *secondary* signal that doesn't depend on
         hue discrimination — width and presence are enough to identify the
         state even with significant colour-vision deficiency. Mix
         percentages are deliberately high (25 – 50 %) so neighbouring
         states are clearly distinct on the background alone.
         The states are also placed on a lightness ladder (idle is darkest,
         translating + error are brightest) so even a desaturated view shows
         meaningful contrast. */
      body {
        --pip-state-accent: transparent;
        --pip-state-mix: 0%;
        background: ${palette.bg0};
      }
      body::before {
        content: '';
        position: fixed; top: 0; left: 0; right: 0;
        height: 4px;
        background: var(--pip-state-accent);
        z-index: 100;
        transition: background 0.25s ease;
        pointer-events: none;
      }
      body:not(.pip-state-idle) {
        background: color-mix(in srgb, var(--pip-state-accent) var(--pip-state-mix), ${palette.bg0});
      }

      body.pip-state-idle         { --pip-state-accent: ${palette.line};   --pip-state-mix: 0%; }
      /* Cool / cold side: ready, queued, waiting — all blue-ish + dim. */
      body.pip-state-waiting      { --pip-state-accent: #38bdf8;           --pip-state-mix: 22%; } /* cyan, dim */
      body.pip-state-queued       { --pip-state-accent: ${palette.accent2}; --pip-state-mix: 32%; } /* violet */
      body.pip-state-connected    { --pip-state-accent: ${palette.good};   --pip-state-mix: 28%; } /* green */
      /* Transitional warm: connecting, paused. */
      body.pip-state-paused       { --pip-state-accent: #94a3b8;           --pip-state-mix: 28%; } /* slate */
      body.pip-state-connecting   { --pip-state-accent: ${palette.warn};   --pip-state-mix: 30%; } /* amber */
      /* High-attention: speaking + reconnecting + error are the brightest. */
      body.pip-state-switching    { --pip-state-accent: ${palette.warn};   --pip-state-mix: 38%; } /* amber — server signaled imminent renewal */
      body.pip-state-reconnecting { --pip-state-accent: #fb923c;           --pip-state-mix: 45%; } /* orange */
      body.pip-state-translating  { --pip-state-accent: ${palette.accent}; --pip-state-mix: 50%; } /* bright blue */
      body.pip-state-error        { --pip-state-accent: ${palette.bad};    --pip-state-mix: 55%; } /* red */
    `;
    doc.head.appendChild(style);

    // DOM layout. Header order = priority left to right (pill = highest, then
    // start/stop, PTT, cycle, settings cog). Brand wrap at the far right
    // claims leftover space and is the first thing the container query hides.
    doc.body.innerHTML = `
      <header>
        <span class="pip-pill" title="Session status">
          <span class="pip-dot" id="pipdot"></span>
          <span class="pip-pill-label" id="pipstatus">Idle</span>
        </span>
        <button class="pip-iconbtn pip-startstop" id="pipBtnStartStop"
                type="button" data-running="false"
                title="Start" aria-label="Start">▶</button>
        <button class="pip-iconbtn pip-ptt is-hidden" id="pipBtnPtt"
                type="button" data-held="false" aria-pressed="false"
                title="Push to talk — tap to start, tap to stop" aria-label="Push to talk">🎙</button>
        <button class="pip-iconbtn pip-cycle is-hidden" id="pipBtnCycle"
                type="button"
                title="Switch session" aria-label="Switch session">⇆</button>
        <button class="pip-iconbtn pip-reset" id="pipBtnForceReset"
                type="button"
                title="Force reconnect: drop the WebSocket and clear the resume handle. Starts a fresh model context."
                aria-label="Force reconnect">↻</button>
        <button class="pip-iconbtn pip-settings-toggle" id="pipBtnSettingsToggle"
                type="button" data-open="false"
                title="Settings" aria-label="Settings"
                aria-expanded="false" aria-controls="pipSettingsPanel">⚙</button>
        <span class="pip-brand-wrap">
          <span class="pip-brand-globe" aria-hidden="true">🌐</span>
          <span class="pip-brand-text">Translator</span>
        </span>
      </header>

      <div class="pip-meters" id="pipMeters">
        <div class="pip-meter mic"><div class="pip-meter-fill" id="pipMicFill"></div></div>
        <div class="pip-meter out" id="pipOutMeter"><div class="pip-meter-fill" id="pipOutFill"></div></div>
      </div>

      <div class="pip-body-wrap">
        <main class="pip-transcript">
          <div class="pip-row" id="pipInputRow">
            <div class="pip-label pip-input-lab" id="pipinlab">You</div>
            <div class="pip-input pip-empty" id="pipin">—</div>
          </div>
          <div class="pip-row" id="pipOutputRow">
            <div class="pip-label pip-output-lab" id="pipoutlab">Translation</div>
            <div class="pip-output pip-empty" id="pipout">—</div>
          </div>
        </main>

        <div class="pip-settings-backdrop" id="pipSettingsBackdrop" aria-hidden="true"></div>
        <aside class="pip-settings-panel" id="pipSettingsPanel"
               role="dialog" aria-modal="false" aria-labelledby="pipSettingsTitle" tabindex="-1">
          <div class="pip-settings-head">
            <span class="pip-settings-title" id="pipSettingsTitle">Settings</span>
            <button class="pip-iconbtn" id="pipBtnSettingsClose"
                    type="button" title="Close settings" aria-label="Close settings">×</button>
          </div>
          <div class="pip-settings-body">
            <!-- DEPRECATED: mic pause + silence row retired. -->
            <!--
            <div class="pip-field">
              <div class="pip-field-label">Mic</div>
              <div class="pip-row-actions">
                <button class="pip-btn flex" id="pipBtnPause" type="button" disabled>Pause</button>
                <button class="pip-btn warn flex" id="pipBtnHush" type="button" disabled>Silence</button>
              </div>
            </div>
            -->

            <!-- Hidden until the main window reports 2+ labelled inputs; with a
                 single mic there is no choice to offer. -->
            <div class="pip-field is-hidden" id="pipMicField">
              <div class="pip-field-label">Microphone</div>
              <select class="pip-select" id="pipMicSelect" aria-label="Microphone"></select>
            </div>

            <div class="pip-field">
              <div class="pip-field-label">Show</div>
              <div class="pip-seg" id="pipDisplaySeg" role="radiogroup" aria-label="Show">
                <button class="pip-seg-opt" data-mode="both"   role="radio" aria-checked="true"  type="button">Both</button>
                <button class="pip-seg-opt" data-mode="input"  role="radio" aria-checked="false" type="button">Source</button>
                <button class="pip-seg-opt" data-mode="output" role="radio" aria-checked="false" type="button">Target</button>
              </div>
            </div>

            <div class="pip-field">
              <div class="pip-field-label">Text size</div>
              <div class="pip-font-row">
                <button class="pip-btn" id="pipFontDec" type="button" aria-label="Smaller text">A−</button>
                <span class="pip-font-label" id="pipFontLabel">sm</span>
                <button class="pip-btn" id="pipFontInc" type="button" aria-label="Larger text">A+</button>
              </div>
            </div>

            <div class="pip-field">
              <div class="pip-field-label">Transcript</div>
              <button class="pip-btn flex" id="pipBtnClear" type="button">Clear</button>
            </div>
          </div>
        </aside>
      </div>
    `;

    this.statusEl = doc.getElementById('pipstatus');
    this.dotEl = doc.getElementById('pipdot');
    this.inputLabelEl = doc.getElementById('pipinlab');
    this.outputLabelEl = doc.getElementById('pipoutlab');
    this.inputEl = doc.getElementById('pipin');
    this.outputEl = doc.getElementById('pipout');
    this.inputRowEl = doc.getElementById('pipInputRow');
    this.outputRowEl = doc.getElementById('pipOutputRow');
    this.micFillEl = doc.getElementById('pipMicFill');
    this.outFillEl = doc.getElementById('pipOutFill');
    this.outMeterEl = doc.getElementById('pipOutMeter');
    this.micFieldEl = doc.getElementById('pipMicField');
    this.micSelectEl = doc.getElementById('pipMicSelect');
    // Fresh document, so the previous signature no longer describes it.
    this._micOptionsSig = null;

    this.btnStartStopEl = doc.getElementById('pipBtnStartStop');
    this.btnPttEl = doc.getElementById('pipBtnPtt');
    this.btnCycleEl = doc.getElementById('pipBtnCycle');
    this.btnSettingsToggleEl = doc.getElementById('pipBtnSettingsToggle');
    this.settingsPanelEl = doc.getElementById('pipSettingsPanel');
    this.settingsBackdropEl = doc.getElementById('pipSettingsBackdrop');
    const btnSettingsCloseEl = doc.getElementById('pipBtnSettingsClose');
    // DEPRECATED: mic pause + silence buttons retired (HTML commented above).
    // Refs left assignable so other call sites' if-guards still no-op cleanly.
    this.btnPauseEl = null; // doc.getElementById('pipBtnPause');
    this.btnHushEl = null;  // doc.getElementById('pipBtnHush');
    this.btnClearEl = doc.getElementById('pipBtnClear');
    this.btnForceResetEl = doc.getElementById('pipBtnForceReset');
    this.displaySegEl = doc.getElementById('pipDisplaySeg');
    this.fontDecEl = doc.getElementById('pipFontDec');
    this.fontIncEl = doc.getElementById('pipFontInc');
    this.fontLabelEl = doc.getElementById('pipFontLabel');

    // ─── Header actions ────────────────────────────────────────────────
    this.btnStartStopEl.addEventListener('click', () => {
      if (this._currentRunning) this.onStop();
      else this.onStart();
    });

    // PTT: tap to engage, tap to release. The main page owns the engaged
    // state (session.pttHeld) and writes it back via setPttEngaged() — so we
    // never flip the visual on click; we just forward the toggle intent.
    this.btnPttEl.addEventListener('click', () => this.onPttToggle());

    this.btnCycleEl.addEventListener('click', () => this.onCycleSession());
    this.btnForceResetEl.addEventListener('click', () => this.onForceReset());
    this.btnSettingsToggleEl.addEventListener('click', () => this.toggleSettingsPanel());
    btnSettingsCloseEl.addEventListener('click', () => this.closeSettingsPanel());
    this.settingsBackdropEl.addEventListener('click', () => this.closeSettingsPanel());

    // ─── Settings-panel actions ────────────────────────────────────────
    // DEPRECATED: mic pause + silence buttons retired.
    // this.btnPauseEl.addEventListener('click', () => this.onPause());
    // this.btnHushEl.addEventListener('click', () => this.onHush());
    this.btnClearEl.addEventListener('click', () => this.onClear());

    this.displaySegEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.pip-seg-opt');
      if (!btn) return;
      const mode = btn.dataset.mode;
      if (!PIP_DISPLAY_MODES.includes(mode)) return;
      this.setDisplayMode(mode, /* persist */ true);
    });

    this.fontDecEl.addEventListener('click', () => this.setFontStep(this._fontStep - 1, true));
    this.fontIncEl.addEventListener('click', () => this.setFontStep(this._fontStep + 1, true));

    // The main window owns the device switch (it has to restart capture on a
    // running session), so just report the pick and let it drive the change —
    // the resulting refresh calls setMicOptions back with the new selection.
    this.micSelectEl.addEventListener('change', () => {
      this._micSelected = this.micSelectEl.value;
      this.onMicChange(this._micSelected);
    });

    // ESC closes the settings panel if it's open.
    doc.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this._settingsOpen) {
        ev.preventDefault();
        this.closeSettingsPanel();
      }
    });

    // Replay current state into the freshly-built DOM.
    this.setStatus(this._currentStatus, this._currentLive);
    this.setEffectiveStatus(this._currentEffStatus);
    this.setRunning(this._currentRunning, this._currentPaused, this._currentIsAudio);
    if (this._inLang) this.setLangs(this._inLang, this._outLang);
    this.setInput(this._currentInput);
    this.setOutput(this._currentOutput);
    this.setDisplayMode(this._displayMode, /* persist */ false);
    this.setFontStep(this._fontStep, /* persist */ false);
    this.setSessionCount(this._sessionCount);
    this.setMicOptions(this._micOptions, this._micSelected, this._micHasChoice);
  }

  // Settings slide-over open/close.
  openSettingsPanel() {
    if (!this.settingsPanelEl) return;
    this._settingsOpen = true;
    this.settingsPanelEl.classList.add('is-open');
    this.settingsBackdropEl.classList.add('is-open');
    this.btnSettingsToggleEl.dataset.open = 'true';
    this.btnSettingsToggleEl.setAttribute('aria-expanded', 'true');
    try { this.settingsPanelEl.focus({ preventScroll: true }); } catch (_) {}
  }
  closeSettingsPanel() {
    if (!this.settingsPanelEl) return;
    this._settingsOpen = false;
    this.settingsPanelEl.classList.remove('is-open');
    this.settingsBackdropEl.classList.remove('is-open');
    this.btnSettingsToggleEl.dataset.open = 'false';
    this.btnSettingsToggleEl.setAttribute('aria-expanded', 'false');
    try { this.btnSettingsToggleEl.focus({ preventScroll: true }); } catch (_) {}
  }
  toggleSettingsPanel() {
    if (this._settingsOpen) this.closeSettingsPanel();
    else this.openSettingsPanel();
  }

  // Shown only when more than one session exists in the main page. Called
  // from refreshAddSessionButton / closeSession / restoreSessionsFromStorage.
  setSessionCount(n) {
    this._sessionCount = n | 0;
    if (this.btnCycleEl) {
      this.btnCycleEl.classList.toggle('is-hidden', this._sessionCount <= 1);
    }
  }

  // PTT button visibility — driven by whether the active session is in PTT
  // mode. Hidden buttons stay in the DOM (state survives toggles) but don't
  // interrupt the header rhythm or steal a focus stop.
  setPttVisible(visible) {
    if (!this.btnPttEl) return;
    this.btnPttEl.classList.toggle('is-hidden', !visible);
  }

  // PTT engaged state — written by the main page, never by the click handler.
  // Keeping the engaged visual in lockstep with session.pttHeld means the
  // footer Talk button, the popup Talk button, and an optional companion
  // hotkey can all share one source of truth.
  setPttEngaged(engaged) {
    this._pttHeld = !!engaged;
    if (!this.btnPttEl) return;
    this.btnPttEl.dataset.held = engaged ? 'true' : 'false';
    this.btnPttEl.setAttribute('aria-pressed', engaged ? 'true' : 'false');
    this.btnPttEl.setAttribute('aria-label', engaged ? 'Stop talking' : 'Push to talk');
  }

  // Greyed-out state — driven from the main page's canEngage check (running,
  // not paused, etc.). Kept separate from setPttEngaged so the engaged visual
  // and the click-availability can change independently.
  setPttDisabled(disabled) {
    if (!this.btnPttEl) return;
    this.btnPttEl.disabled = !!disabled;
    this.btnPttEl.title = this._pttHeld ? 'Tap to stop' : 'Push to talk — tap to start';
  }

  setDisplayMode(mode, persist) {
    if (!PIP_DISPLAY_MODES.includes(mode)) mode = 'both';
    this._displayMode = mode;
    if (this.displaySegEl) {
      for (const btn of this.displaySegEl.querySelectorAll('.pip-seg-opt')) {
        const isThis = btn.dataset.mode === mode;
        btn.classList.toggle('is-active', isThis);
        btn.setAttribute('aria-checked', isThis ? 'true' : 'false');
      }
    }
    const showInput  = mode === 'both' || mode === 'input';
    const showOutput = mode === 'both' || mode === 'output';
    if (this.inputRowEl)  this.inputRowEl.classList.toggle('is-hidden', !showInput);
    if (this.outputRowEl) this.outputRowEl.classList.toggle('is-hidden', !showOutput);
    if (persist) this.onPrefsChange(this._exportPrefs());
  }

  setFontStep(step, persist) {
    const max = PIP_FONT_STEPS.length - 1;
    step = Math.max(0, Math.min(max, step | 0));
    this._fontStep = step;
    if (this.doc && this.doc.body) {
      this.doc.body.style.setProperty('--pip-scale', String(PIP_FONT_STEPS[step]));
    }
    if (this.fontLabelEl) this.fontLabelEl.textContent = PIP_FONT_LABELS[step];
    if (this.fontDecEl) this.fontDecEl.disabled = step <= 0;
    if (this.fontIncEl) this.fontIncEl.disabled = step >= max;
    if (persist) this.onPrefsChange(this._exportPrefs());
  }

  _exportPrefs() {
    return { displayMode: this._displayMode, fontStep: this._fontStep };
  }

  // Called from refreshSessionDisplay so the bg colour tracks the same
  // effectiveStatus the chip + topbar pill use.
  setEffectiveStatus(eff) {
    this._currentEffStatus = eff || 'idle';
    if (!this.doc || !this.doc.body) return;
    // Drop any previously-set pip-state-* class before applying the new one.
    const body = this.doc.body;
    for (const cls of Array.from(body.classList)) {
      if (cls.startsWith('pip-state-')) body.classList.remove(cls);
    }
    body.classList.add('pip-state-' + this._currentEffStatus);
  }

  // Drives the Start/Stop icon button in the header plus the Pause/Hush
  // buttons in the slide-over settings panel. Running + paused passed in
  // explicitly so the PIP doesn't need to interpret session status strings.
  setRunning(running, paused, isAudio) {
    this._currentRunning = !!running;
    this._currentPaused = !!paused;
    this._currentIsAudio = isAudio === undefined ? true : !!isAudio;
    if (this.btnStartStopEl) {
      this.btnStartStopEl.dataset.running = this._currentRunning ? 'true' : 'false';
      this.btnStartStopEl.textContent = this._currentRunning ? '■' : '▶';
      this.btnStartStopEl.title = this._currentRunning ? 'Stop' : 'Start';
      this.btnStartStopEl.setAttribute('aria-label', this._currentRunning ? 'Stop' : 'Start');
    }
    if (this.btnPauseEl) {
      this.btnPauseEl.disabled = !this._currentRunning;
      this.btnPauseEl.textContent = this._currentPaused ? 'Resume' : 'Pause';
    }
    if (this.btnHushEl) {
      this.btnHushEl.disabled = !this._currentRunning || !this._currentIsAudio;
    }
    // If a session stops while PTT is held, release it so the visual state
    // doesn't lie about what's happening.
    if (!this._currentRunning && this._pttHeld && this.btnPttEl) {
      this._pttHeld = false;
      this.btnPttEl.dataset.held = 'false';
    }
    // Meter chrome rides on the same state, and _setup replays setRunning with
    // the cached values — so driving it here is also what restores the meters
    // correctly when the user closes and reopens the overlay.
    this.setMetersAudio(this._currentIsAudio);
    this.setMetersMuted(!this._currentRunning || this._currentPaused);
    if (!this._currentRunning) { this.setMicLevel(0); this.setOutLevel(0); }
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

  // Levels are 0..1 peaks, pushed from the main window at capture/playback
  // cadence. Writing width directly (rather than transitioning it) keeps the
  // bar responsive — a transition here would smear the peaks into mush.
  // Mirror of the main window's microphone dropdown. `hasChoice` is decided
  // there (2+ concrete, labelled inputs) so both pickers appear and disappear
  // on exactly the same condition. Re-applied on every device refresh, so the
  // list stays correct as devices come and go.
  setMicOptions(options, selectedValue, hasChoice) {
    this._micOptions = options || [];
    this._micSelected = selectedValue || '';
    this._micHasChoice = !!hasChoice;
    if (!this.micSelectEl || !this.micFieldEl) return;
    this.micFieldEl.classList.toggle('is-hidden', !this._micHasChoice);
    // Rebuilding drops any open dropdown, so skip it when nothing changed.
    const sig = this._micOptions.map((o) => o.value + ' ' + o.label).join('');
    if (sig !== this._micOptionsSig) {
      this._micOptionsSig = sig;
      this.micSelectEl.innerHTML = '';
      for (const o of this._micOptions) {
        const opt = this.doc.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        this.micSelectEl.appendChild(opt);
      }
    }
    this.micSelectEl.value = this._micSelected;
  }

  setMicLevel(level) { this._paintMeter(this.micFillEl, level); }
  setOutLevel(level) { this._paintMeter(this.outFillEl, level); }

  _paintMeter(el, level) {
    if (!el) return;
    const pct = Math.max(0, Math.min(100, (Number(level) || 0) * 100));
    el.style.width = pct.toFixed(1) + '%';
  }

  // Text/transcribe sessions never speak, so the output bar would sit dead at
  // zero — drop it and leave the mic bar on its own, matching how the main
  // window's chip meters behave for the same modes.
  setMetersAudio(isAudio) {
    if (this.outMeterEl) this.outMeterEl.classList.toggle('is-hidden', !isAudio);
  }

  // Grey the fills whenever the model isn't actually receiving audio.
  setMetersMuted(muted) {
    if (this.doc) this.doc.body.classList.toggle('pip-meters-muted', !!muted);
  }

  _cleanup() {
    this.win = null;
    this.doc = null;
    this.statusEl = this.dotEl = null;
    this.inputEl = this.outputEl = null;
    this.micFillEl = this.outFillEl = this.outMeterEl = null;
    this.micFieldEl = this.micSelectEl = null;
    this._micOptionsSig = null;
    this.inputLabelEl = this.outputLabelEl = null;
    this.inputRowEl = this.outputRowEl = null;
    this.btnStartStopEl = null;
    this.btnPttEl = null;
    this.btnCycleEl = null;
    this.btnSettingsToggleEl = null;
    this.settingsPanelEl = this.settingsBackdropEl = null;
    this.btnPauseEl = this.btnHushEl = this.btnClearEl = null;
    this.displaySegEl = null;
    this.fontDecEl = this.fontIncEl = this.fontLabelEl = null;
    this._settingsOpen = false;
    this._pttHeld = false;
    this.onClose();
  }

  close() {
    if (this.win) { try { this.win.close(); } catch (_) {} }
    this._cleanup();
  }
}
