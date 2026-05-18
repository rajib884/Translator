// Audio capture (mic and/or display) → 16 kHz Int16 PCM, and TTS playback (24 kHz Int16 PCM).
// Pure browser. AudioWorklet loaded from a Blob URL so this works from file:// or any host.

// ─── Shared level meter ──────────────────────────────────────────────────────
// Three independent rAF loops (capture / companion / TTS) all wanted the same
// pattern: per-frame exponential decay (~100 ms time constant), an external
// peak pushed in from message callbacks or sampled from an analyser, and a
// stop condition that either ends immediately (capture lost) or tails through
// the decay so the meter fades smoothly when audio finishes (TTS).
//
// `isActive` returns true while the meter should keep ticking unconditionally.
// `sampler` is an optional per-tick peak source (used by TTSPlayer to read the
// analyser). `decayTail` keeps the loop running for the smooth fade-out — set
// to Infinity for "stop the moment isActive flips false" (capture semantics).
class LevelMeter {
  constructor({ onLevel, isActive, sampler = null, decayTau = 0.1, decayTail = Infinity }) {
    this.onLevel = onLevel || (() => {});
    this.isActive = isActive || (() => false);
    this.sampler = sampler;
    this.decayTau = decayTau;
    this.decayTail = decayTail;
    this._level = 0;
    this._rafId = 0;
  }

  // Push an externally observed peak; the next tick exponentially decays from
  // this value (the highest wins over the decay).
  push(peak) {
    if (peak > this._level) this._level = peak;
  }

  get level() { return this._level; }

  start() {
    if (this._rafId) return;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = Math.max(0, (now - last) / 1000);
      last = now;

      if (this.sampler) {
        const peak = this.sampler();
        if (peak > this._level) this._level = peak;
        else this._level *= Math.exp(-dt / this.decayTau);
      } else {
        this._level *= Math.exp(-dt / this.decayTau);
      }

      this.onLevel(this._level);

      if (this.isActive() || this._level > this.decayTail) {
        this._rafId = requestAnimationFrame(tick);
      } else {
        this._rafId = 0;
        this.onLevel(0);
      }
    };
    this._rafId = requestAnimationFrame(tick);
  }

  stop() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this._level = 0;
    this.onLevel(0);
  }
}

const PCM16_WORKLET_SRC = `
class PCM16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ratio = sampleRate / 16000;
    this._inPos = 0;
    this._prev = 0;
    this._target = 1600;                  // ~100 ms @ 16 kHz
    this._out = new Float32Array(this._target);
    this._oIdx = 0;
    this._peak = 0;
    // Emit a level message every ~100 ms of input audio regardless of the
    // context sample rate or render quantum size, so the visualizer cadence
    // is consistent across devices.
    this._levelSamples = 0;
    this._levelInterval = (sampleRate * 0.1) | 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    const N = ch.length;
    const ratio = this._ratio;
    const target = this._target;
    const out = this._out;
    let p = this._inPos;
    let o = this._oIdx;
    let peak = this._peak;

    while (p < N) {
      let v;
      if (p < 0) {
        const frac = p + 1;
        v = this._prev * (1 - frac) + ch[0] * frac;
      } else {
        const i = p | 0;
        const frac = p - i;
        const a = ch[i];
        const b = (i + 1 < N) ? ch[i + 1] : a;
        v = a + (b - a) * frac;
      }
      if (v > 1) v = 1; else if (v < -1) v = -1;
      out[o++] = v;
      if (o >= target) {
        const buf = new Int16Array(target);
        for (let k = 0; k < target; k++) {
          const s = out[k];
          buf[k] = s < 0 ? (s * 32768) | 0 : (s * 32767) | 0;
        }
        this.port.postMessage({ type: 'audio', buffer: buf.buffer }, [buf.buffer]);
        o = 0;
      }
      p += ratio;
    }

    for (let i = 0; i < N; i++) {
      const a = ch[i] < 0 ? -ch[i] : ch[i];
      if (a > peak) peak = a;
    }

    p -= N;
    this._prev = ch[N - 1];
    this._inPos = p;
    this._oIdx = o;

    this._levelSamples += N;
    if (this._levelSamples >= this._levelInterval) {
      this.port.postMessage({ type: 'level', level: peak });
      this._levelSamples = 0;
      peak = 0;
    }
    this._peak = peak;
    return true;
  }
}
registerProcessor('pcm16-processor', PCM16Processor);
`;

class AudioCapture {
  constructor({ onChunk, onLevel, onDisplayEnded } = {}) {
    this.onChunk = onChunk || (() => {});
    this.onDisplayEnded = onDisplayEnded || (() => {});
    this.ctx = null;
    this.streams = [];
    this.sources = [];
    this.node = null;
    this._workletUrl = null;
    // Meter ticks while a worklet node exists; the moment capture is torn
    // down, isActive flips false and the tail (Infinity) lets the loop end on
    // the next frame with a final level=0 emission.
    this._meter = new LevelMeter({
      onLevel: onLevel || (() => {}),
      isActive: () => !!this.node,
    });
  }

  // mode: 'mic' | 'display' | 'both'
  async start({ mode = 'mic', micDeviceId = '' } = {}) {
    const wantMic = mode === 'mic' || mode === 'both';
    const wantDisplay = mode === 'display' || mode === 'both';

    // Everything below the first await acquires a real OS resource: a mic
    // permission grant, a display-share grant, an AudioContext, a Blob URL.
    // If any one of them throws partway, the previously-acquired resources
    // would leak (mic indicator stuck on, ghost AudioContexts, retained
    // Blob URL). Wrap the whole body so any thrown exception unwinds via
    // _abortStart() before rethrowing.
    try {
      if (wantMic) {
        const baseAudio = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        };
        let s;
        try {
          const audio = { ...baseAudio };
          if (micDeviceId) audio.deviceId = { exact: micDeviceId };
          s = await navigator.mediaDevices.getUserMedia({ audio });
        } catch (e) {
          if (!micDeviceId) throw e;
          s = await navigator.mediaDevices.getUserMedia({ audio: baseAudio });
        }
        this.streams.push({ kind: 'mic', stream: s });
      }

      if (wantDisplay) {
        // Chrome requires `video: true` to even surface the audio option in the picker.
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
        if (displayStream.getAudioTracks().length === 0) {
          displayStream.getTracks().forEach((t) => t.stop());
          throw new Error('No audio track. Pick a tab and tick "Share tab audio".');
        }
        // We don't need the video — stop it so the indicator is quieter and CPU is lower.
        displayStream.getVideoTracks().forEach((t) => t.stop());
        const audioTrack = displayStream.getAudioTracks()[0];
        audioTrack.addEventListener('ended', () => this.onDisplayEnded());
        this.streams.push({ kind: 'display', stream: displayStream });
      }

      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') await this.ctx.resume();

      const blob = new Blob([PCM16_WORKLET_SRC], { type: 'application/javascript' });
      this._workletUrl = URL.createObjectURL(blob);
      await this.ctx.audioWorklet.addModule(this._workletUrl);

      // Force mono so the worklet always reads inputs[0][0]. Sources at different
      // channel counts (stereo display vs mono mic) get downmixed before delivery.
      this.node = new AudioWorkletNode(this.ctx, 'pcm16-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      this.node.port.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'audio') this.onChunk(m.buffer);
        else if (m.type === 'level') this._meter.push(m.level);
      };

      // Connect every input stream to the same worklet — Web Audio sums them.
      for (const s of this.streams) {
        const src = this.ctx.createMediaStreamSource(s.stream);
        src.connect(this.node);
        this.sources.push(src);
      }
      // Worklet output isn't connected to destination — no monitor playback.

      this._meter.start();
    } catch (e) {
      this._abortStart();
      throw e;
    }
  }

  // Cleanup helper for failed start(). Releases everything we may have
  // allocated regardless of which step blew up. Safe to call when partial.
  _abortStart() {
    for (const s of this.sources) { try { s.disconnect(); } catch (_) {} }
    this.sources = [];
    try { this.node && this.node.disconnect(); } catch (_) {}
    this.node = null;
    this._releaseStreams();
    if (this._workletUrl) {
      URL.revokeObjectURL(this._workletUrl);
      this._workletUrl = null;
    }
    if (this.ctx) {
      try { this.ctx.close(); } catch (_) {}
      this.ctx = null;
    }
    this._meter.stop();
  }

  _releaseStreams() {
    for (const s of this.streams) {
      try { s.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    }
    this.streams = [];
  }

  stop() {
    for (const s of this.sources) { try { s.disconnect(); } catch (_) {} }
    try { this.node && this.node.disconnect(); } catch (_) {}
    this._releaseStreams();
    try { this.ctx && this.ctx.close(); } catch (_) {}
    if (this._workletUrl) {
      URL.revokeObjectURL(this._workletUrl);
      this._workletUrl = null;
    }
    this.sources = [];
    this.node = null;
    this.ctx = null;
    this._meter.stop();
  }

  // The deviceId actually attached to the live mic track. Differs from the
  // user's pick when they chose "System default" — getSettings() resolves it
  // to the concrete OS device the browser handed us.
  getActiveMicId() {
    const entry = this.streams.find((x) => x.kind === 'mic');
    if (!entry) return null;
    const tracks = entry.stream.getAudioTracks();
    if (!tracks.length || tracks[0].readyState !== 'live') return null;
    try {
      const s = tracks[0].getSettings();
      return s && s.deviceId ? s.deviceId : '';
    } catch (_) { return null; }
  }
}

class CompanionAudioCapture {
  constructor({ onChunk, onLevel, onDisplayEnded, onReconnectState } = {}) {
    this.onChunk = onChunk || (() => {});
    this.onDisplayEnded = onDisplayEnded || (() => {});
    this.onReconnectState = onReconnectState || (() => {});
    this.ws = null;
    this._stopping = false;
    this._wsUrl = '';
    this._reconnectTimer = 0;
    this._reconnectAttempts = 0;
    // Tick while the WebSocket is alive; on close, snap level to 0 (same
    // semantics as AudioCapture — meter dies with the input).
    this._meter = new LevelMeter({
      onLevel: onLevel || (() => {}),
      isActive: () => !!this.ws,
    });
  }

  async start({ wsUrl = 'ws://127.0.0.1:52341/audio' } = {}) {
    this._wsUrl = wsUrl;
    this._stopping = false;
    this._reconnectAttempts = 0;
    await this._connect({ initial: true });
  }

  async _connect({ initial = false } = {}) {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this._wsUrl);
      let settled = false;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        settled = true;
        this._stopping = false;
        this.ws = ws;
        this._reconnectAttempts = 0;
        this._meter.start();
        this.onReconnectState({ state: initial ? 'connected' : 'reconnected', attempt: 0 });
        resolve();
      };
      ws.onerror = () => {
        if (!settled) reject(new Error('Companion audio service is unavailable.'));
      };
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        if (!settled) {
          reject(new Error('Companion audio service is unavailable.'));
          return;
        }
        if (!this._stopping) this._scheduleReconnect();
      };
      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        this._trackLevel(ev.data);
        this.onChunk(ev.data);
      };
    });
  }

  _scheduleReconnect() {
    if (this._stopping || this._reconnectTimer) return;
    this._meter.stop();
    this._reconnectAttempts++;
    const base = Math.min(10000, 500 * Math.pow(2, this._reconnectAttempts - 1));
    const jitter = base * 0.2;
    const delay = Math.max(250, base - jitter + Math.random() * jitter * 2);
    this.onReconnectState({ state: 'reconnecting', attempt: this._reconnectAttempts, delay });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = 0;
      if (this._stopping) return;
      this._connect({ initial: false }).catch(() => this._scheduleReconnect());
    }, delay);
  }

  _trackLevel(buffer) {
    const pcm = new Int16Array(buffer);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i] / 32768);
      if (a > peak) peak = a;
    }
    this._meter.push(peak);
  }

  stop() {
    const ws = this.ws;
    this._stopping = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = 0;
    }
    this.ws = null;
    this._meter.stop();
    try { ws && ws.close(); } catch (_) {}
  }
}

class TTSPlayer {
  constructor({ onLevel, onActiveChange, outputDeviceIds, outputDeviceId } = {}) {
    this.onActiveChange = onActiveChange || (() => {});
    this.outputDeviceIds = TTSPlayer._normalizeIds(
      Array.isArray(outputDeviceIds) ? outputDeviceIds : (outputDeviceId != null ? [outputDeviceId] : []));
    this.ctx = null;
    this.outputNode = null;
    this.analyser = null;
    this._analyserBuf = null;
    // One entry per active sink. Either { useDestination: true } for the
    // ctx.destination fallback, or { deviceId, streamDest, audioEl } for a
    // MediaStreamDestination + <audio> pair (one per requested device).
    this.sinks = [];
    this.nextStart = 0;
    this.sources = new Set();
    // Meter samples the analyser each tick (so the level reflects what's
    // actually playing, not what's been scheduled). Keeps ticking while a
    // BufferSource is queued OR until the level decays under decayTail — that
    // way the fade-out is smooth after the model stops streaming.
    this._meter = new LevelMeter({
      onLevel: onLevel || (() => {}),
      isActive: () => this.sources.size > 0,
      sampler: () => this._sampleAnalyserPeak(),
      decayTail: 0.005,
    });
    // Serialises sink reconfiguration against chunk playback. _applyDevices
    // tears down and rebuilds the analyser→destination connections across
    // multiple awaits (setSinkId, play); a playChunk landing mid-window would
    // schedule a BufferSource into a disconnected graph and play silently.
    // playChunk awaits this queue so chunks always see a fully-connected sink.
    this._applyDevicesQueue = Promise.resolve();
    this._destroyed = false;
    this.warnings = [];
  }

  _sampleAnalyserPeak() {
    if (!this.analyser || !this._analyserBuf) return 0;
    this.analyser.getFloatTimeDomainData(this._analyserBuf);
    const buf = this._analyserBuf;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = buf[i] < 0 ? -buf[i] : buf[i];
      if (a > peak) peak = a;
    }
    return peak;
  }

  // Strip empties to a single '' (default), de-dupe, and keep order. Thin
  // shim that routes to the shared LiveAudio.normalizeOutputIds helper —
  // kept as a static method for source compatibility with existing callers
  // inside this class.
  static _normalizeIds(ids) {
    return normalizeOutputIds(ids);
  }

  async ensureCtx() {
    if (this._destroyed) return;
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Sources feed an analyser so the meter reflects what is actually
      // playing out the speakers, not what we have queued. Without this, the
      // level decays to zero as soon as the model finishes streaming chunks,
      // even though several seconds of audio may still be buffered.
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0;
      this._analyserBuf = new Float32Array(this.analyser.fftSize);
      this.outputNode = this.analyser;
      await this._applyDevices(this.outputDeviceIds);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  _tearDownSinks() {
    for (const s of this.sinks) {
      if (s.audioEl) {
        try { s.audioEl.pause(); } catch (_) {}
        s.audioEl.srcObject = null;
      }
      try { s.streamDest && s.streamDest.disconnect(); } catch (_) {}
    }
    this.sinks = [];
    try { this.analyser && this.analyser.disconnect(); } catch (_) {}
  }

  // Public entry point — chains onto _applyDevicesQueue so concurrent callers
  // (and any playChunks waiting on the queue) run in a well-defined order.
  _applyDevices(ids) {
    const next = this._applyDevicesQueue
      .catch(() => {})                       // never let one failure poison the chain
      .then(() => this._doApplyDevices(ids));
    this._applyDevicesQueue = next;
    return next;
  }

  async _doApplyDevices(ids) {
    if (!this.ctx || !this.analyser) return;

    this.warnings = [];
    this._tearDownSinks();

    const list = (ids && ids.length) ? ids.slice() : [''];
    const canSink = TTSPlayer.canSelectOutputDevice();
    // If the only request is the system default — or the platform can't
    // re-route at all — connect straight to ctx.destination. Cheaper, and
    // it's the only thing that works on browsers without setSinkId.
    const onlyDefault = list.length === 1 && list[0] === '';
    if (onlyDefault || !canSink) {
      this.analyser.connect(this.ctx.destination);
      this.sinks.push({ useDestination: true });
      if (!canSink) this.outputDeviceIds = [''];
      return;
    }

    const accepted = [];
    for (const id of list) {
      const dest = this.ctx.createMediaStreamDestination();
      this.analyser.connect(dest);
      const el = new Audio();
      el.autoplay = true;
      el.playsInline = true;
      el.srcObject = dest.stream;
      let resolvedId = id;
      let setSinkErr = null;
      try {
        await el.setSinkId(id || '');
      } catch (e) {
        setSinkErr = e;
        // Requested device disappeared or was rejected. Fall back to the
        // system default for this sink so the session still produces audio.
        try { await el.setSinkId(''); resolvedId = ''; }
        catch (_) {
          try { this.analyser.disconnect(dest); } catch (_) {}
          el.srcObject = null;
          this.warnings.push({ deviceId: id, reason: (setSinkErr && setSinkErr.message) || 'setSinkId failed' });
          continue;
        }
        this.warnings.push({ deviceId: id, reason: `requested device unavailable (${(setSinkErr && setSinkErr.message) || 'setSinkId failed'}); fell back to system default` });
      }
      try { await el.play(); }
      catch (e) {
        this.warnings.push({ deviceId: resolvedId, reason: `autoplay blocked (${(e && e.message) || 'play() rejected'})` });
      }
      this.sinks.push({ deviceId: resolvedId, streamDest: dest, audioEl: el });
      accepted.push(resolvedId);
    }

    // Reflect what actually stuck (e.g. fallbacks to default), de-duped.
    this.outputDeviceIds = TTSPlayer._normalizeIds(accepted);

    // If every requested sink failed, fall back to ctx.destination so audio
    // still plays somewhere instead of going silent.
    if (this.sinks.length === 0) {
      this.analyser.connect(this.ctx.destination);
      this.sinks.push({ useDestination: true });
      this.outputDeviceIds = [''];
    }
  }

  async setOutputDevices(ids) {
    if (this._destroyed) return;
    const normalized = TTSPlayer._normalizeIds(ids);
    this.outputDeviceIds = normalized;
    if (!this.ctx) return;
    await this._applyDevices(normalized);
  }

  async setOutputDevice(deviceId) {
    await this.setOutputDevices([deviceId || '']);
  }

  async playChunk(base64Pcm) {
    if (this._destroyed) return;
    await this.ensureCtx();
    if (this._destroyed || !this.ctx) return;
    // Wait for any in-flight sink reconfiguration before scheduling. The queue
    // is also awaited inside _applyDevices itself, so this is a no-op when the
    // graph is already settled.
    await this._applyDevicesQueue.catch(() => {});
    if (this._destroyed || !this.ctx) return;
    const bin = atob(base64Pcm);
    const n = bin.length;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
    const usable = n - (n % 2);
    if (usable === 0) return;
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, usable / 2);

    const float = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      float[i] = pcm[i] / 32768;
    }

    const buf = this.ctx.createBuffer(1, float.length, 24000);
    buf.copyToChannel(float, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.outputNode || this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime + 0.04, this.nextStart);
    src.start(startAt);
    this.nextStart = startAt + buf.duration;

    const wasIdle = this.sources.size === 0;
    this.sources.add(src);
    if (wasIdle) {
      this.onActiveChange(true);
      this._meter.start();
    }
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0) {
        this.nextStart = 0;
        this.onActiveChange(false);
      }
    };
  }

  hush() {
    for (const s of this.sources) { try { s.stop(); } catch (_) {} }
    this.sources.clear();
    this.nextStart = 0;
    this.onActiveChange(false);
    this._meter.stop();
  }

  isActive() {
    return this.sources.size > 0 ||
           (this.ctx && this.nextStart > this.ctx.currentTime);
  }

  async destroy() {
    this._destroyed = true;
    this.hush();
    await this._applyDevicesQueue.catch(() => {});
    this._tearDownSinks();
    try { if (this.ctx) await this.ctx.close(); } catch (_) {}
    this.outputNode = null;
    this.analyser = null;
    this._analyserBuf = null;
    this.ctx = null;
  }

  // Sink ids currently wired up and playing. Mirrors what setSinkId actually
  // accepted, including '' fallbacks. UI uses this for live "active" badges.
  getActiveSinkIds() {
    if (!this.sinks.length) return [];
    return this.sinks.map((s) => s.useDestination ? '' : (s.deviceId || ''));
  }

  static canSelectOutputDevice() {
    return typeof HTMLMediaElement !== 'undefined' &&
           !!HTMLMediaElement.prototype &&
           typeof HTMLMediaElement.prototype.setSinkId === 'function';
  }
}

function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Canonical de-dupe + empty-coercion for an output-device id list. Shared
// between TTSPlayer._normalizeIds (in this file) and app.js's
// normalizeOutputDeviceIds wrapper (which also handles legacy single-string
// and bare-id save formats from older builds).
function normalizeOutputIds(ids) {
  const seen = new Set();
  const out = [];
  for (const raw of (ids || [])) {
    const id = raw == null ? '' : String(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function canCaptureDisplayAudio() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

function canSelectOutputDevice() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  return (Ctx && typeof Ctx.prototype.setSinkId === 'function') ||
         TTSPlayer.canSelectOutputDevice();
}

// ─── Mic passthrough ─────────────────────────────────────────────────────────
// Independently routes microphone audio to one or more output devices (e.g.
// a virtual cable). Completely decoupled from translation sessions so the user
// can stop/restart sessions without breaking their audio routing.
class MicPassthrough {
  constructor() {
    this.running = false;
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.sinks = []; // { deviceId, streamDest, audioEl }
    // Diagnostic surface: warnings accumulate per start() and the caller
    // (applyPassthrough in app.js) drains and logs them. Previously these
    // errors were swallowed inside inner try/catches, so users had no idea
    // why one of their selected speakers wasn't receiving the mic.
    this.warnings = [];
  }

  async start(micDeviceId, deviceIds) {
    await this.stop();
    this.warnings = [];
    if (!deviceIds || deviceIds.length === 0) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true,
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.source = this.ctx.createMediaStreamSource(this.stream);

    for (const id of deviceIds) {
      const dest = this.ctx.createMediaStreamDestination();
      this.source.connect(dest);
      const el = new Audio();
      el.autoplay = true;
      el.playsInline = true;
      el.srcObject = dest.stream;
      let resolvedId = id;
      let setSinkErr = null;
      try {
        await el.setSinkId(id || '');
      } catch (e) {
        setSinkErr = e;
        // Fall back to the system default so something still plays, but record
        // the failure so the user knows their pick didn't stick.
        try { await el.setSinkId(''); resolvedId = ''; }
        catch (e2) {
          // Even default failed — drop this sink instead of silently keeping
          // a disconnected audio element around.
          try { this.source.disconnect(dest); } catch (_) {}
          el.srcObject = null;
          this.warnings.push({ deviceId: id, reason: (e2 && e2.message) || (setSinkErr && setSinkErr.message) || 'setSinkId failed' });
          continue;
        }
        this.warnings.push({ deviceId: id, reason: `requested device unavailable (${(setSinkErr && setSinkErr.message) || 'setSinkId failed'}); fell back to system default` });
      }
      try { await el.play(); }
      catch (e) {
        this.warnings.push({ deviceId: resolvedId, reason: `autoplay blocked (${(e && e.message) || 'play() rejected'})` });
      }
      this.sinks.push({ deviceId: resolvedId, streamDest: dest, audioEl: el });
    }
    this.running = this.sinks.length > 0;
  }

  async stop() {
    for (const s of this.sinks) {
      try { s.audioEl.pause(); } catch (_) {}
      s.audioEl.srcObject = null;
      try { s.streamDest.disconnect(); } catch (_) {}
    }
    this.sinks = [];
    try { this.source && this.source.disconnect(); } catch (_) {}
    this.source = null;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      this.stream = null;
    }
    try { this.ctx && this.ctx.close(); } catch (_) {}
    this.ctx = null;
    this.running = false;
  }

  // Restarts with new settings. Cheap no-op when deviceIds is empty OR when
  // the call would re-create the exact same mic+sinks already running (e.g.
  // app.js calls applyPassthrough() after every output-list refresh — without
  // this short-circuit each refresh briefly silences the passthrough sink).
  async update(micDeviceId, deviceIds) {
    if (!deviceIds || deviceIds.length === 0) {
      if (this.running) await this.stop();
      return;
    }
    if (this.running && this._matchesActive(micDeviceId, deviceIds)) return;
    await this.start(micDeviceId, deviceIds);
  }

  _matchesActive(micDeviceId, deviceIds) {
    const currentMic = this.getActiveMicId();
    const wantMic = micDeviceId || '';
    // Treat null/undefined currentMic (no live track) as a mismatch — the
    // caller wants something running and we don't have anything.
    if (currentMic == null || currentMic !== wantMic) return false;
    const currentSinks = this.getActiveSinkIds();
    if (currentSinks.length !== deviceIds.length) return false;
    const have = new Set(currentSinks);
    for (const id of deviceIds) {
      if (!have.has(id || '')) return false;
    }
    return true;
  }

  getActiveMicId() {
    if (!this.stream) return null;
    const tracks = this.stream.getAudioTracks();
    if (!tracks.length || tracks[0].readyState !== 'live') return null;
    try {
      const s = tracks[0].getSettings();
      return s && s.deviceId ? s.deviceId : '';
    } catch (_) { return null; }
  }

  getActiveSinkIds() {
    return this.sinks.map((s) => s.deviceId || '');
  }
}

// Ephemeral mic-preview meter for the settings panel. Opens a short-lived
// getUserMedia stream (and own AudioContext), pushes levels to onLevel until
// stop() or the auto-close timer fires. Decoupled from any session — when the
// user starts an actual session the preview is torn down so the OS doesn't
// keep two mic indicators alive.
class InputPreview {
  constructor({ onLevel, onAutoStop, autoStopMs = 10000 } = {}) {
    this.onLevel = onLevel || (() => {});
    this.onAutoStop = onAutoStop || (() => {});
    this.autoStopMs = autoStopMs;
    this.stream = null;
    this.ctx = null;
    this.src = null;
    this.analyser = null;
    this._buf = null;
    this._rafId = 0;
    this._stopTimer = 0;
    this.running = false;
    // Serialises start/stop against rapid dropdown changes. Without this, two
    // concurrent start() calls can interleave: stream A from call 1 is still
    // resolving when call 2 starts; call 2 overwrites this.stream/ctx/src
    // before call 1 finishes, leaving stream A's MediaStream and AudioContext
    // unreleased (OS mic indicator stays on, contexts leak). Same pattern
    // TTSPlayer uses for _applyDevicesQueue.
    this._queue = Promise.resolve();
  }

  start(micDeviceId) {
    const next = this._queue
      .catch(() => {})                     // a previous failure must not poison the chain
      .then(() => this._doStart(micDeviceId));
    this._queue = next;
    return next;
  }

  stop() {
    const next = this._queue
      .catch(() => {})
      .then(() => this._doStop());
    this._queue = next;
    return next;
  }

  async _doStart(micDeviceId) {
    await this._doStop();
    const baseAudio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    };
    try {
      const audio = { ...baseAudio };
      if (micDeviceId) audio.deviceId = { exact: micDeviceId };
      this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (e) {
      // Fallback to default mic if the requested deviceId isn't available
      // anymore (device unplugged between selection and preview).
      if (!micDeviceId) throw e;
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: baseAudio });
    }

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this._buf = new Float32Array(this.analyser.fftSize);
    this.src.connect(this.analyser);

    this.running = true;
    let level = 0;
    let last = performance.now();
    const tick = () => {
      if (!this.running) return;
      const now = performance.now();
      const dt = Math.max(0, (now - last) / 1000);
      last = now;
      this.analyser.getFloatTimeDomainData(this._buf);
      let peak = 0;
      for (let i = 0; i < this._buf.length; i++) {
        const a = this._buf[i] < 0 ? -this._buf[i] : this._buf[i];
        if (a > peak) peak = a;
      }
      if (peak > level) level = peak;
      else level *= Math.exp(-dt / 0.1);
      this.onLevel(level);
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);

    // Auto-stop posts back onto the same queue so it can't interleave with an
    // in-flight start() the user kicked off in the same window.
    this._stopTimer = setTimeout(() => {
      this._stopTimer = 0;
      const wasRunning = this.running;
      this.stop().then(() => {
        if (wasRunning) this.onAutoStop();
      });
    }, this.autoStopMs);
  }

  async _doStop() {
    const wasRunning = this.running;
    this.running = false;
    if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = 0; }
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; }
    try { this.src && this.src.disconnect(); } catch (_) {}
    this.src = null;
    this.analyser = null;
    this._buf = null;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      this.stream = null;
    }
    if (this.ctx) {
      try { await this.ctx.close(); } catch (_) {}
      this.ctx = null;
    }
    if (wasRunning) this.onLevel(0);
  }
}

window.LiveAudio = { AudioCapture, CompanionAudioCapture, TTSPlayer, MicPassthrough, InputPreview, abToBase64, normalizeOutputIds, canCaptureDisplayAudio, canSelectOutputDevice };
