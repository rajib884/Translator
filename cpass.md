# Audio Pass-through Process Flow

This report traces the audio pass-through pipeline in the Windows companion app
(under [companion/windows/src/](companion/windows/src/)). The pass-through engine
multiplexes one or more audio **sources** (microphone capture, system / per-PID
loopback) into one or more audio **sinks** (WASAPI render endpoints), all
driven by a browser-side WebSocket session at `/passthrough`.

## 1. Entry Point — HTTP → WebSocket Upgrade

- File: [http_router.cpp:156-170](companion/windows/src/http_router.cpp#L156-L170)
- The browser opens `ws://localhost:52341/passthrough`.
- `handle_client` completes the WebSocket handshake (101 Switching Protocols)
  and hands the upgraded socket to `passthrough_session_loop(sock)`.

## 2. WebSocket Frame Loop

- File: [passthrough_loop.cpp](companion/windows/src/passthrough_loop.cpp)
- `passthrough_session_loop` constructs a [`PassthroughSession`](companion/windows/src/passthrough_session.h#L24)
  bound to the socket, then enters a blocking `recv` loop that:
  - Parses each WebSocket frame header (FIN, opcode, mask, length).
  - Handles control frames: `0x8` close → break, `0x9` ping → reply with pong,
    `0xA` pong → ignore.
  - For text frames (`0x1`):
    - `action == "configure"` → `session.configure(payload)` (the heart of the
      reconfigure path, see §3).
    - `action == "stop"` → breaks out and tears the session down.
  - Between frames it calls `session.emit_level_if_due()` to push a level meter
    event to the browser.
- On exit, `session.shutdown()` joins all worker threads.

## 3. `PassthroughSession::configure` — Diff & Reconcile

- File: [passthrough_session.cpp:853-983](companion/windows/src/passthrough_session.cpp#L853-L983)
- The browser sends a flat JSON payload containing:
  - `sinks` — array of WASAPI render endpoint IDs the user wants audio routed to.
  - `micLabel` / `micId` — chosen capture endpoint (label is fuzzy-matched against
    WASAPI friendly names; `micId` takes precedence).
  - `pid` — non-zero means per-process loopback for that PID.
  - `loopback` — bool requesting system-wide loopback (default render device).
- `configure` **diffs** the requested config against the session's live state:
  - **Sinks:** existing sinks no longer in `wantedSinks` are marked
    `alive = false`, moved out of `sinks`, and joined outside `sinksMu`. New
    sinks have a `PtSink` allocated and a `sink_render_thread` launched
    (see §6).
  - **Mic source:** if presence or endpoint changed, the running thread is
    stopped (`micAlive = false; join`) and (if still wanted) `mic_source_thread`
    is relaunched.
  - **Loopback source:** same diff logic on (`haveLoopback`, `pid`).
- Finally `send_event_ready(...)` sends `{event:"ready", sinks, mic, loopback}`
  back to the browser.

## 4. Mic Source Thread

- File: [passthrough_session.cpp:160-344](companion/windows/src/passthrough_session.cpp#L160-L344)
- Resolves the capture endpoint by ID → label fuzzy match → default `eCapture/eCommunications`
  as final fallback (browsers sometimes hand over an empty label until permission
  is granted).
- Activates `IAudioClient` in **shared mode** with `AUDCLNT_STREAMFLAGS_EVENTCALLBACK`,
  2 s buffer, and the device's native mix format.
- Promotes the thread via `AvSetMmThreadCharacteristicsW(L"Audio", ...)` for
  realtime scheduling, then `client->Start()`.
- Capture loop:
  1. `WaitForSingleObject(event, 200)` — blocks on WASAPI's buffer-ready event.
  2. `GetNextPacketSize` / `GetBuffer` pull a packet of raw PCM frames.
  3. Per frame: convert each sample to `float` via [`sample_to_float`](companion/windows/src/audio_format.h),
     producing two `std::vector<float>` channels. Mono input is duplicated to both channels.
  4. [`StereoResampler::process`](companion/windows/src/stereo_resampler.h) linearly
     resamples from the device's native rate to **48 kHz stereo float** (the
     internal mix-bus rate `kPtMixRate`).
  5. Peak across the resampled chunk is fed into `update_peak()` (level meter).
  6. `distribute_logged("mic source", frame, outL, outR, n, verbose)` fans the
     samples out to every active sink's ring buffer (see §5).
  7. `frame += n` — a per-source monotonic frame counter used as the absolute
     mix position.

## 5. Loopback Source Thread

- File: [passthrough_session.cpp:346-594](companion/windows/src/passthrough_session.cpp#L346-L594)
- Two activation paths:
  - **`pid != 0` (per-process loopback):** `ActivateAudioInterfaceAsync` with
    `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` and
    `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`. Activation is async,
    so a [`ActivationHandler`](companion/windows/src/activation_handler.h)
    signals an event on completion; the format is hard-coded to **float32
    stereo 48 kHz** (matches the mix bus, so resampling is a no-op).
  - **`pid == 0` (system loopback):** open the default render endpoint and
    `Initialize(... AUDCLNT_STREAMFLAGS_LOOPBACK ...)`. Format comes from
    `GetMixFormat`, so the resampler is engaged for non-48k devices.
- The capture loop is identical to the mic loop: wait on the buffer event,
  pull packets, convert to float, resample, distribute.

## 6. Distribute — Source → All Sinks

- File: [passthrough_session.cpp:97-118](companion/windows/src/passthrough_session.cpp#L97-L118)
- `distribute(startFrame, L, R, n)` takes `sinksMu` and calls
  `sink->ring.mixIn(startFrame, L, R, n)` on every alive sink.
- `distribute_logged(...)` wraps it with bracketing `dlog()` lines so a crash
  inside `mixIn` or while acquiring `sinksMu` leaves a breadcrumb trail.
- Each source has **its own** `frame` counter starting at 0 when the thread
  launches; mild drift between sources is absorbed by the 1-second ring slack.

## 7. Per-Sink Ring Buffer

- File: [pt_ring.cpp](companion/windows/src/pt_ring.cpp), [pt_ring.h](companion/windows/src/pt_ring.h)
- Each `PtSink` owns a `PtRing` (1 second of slack at 48 kHz stereo float, see
  `kPtRingFrames = 48000`).
- `mixIn(startFrame, inL, inR, n)`:
  - Drops samples whose `startFrame + n <= readFrame` (entirely stale).
  - If `startFrame < readFrame`, trims the input head.
  - Caps anything past `readFrame + kPtRingFrames`.
  - **Mix-adds** (`L[idx] += inL[i]`) into the circular buffers, advancing
    `writeFrame` if needed. This is what allows multiple sources to share a
    single sink — the mic and loopback streams sum together.
- `consume(outL, outR, n)`:
  - Drains up to `n` frames from `readFrame` forward; clamps to ±1.0; **zeroes
    the cells** it consumes so the next mix starts fresh.
  - Pads with silence on underrun, always advances `readFrame` by `n`.

## 8. Sink Render Thread

- File: [passthrough_session.cpp:596-851](companion/windows/src/passthrough_session.cpp#L596-L851)
- Opens the chosen render endpoint by WASAPI ID, activates `IAudioClient` in
  shared mode with `AUDCLNT_STREAMFLAGS_EVENTCALLBACK`, ~100 ms buffer, native
  mix format. `IAudioRenderClient` is queried for `GetBuffer`/`ReleaseBuffer`.
- **Prefills** the entire buffer with silence (`AUDCLNT_BUFFERFLAGS_SILENT`)
  before `client->Start()` so the device-side clock starts cleanly.
- Render loop (event-driven, ratio `kPtMixRate / out_rate`):
  1. `WaitForSingleObject(event, 200)` — wakes on buffer drain.
  2. `GetCurrentPadding` → compute `free` frames available in the device buffer.
  3. `render->GetBuffer(free, &buf)` to acquire the writable region.
  4. **Refill the persistent `mixBufL/R` buffer** by calling
     `sink->ring.consume(...)` for `ceil(rsPos + free*ratio) + 2` samples (with
     a `+2` slack for FP rounding). Unconsumed leftovers stay for next call —
     this fixes the periodic-click bug that came from a single-sample carry.
  5. **Linear-interp resample** mix-rate (48 kHz stereo) → `out_rate`:
     - For each of `free` output frames, interpolate between
       `mixBuf[floor(rsPos)]` and `mixBuf[floor(rsPos)+1]` using `frac = rsPos - floor(rsPos)`.
     - Write into the device buffer as `float32` (when `is_float && bits==32`)
       or `int16` (with clamping). Extra channels beyond stereo get zeros.
       Unknown formats fall back to silence.
     - Advance `rsPos += ratio`.
  6. Drop `floor(rsPos)` samples from the front of `mixBufL/R`; the residual
     fraction in `rsPos` is preserved for the next call (no click at chunk
     boundaries).
  7. `render->ReleaseBuffer(written, written == 0 ? SILENT : 0)`.
- On `sink->alive = false` (set by `shutdown()` or `configure()` dropping the
  sink), the loop exits and releases all WASAPI resources.

## 9. Level Metering Side-Channel

- File: [passthrough_session.cpp:25-35, 68-75](companion/windows/src/passthrough_session.cpp#L25-L75)
- A `levelThread` runs from the moment the session is constructed. Every ~80 ms
  it reads the atomic `peakLevel`, swaps it to 0.0, and sends
  `{event:"level", peak:...}` to the browser.
- Source threads (mic + loopback) update `peakLevel` via `update_peak()`
  (lock-free CAS, max-write semantics).

## 10. Shutdown Sequence

- File: [passthrough_session.cpp:38-60](companion/windows/src/passthrough_session.cpp#L38-L60)
- Triggered by WS close, "stop" action, or `~PassthroughSession()`.
- Steps:
  1. `running.exchange(false)` (idempotent guard).
  2. Flag `micAlive = false`, `loopbackAlive = false`.
  3. Under `sinksMu`, flag every sink `alive = false`, move them out into a
     `drained` vector, clear `sinks`.
  4. Join `micThread`, `loopbackThread`, every drained `sink->thread`, then
     `levelThread`.

## Threading & Data-Flow Summary

```
  Browser (WS /passthrough)
      │  JSON: {action:"configure", sinks, micLabel, micId, pid, loopback}
      ▼
  passthrough_session_loop  ── WS handler thread
      │
      ▼
  PassthroughSession::configure
      ├─► spawns / kills mic_source_thread        ─┐
      ├─► spawns / kills loopback_source_thread   ─┤   (each:
      └─► spawns / kills N × sink_render_thread    │    WASAPI capture
                                                   │    → sample_to_float
                                                   │    → StereoResampler → 48k stereo float
                                                   │    → distribute → for each sink:
                                                   │         PtRing.mixIn (mix-add @ absolute frame))
                                                   ▼
                            ┌────────── per-sink PtRing (1 s, 48k stereo float) ──────────┐
                            │                                                              │
                            ▼                                                              │
            sink_render_thread (WASAPI event-driven)                                       │
              PtRing.consume → linear resample 48k → device rate →                         │
              GetBuffer / write float32 or int16 / ReleaseBuffer                           │
                                                                                           │
                          levelThread ── peakLevel (atomic) ── {event:"level"} → browser ──┘
```

## Key Invariants

- **Mix rate is fixed at 48 kHz stereo float** (`kPtMixRate`, `kPtMixChans`).
  Sources always resample up to it; sinks always resample down from it.
- **Mixing is by absolute frame position**, not append. Each source maintains
  its own monotonic `frame` counter; sinks' rings use it as the index modulo
  `kPtRingFrames`. Multiple sources are summed via `+=` in `PtRing::mixIn`.
- **Sources and sinks are fully decoupled.** Sources push at WASAPI capture
  cadence; sinks pull at WASAPI render cadence. The ring's 1 s of slack absorbs
  short-term drift between them.
- **Sink thread is the only consumer of its own ring.** `mu` inside `PtRing`
  serialises producers (multiple sources) against the single consumer.
- **`sinksMu` is held only briefly** during configure-time diff and during the
  fan-out in `distribute`. The render thread never takes `sinksMu`.
- **All WASAPI threads are MMCSS-promoted** via `AvSetMmThreadCharacteristics(L"Audio")`.
