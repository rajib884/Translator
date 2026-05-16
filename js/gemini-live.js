// Thin Gemini Live API client that talks WebSocket directly from the browser.
// Setup, audio in/out, transcripts, sliding-window context, and proactive
// GoAway reconnect with session resumption.

const LIVE_URL = (apiKey) =>
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' +
  encodeURIComponent(apiKey);

const DEFAULT_MODEL = 'models/gemini-3.1-flash-live-preview';
const GOAWAY_SAFETY_MS = 2000;
const RECONNECT_BACKOFF_MS = 1500;

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
    this.resumeHandle = null;
    this._reconnectTimer = null;
    this._goAwayTimer = null;
    this._setupComplete = false;
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
    this.resumeHandle = null;
    this._setupComplete = false;
    this._setState('idle');
  }

  _connect() {
    if (!this.apiKey) {
      this.onLog('error', 'Missing API key');
      this._setState('error');
      return;
    }
    this._setupComplete = false;
    try {
      this.ws = new WebSocket(LIVE_URL(this.apiKey));
    } catch (e) {
      this.onLog('error', 'WebSocket construct failed: ' + e.message);
      this._setState('error');
      return;
    }
    this.ws.binaryType = 'blob';
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

  async _onMessage(ev) {
    let text;
    if (typeof ev.data === 'string') text = ev.data;
    else if (ev.data instanceof Blob) text = await ev.data.text();
    else if (ev.data instanceof ArrayBuffer) text = new TextDecoder().decode(ev.data);
    else return;

    let msg;
    try { msg = JSON.parse(text); } catch (e) {
      this.onLog('warn', 'Non-JSON frame ignored');
      return;
    }

    if (msg.setupComplete !== undefined) {
      this._setupComplete = true;
      this._setState('connected');
      this.onLog('info', 'Connected to Gemini Live');
      return;
    }

    const sc = msg.serverContent;
    if (sc) {
      if (sc.inputTranscription && sc.inputTranscription.text) {
        this.onInputChunk(sc.inputTranscription.text);
      }
      if (sc.outputTranscription && sc.outputTranscription.text) {
        this.onOutputChunk(sc.outputTranscription.text);
      }
      if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData && part.inlineData.data) {
            this.onAudio(part.inlineData.data);
          }
          if (part.text) {
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
    this._setState('reconnecting');
    const delay = ev.code === 1000 ? 250 : RECONNECT_BACKOFF_MS;
    this._reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  sendAudio(arrayBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this._setupComplete) return;
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
}

window.GeminiLive = {
  GeminiLiveClient,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  ONE_WAY_SYSTEM_PROMPT_TEMPLATE,
  TRANSCRIBE_SYSTEM_PROMPT_TEMPLATE,
  renderSystemPrompt,
  parseDurationSecs,
};
