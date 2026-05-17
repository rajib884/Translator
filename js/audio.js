// Audio capture (mic and/or display) → 16 kHz Int16 PCM, and TTS playback (24 kHz Int16 PCM).
// Pure browser. AudioWorklet loaded from a Blob URL so this works from file:// or any host.

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
    this.onLevel = onLevel || (() => {});
    this.onDisplayEnded = onDisplayEnded || (() => {});
    this.ctx = null;
    this.streams = [];
    this.sources = [];
    this.node = null;
    this._workletUrl = null;
    this._level = 0;
    this._rafId = 0;
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
        else if (m.type === 'level') {
          if (m.level > this._level) this._level = m.level;
        }
      };

      // Connect every input stream to the same worklet — Web Audio sums them.
      for (const s of this.streams) {
        const src = this.ctx.createMediaStreamSource(s.stream);
        src.connect(this.node);
        this.sources.push(src);
      }
      // Worklet output isn't connected to destination — no monitor playback.

      this._startMeter();
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
  }

  _startMeter() {
    if (this._rafId) return;
    let last = performance.now();
    const decayTau = 0.1;
    const tick = () => {
      const now = performance.now();
      const dt = Math.max(0, (now - last) / 1000);
      last = now;
      this._level *= Math.exp(-dt / decayTau);
      this.onLevel(this._level);
      if (this.node) {
        this._rafId = requestAnimationFrame(tick);
      } else {
        this._rafId = 0;
        this.onLevel(0);
      }
    };
    this._rafId = requestAnimationFrame(tick);
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
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this._level = 0;
    this.onLevel(0);
    this.sources = [];
    this.node = null;
    this.ctx = null;
  }
}

class CompanionAudioCapture {
  constructor({ onChunk, onLevel, onDisplayEnded } = {}) {
    this.onChunk = onChunk || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onDisplayEnded = onDisplayEnded || (() => {});
    this.ws = null;
    this._level = 0;
    this._rafId = 0;
    this._stopping = false;
  }

  async start({ wsUrl = 'ws://127.0.0.1:52341/audio' } = {}) {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        settled = true;
        this._stopping = false;
        this.ws = ws;
        this._startMeter();
        resolve();
      };
      ws.onerror = () => {
        if (!settled) reject(new Error('Companion audio service is unavailable.'));
      };
      ws.onclose = () => {
        this.ws = null;
        if (!this._stopping) this.onDisplayEnded();
      };
      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        this._trackLevel(ev.data);
        this.onChunk(ev.data);
      };
    });
  }

  _trackLevel(buffer) {
    const pcm = new Int16Array(buffer);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i] / 32768);
      if (a > peak) peak = a;
    }
    if (peak > this._level) this._level = peak;
  }

  _startMeter() {
    if (this._rafId) return;
    let last = performance.now();
    // 100 ms time constant — reproduces the old *0.85/frame feel at 60 Hz
    // but is independent of the display refresh rate.
    const decayTau = 0.1;
    const tick = () => {
      const now = performance.now();
      const dt = Math.max(0, (now - last) / 1000);
      last = now;
      this._level *= Math.exp(-dt / decayTau);
      this.onLevel(this._level);
      if (this.ws) {
        this._rafId = requestAnimationFrame(tick);
      } else {
        this._rafId = 0;
        this.onLevel(0);
      }
    };
    this._rafId = requestAnimationFrame(tick);
  }

  stop() {
    const ws = this.ws;
    this._stopping = true;
    this.ws = null;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this._level = 0;
    this.onLevel(0);
    try { ws && ws.close(); } catch (_) {}
  }
}

class TTSPlayer {
  constructor({ onLevel, onActiveChange, outputDeviceIds, outputDeviceId } = {}) {
    this.onLevel = onLevel || (() => {});
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
    this._level = 0;
    this._rafId = 0;
    // Serialises sink reconfiguration against chunk playback. _applyDevices
    // tears down and rebuilds the analyser→destination connections across
    // multiple awaits (setSinkId, play); a playChunk landing mid-window would
    // schedule a BufferSource into a disconnected graph and play silently.
    // playChunk awaits this queue so chunks always see a fully-connected sink.
    this._applyDevicesQueue = Promise.resolve();
  }

  // Strip empties to a single '' (default), de-dupe, and keep order.
  static _normalizeIds(ids) {
    const seen = new Set();
    const out = [];
    for (const raw of (ids || [])) {
      const id = raw || '';
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  async ensureCtx() {
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
      try {
        await el.setSinkId(id || '');
      } catch (e) {
        // Requested device disappeared or was rejected. Fall back to the
        // system default for this sink so the session still produces audio.
        try { await el.setSinkId(''); resolvedId = ''; }
        catch (_) {
          try { this.analyser.disconnect(dest); } catch (_) {}
          el.srcObject = null;
          continue;
        }
      }
      try { await el.play(); } catch (_) {}
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
    const normalized = TTSPlayer._normalizeIds(ids);
    this.outputDeviceIds = normalized;
    if (!this.ctx) return;
    await this._applyDevices(normalized);
  }

  async setOutputDevice(deviceId) {
    await this.setOutputDevices([deviceId || '']);
  }

  async playChunk(base64Pcm) {
    await this.ensureCtx();
    // Wait for any in-flight sink reconfiguration before scheduling. The queue
    // is also awaited inside _applyDevices itself, so this is a no-op when the
    // graph is already settled.
    await this._applyDevicesQueue.catch(() => {});
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
      this._startMeter();
    }
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0) {
        this.nextStart = 0;
        this.onActiveChange(false);
      }
    };
  }

  _startMeter() {
    if (this._rafId) return;
    let last = performance.now();
    const decayTau = 0.1;
    const tick = () => {
      const now = performance.now();
      const dt = Math.max(0, (now - last) / 1000);
      last = now;

      // Sample the actual output, not the queued chunks.
      let peak = 0;
      if (this.analyser && this._analyserBuf) {
        this.analyser.getFloatTimeDomainData(this._analyserBuf);
        const buf = this._analyserBuf;
        for (let i = 0; i < buf.length; i++) {
          const a = buf[i] < 0 ? -buf[i] : buf[i];
          if (a > peak) peak = a;
        }
      }

      if (peak > this._level) this._level = peak;
      else this._level *= Math.exp(-dt / decayTau);

      this.onLevel(this._level);
      // Keep ticking while audio is scheduled OR still ringing out in the meter.
      if (this.sources.size > 0 || this._level > 0.005) {
        this._rafId = requestAnimationFrame(tick);
      } else {
        this._rafId = 0;
        this.onLevel(0);
      }
    };
    this._rafId = requestAnimationFrame(tick);
  }

  hush() {
    for (const s of this.sources) { try { s.stop(); } catch (_) {} }
    this.sources.clear();
    this.nextStart = 0;
    this._level = 0;
    this.onActiveChange(false);
    this.onLevel(0);
  }

  isActive() {
    return this.sources.size > 0 ||
           (this.ctx && this.nextStart > this.ctx.currentTime);
  }

  destroy() {
    this.hush();
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this._tearDownSinks();
    try { this.ctx && this.ctx.close(); } catch (_) {}
    this.outputNode = null;
    this.analyser = null;
    this._analyserBuf = null;
    this.ctx = null;
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

  // Restarts with new settings. Cheap no-op when deviceIds is empty.
  async update(micDeviceId, deviceIds) {
    if (!deviceIds || deviceIds.length === 0) {
      if (this.running) await this.stop();
      return;
    }
    await this.start(micDeviceId, deviceIds);
  }
}

window.LiveAudio = { AudioCapture, CompanionAudioCapture, TTSPlayer, MicPassthrough, abToBase64, canCaptureDisplayAudio, canSelectOutputDevice };
