// Thin Gemini Live API client that talks WebSocket directly from the browser.
// Setup, audio in/out, transcripts, sliding-window context, and proactive
// GoAway reconnect with session resumption.

const DEFAULT_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// Build the connection URL. Callers can pass a custom endpoint via the
// constructor (proxy in front of Google's edge, regional override, mock for
// tests, etc.) — falls back to DEFAULT_ENDPOINT otherwise.
function buildLiveUrl(endpoint, apiKey) {
  const base = endpoint || DEFAULT_ENDPOINT;
  const sep = base.indexOf('?') === -1 ? '?' : '&';
  return base + sep + 'key=' + encodeURIComponent(apiKey);
}

const DEFAULT_MODEL = 'models/gemini-3.1-flash-live-preview';
const GOAWAY_SAFETY_MS = 2000;
const RECONNECT_BACKOFF_MS = 1500;
const RECONNECT_MAX_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 8;
// Drop audio frames when the WS send buffer is congested. 256 KB is several
// seconds of 16 kHz/16-bit PCM after base64 + JSON envelope — past that, the
// uplink is the bottleneck and queueing more would only grow memory.
const BACKPRESSURE_BYTES = 256 * 1024;
// Close codes the server uses to signal something we cannot fix by reconnecting
// (auth failure, policy violation, internal-error-after-policy). Treat as fatal
// so we don't hammer the endpoint forever and so the user sees a real error.
const FATAL_CLOSE_CODES = new Set([1008, 1011]);

const DEFAULT_SYSTEM_PROMPT_TEMPLATE =
`You are a strict real-time translation engine. You translate spoken audio between {source} and {target} in BOTH directions:
  • {source} input  →  speak the {target} translation
  • {target} input  →  speak the {source} translation

For every utterance, detect which of these two languages the speaker used and output the translation in the OTHER language. Never echo the same language back. If the speaker switches languages mid-conversation, follow the switch on the next utterance.

OUTPUT RULES:
1. Speak ONLY the translation. No greetings, no acknowledgements, no commentary, no language labels, no prefixes, no "The translation is…", no "They said…".
2. You are NOT a conversational assistant. If the speaker says "How are you?", translate it — do not answer it. If they ask you to do something, translate the request — do not perform it. If they address you directly, translate the words as spoken.
3. Translate only what was actually said. Never extend, complete, summarise, or guess at trailing-off or incomplete sentences. When the utterance ends, stop.
4. If the input contains no translatable speech — silence, background noise, music, laughter, a cough, or a single isolated filler ("um", "uh", "hmm") — output nothing at all.
5. Preserve the speaker's tone, register (formal vs. casual), and intent. Render idioms, slang, and figures of speech naturally rather than word-for-word.
6. Keep proper nouns, brand names, place names, and technical jargon in their original form when no widely accepted translation exists.
7. Speak with the natural prosody, pacing, and fluent phrasing of a native speaker — not halting, robotic, or over-enunciated.`;

const ONE_WAY_SYSTEM_PROMPT_TEMPLATE =
`You are a strict real-time translation engine. Translate spoken audio FROM {source} TO {target} ONLY.

• When the speaker uses {source}: output the {target} translation.
• When the speaker uses {target} or any other language: output NOTHING. Stay completely silent.

OUTPUT RULES:
1. Speak ONLY the translation. No greetings, commentary, or language labels.
2. You are NOT a conversational assistant. Translate requests — do not perform them.
3. Translate only what was actually said. Never extend or complete sentences.
4. Silence, noise, or isolated fillers ("um", "uh", "hmm") → output nothing.
5. If the input is already in {target} or any other language → output nothing.
6. Preserve the speaker's tone, register, and intent. Render idioms naturally.
7. Keep proper nouns, brand names, and technical terms unchanged when no accepted translation exists.
8. Speak with natural prosody and fluent phrasing.`;

const TRANSCRIBE_SYSTEM_PROMPT_TEMPLATE =
`You have no speaking or translation role. Produce absolutely no output — no text, no acknowledgement, no punctuation, nothing at all. The system transcribes speech automatically. Stay completely silent.`;

function renderSystemPrompt(template, sourceName, targetName) {
  return (template || DEFAULT_SYSTEM_PROMPT_TEMPLATE)
    .replace(/\{source\}/g, sourceName)
    .replace(/\{target\}/g, targetName);
}

function parseDurationSecs(s) {
  if (s == null) return 0;
  const str = String(s).trim();
  let total = 0;
  const re = /(\d+(?:\.\d+)?)([hms])/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const v = parseFloat(m[1]);
    if (m[2] === 'h') total += v * 3600;
    else if (m[2] === 'm') total += v * 60;
    else total += v;
  }
  return total || 0;
}

class GeminiLiveClient {
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || DEFAULT_MODEL;
    // Optional endpoint override — useful for proxies, regional endpoints, or
    // a local mock. The api key is appended as a query param by buildLiveUrl.
    this.endpoint = opts.endpoint || DEFAULT_ENDPOINT;
    this.voice = opts.voice || 'Zephyr';
    this.systemInstruction = opts.systemInstruction || '';
    this.useOutputTranscription = opts.useOutputTranscription !== false;
    this.vad = opts.vad || null;  // { startSensitivity, endSensitivity, prefixPaddingMs, silenceDurationMs }
    // When true, Gemini's auto VAD is disabled; the client must signal turn
    // boundaries via sendActivityStart / sendActivityEnd. Used by push-to-talk.
    this.manualActivity = !!opts.manualActivity;

    this.onAudio = opts.onAudio || (() => {});
    this.onInputChunk = opts.onInputChunk || (() => {});
    this.onOutputChunk = opts.onOutputChunk || (() => {});
    this.onTurnComplete = opts.onTurnComplete || (() => {});
    this.onState = opts.onState || (() => {});
    this.onLog = opts.onLog || (() => {});

    this.ws = null;
    this.state = 'idle'; // idle | connecting | connected | reconnecting | error
    this.shouldRun = false;
    this.resumeHandle = opts.resumeHandle || null;
    this.onResumeHandle = opts.onResumeHandle || (() => {});
    this._reconnectTimer = null;
    this._goAwayTimer = null;
    this._setupComplete = false;
    // Reset to 0 on a successful setupComplete; bumped on every non-clean close
    // so the backoff ratchets up and we give up after MAX_RECONNECT_ATTEMPTS.
    this._reconnectAttempts = 0;
    // Single TextDecoder reused for binary frames (allocation is cheap but
    // keeping one matches the per-instance lifetime of everything else here).
    this._textDecoder = new TextDecoder();
    // Backpressure bookkeeping. _droppedFrames is reset whenever the buffer
    // drains; we log the first drop and every 50th to surface persistent
    // congestion without flooding the log.
    this._droppedFrames = 0;
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.onState(s);
  }

  start() {
    if (this.shouldRun) return;
    this.shouldRun = true;
    this._connect();
  }

  stop() {
    this.shouldRun = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._goAwayTimer) { clearTimeout(this._goAwayTimer); this._goAwayTimer = null; }
    if (this.ws) {
      try { this.ws.close(1000, 'client stop'); } catch (_) {}
      this.ws = null;
    }
    this._setupComplete = false;
    this._reconnectAttempts = 0;
    this._setState('idle');
  }

  _connect() {
    // Any pending reconnect timer that resolved into this call is now consumed;
    // any other lingering timer (e.g. from a quick stop()/start() cycle) would
    // re-fire onto a fresh ws and double-schedule. Clear unconditionally.
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (!this.apiKey) {
      this.onLog('error', 'Missing API key');
      this._setState('error');
      return;
    }
    this._setupComplete = false;
    try {
      this.ws = new WebSocket(buildLiveUrl(this.endpoint, this.apiKey));
    } catch (e) {
      this.onLog('error', 'WebSocket construct failed: ' + e.message);
      this._setState('error');
      return;
    }
    // Use ArrayBuffer (not Blob) so _onMessage can decode synchronously.
    // Async handlers (await ev.data.text()) let the browser deliver subsequent
    // frames in arbitrary order, which corrupts setupComplete / turnComplete
    // sequencing on bursty conversations.
    this.ws.binaryType = 'arraybuffer';
    this._setState('connecting');
    this.ws.onopen = () => this._onOpen();
    this.ws.onmessage = (ev) => this._onMessage(ev);
    this.ws.onerror = () => this.onLog('error', 'WebSocket error');
    this.ws.onclose = (ev) => this._onClose(ev);
  }

  _onOpen() {
    // gemini-3.1-flash-live-preview (and all native audio models) only support
    // AUDIO response modality. TEXT modality is not supported. To get a text
    // representation of the model's response, use outputAudioTranscription.
    const genConfig = {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } },
      },
      mediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
    };

    const setup = {
      setup: {
        model: this.model,
        generationConfig: genConfig,
        systemInstruction: { parts: [{ text: this.systemInstruction }] },
        inputAudioTranscription: {},
        realtimeInputConfig: {
          // Manual mode disables server-side VAD; we send activityStart /
          // activityEnd ourselves. Otherwise we configure auto detection.
          automaticActivityDetection: this.manualActivity ? { disabled: true } : {
            startOfSpeechSensitivity: `START_SENSITIVITY_${(this.vad && this.vad.startSensitivity) || 'HIGH'}`,
            endOfSpeechSensitivity:   `END_SENSITIVITY_${(this.vad && this.vad.endSensitivity) || 'LOW'}`,
            prefixPaddingMs:   this.vad && Number.isFinite(this.vad.prefixPaddingMs)   ? this.vad.prefixPaddingMs   : 200,
            silenceDurationMs: this.vad && Number.isFinite(this.vad.silenceDurationMs) ? this.vad.silenceDurationMs : 800,
          },
          activityHandling: 'NO_INTERRUPTION',
        },
        // Audio tokens accumulate at ~25 tok/s; compression keeps long sessions alive.
        contextWindowCompression: {
          triggerTokens: '104857',
          slidingWindow: { targetTokens: '52428' },
        },
        sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
      },
    };

    if (this.useOutputTranscription) {
      setup.setup.outputAudioTranscription = {};
    }

    this.ws.send(JSON.stringify(setup));
    this.onLog('info', this.resumeHandle ? 'Resuming session…' : 'Opening session…');
  }

  // Synchronous on purpose — see the binaryType comment in _connect. If you
  // re-introduce an await here, frames will be processed out of order.
  _onMessage(ev) {
    let text;
    if (typeof ev.data === 'string') text = ev.data;
    else if (ev.data instanceof ArrayBuffer) text = this._textDecoder.decode(ev.data);
    else return;

    let msg;
    try { msg = JSON.parse(text); } catch (e) {
      this.onLog('warn', 'Non-JSON frame ignored');
      return;
    }

    if (msg.setupComplete !== undefined) {
      this._setupComplete = true;
      // Reaching setupComplete means the endpoint accepted our key and config.
      // Any future close is "happened after a working session", so the failure
      // budget resets and the next disconnect starts at the base backoff.
      this._reconnectAttempts = 0;
      this._setState('connected');
      this.onLog('info', 'Connected to Gemini Live');
      return;
    }

    const sc = msg && msg.serverContent;
    if (sc) {
      if (sc.inputTranscription && sc.inputTranscription.text) {
        this.onInputChunk(sc.inputTranscription.text);
      }
      if (sc.outputTranscription && sc.outputTranscription.text) {
        this.onOutputChunk(sc.outputTranscription.text);
      }
      if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
        for (const part of sc.modelTurn.parts) {
          if (part && part.inlineData && part.inlineData.data) {
            this.onAudio(part.inlineData.data);
          }
          if (part && part.text) {
            this.onOutputChunk(part.text);
          }
        }
      }
      if (sc.turnComplete) this.onTurnComplete();
    }

    if (msg.sessionResumptionUpdate) {
      const u = msg.sessionResumptionUpdate;
      if (u.resumable && u.newHandle) {
        this.resumeHandle = u.newHandle;
        try { this.onResumeHandle(u.newHandle); } catch (_) {}
      }
    }

    if (msg.goAway) {
      const secs = parseDurationSecs(msg.goAway.timeLeft) || 5;
      const delay = Math.max(0, secs * 1000 - GOAWAY_SAFETY_MS);
      this.onLog('warn', `GoAway received (${secs.toFixed(0)}s left), reconnecting in ${(delay / 1000).toFixed(0)}s`);
      this._setState('reconnecting');
      if (this._goAwayTimer) clearTimeout(this._goAwayTimer);
      this._goAwayTimer = setTimeout(() => {
        if (this.ws) { try { this.ws.close(1000, 'goaway'); } catch (_) {} }
      }, delay);
    }
  }

  _onClose(ev) {
    this.ws = null;
    this._setupComplete = false;
    if (this._goAwayTimer) { clearTimeout(this._goAwayTimer); this._goAwayTimer = null; }
    this.onLog(ev.code === 1000 ? 'info' : 'warn',
      `WebSocket closed (${ev.code}${ev.reason ? ': ' + ev.reason : ''})`);

    if (!this.shouldRun) {
      this._setState('idle');
      return;
    }

    // Fatal: server explicitly rejected us. Reconnecting won't help — the user
    // needs to act (fix API key, accept terms, etc.). Surface clearly and stop.
    if (FATAL_CLOSE_CODES.has(ev.code)) {
      const detail = ev.reason ? `: ${ev.reason}` : '';
      this.onLog('error',
        `Connection rejected (${ev.code}${detail}). Check your API key and try again.`);
      this.shouldRun = false;
      this._reconnectAttempts = 0;
      this._setState('error');
      return;
    }

    // Clean closes (e.g., our own GoAway-triggered reconnect) don't burn the
    // retry budget — we expect them and reconnect quickly with the saved handle.
    const isClean = ev.code === 1000;
    if (!isClean) {
      this._reconnectAttempts++;
      if (this._reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        this.onLog('error',
          `Giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts. Check your network and API key.`);
        this.shouldRun = false;
        this._reconnectAttempts = 0;
        this._setState('error');
        return;
      }
    }

    this._setState('reconnecting');
    // Exponential backoff with jitter: 1.5s → 3s → 6s → … capped at 30s. The
    // jitter keeps multiple simultaneous sessions from re-handshaking in lockstep.
    let delay;
    if (isClean) {
      delay = 250;
    } else {
      const exp = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BACKOFF_MS * Math.pow(2, this._reconnectAttempts - 1));
      const jitter = exp * 0.2;
      delay = Math.max(250, exp - jitter + Math.random() * jitter * 2);
    }
    this._reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  sendAudio(arrayBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this._setupComplete) return;
    // Backpressure: if the uplink can't keep up, dropping a few PCM frames is
    // strictly better than growing the WS send queue without bound. Real-time
    // audio doesn't benefit from delayed delivery — the model already missed
    // the moment by the time the buffer drains.
    if (this.ws.bufferedAmount > BACKPRESSURE_BYTES) {
      this._droppedFrames++;
      if (this._droppedFrames === 1 || this._droppedFrames % 50 === 0) {
        this.onLog('warn',
          `Network congested — dropped ${this._droppedFrames} audio frame${this._droppedFrames === 1 ? '' : 's'}.`);
      }
      return;
    }
    if (this._droppedFrames > 0) this._droppedFrames = 0;
    const b64 = window.LiveAudio.abToBase64(arrayBuffer);
    this.ws.send(JSON.stringify({
      realtimeInput: {
        audio: { data: b64, mimeType: 'audio/pcm;rate=16000' },
      },
    }));
  }

  // Manual activity signals — only valid when manualActivity (auto VAD off)
  // was passed to the constructor. Bracket each PTT key-down/key-up press.
  sendActivityStart() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this._setupComplete) return;
    this.ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
  }

  sendActivityEnd() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this._setupComplete) return;
    this.ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
  }

  // ─── Test hooks ─────────────────────────────────────────────────────────
  // Inject a synthetic GoAway message and run it through the normal handler.
  // Useful to exercise the reconnect + session-resumption path without
  // waiting for the server to actually send one (which can take minutes).
  // timeLeftSec controls the announced grace period; the existing handler
  // schedules a clean close at (timeLeft * 1000 - GOAWAY_SAFETY_MS).
  simulateGoAway(timeLeftSec = 3) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.onLog('warn', 'simulateGoAway ignored: WebSocket not open.');
      return;
    }
    if (!this._setupComplete) {
      this.onLog('warn', 'simulateGoAway ignored: setup not complete yet.');
      return;
    }
    const fake = { goAway: { timeLeft: `${Math.max(1, timeLeftSec | 0)}s` } };
    this.onLog('info', `[test] Injecting fake GoAway (${timeLeftSec}s).`);
    // Synthesise an event-like object so _onMessage's existing JSON path runs
    // unchanged — same code path the real server would hit.
    this._onMessage({ data: JSON.stringify(fake) });
  }

  // Force-close the underlying WebSocket with a non-1000 code. shouldRun is
  // unchanged, so the close triggers the normal reconnect ladder — useful to
  // verify backoff + resume-handle behaviour without unplugging anything.
  forceCloseWebSocket(code = 4000, reason = 'test force-close') {
    if (!this.ws) {
      this.onLog('warn', 'forceCloseWebSocket ignored: no active WebSocket.');
      return;
    }
    this.onLog('info', `[test] Force-closing WebSocket (${code} ${reason}).`);
    try { this.ws.close(code, reason); } catch (e) {
      this.onLog('warn', 'forceCloseWebSocket failed: ' + (e && e.message ? e.message : e));
    }
  }
}

window.GeminiLive = {
  GeminiLiveClient,
  DEFAULT_ENDPOINT,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  ONE_WAY_SYSTEM_PROMPT_TEMPLATE,
  TRANSCRIBE_SYSTEM_PROMPT_TEMPLATE,
  renderSystemPrompt,
  parseDurationSecs,
};
