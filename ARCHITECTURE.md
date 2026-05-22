# Live Translator — Architecture Design

Snapshot of the `dev` branch (HEAD = `26c35b3`). Written as orientation for a
returning reader: where things live, what depends on what, which invariants are
load-bearing, and where the seams are.

> Source of truth for any field/line numbers is the code. Treat this document
> as a map, not as documentation that has been refreshed line-for-line.

---

## 1. Scope and shape

Live Translator is a **pure-client browser app** that talks directly to the
Google Gemini Live WebSocket API. Audio captured locally is streamed up as
16 kHz Int16 PCM; the model streams back 24 kHz PCM TTS plus input/output
transcripts. There is **no backend**; the only optional native component is the
Windows companion (`companion/windows`), which runs on localhost to provide
two things the browser cannot: per-app/system audio loopback, and a global
push-to-talk keyboard hook.

```
   ┌────────── browser (index.html, served from file:// or any origin) ──────────┐
   │                                                                             │
   │   ┌─────────────┐   ┌──────────────┐   ┌──────────────┐                     │
   │   │ AudioCapture│──▶│ GeminiLive   │──▶│ TTSPlayer    │──▶ speaker sinks   │
   │   │  / Companion│   │  Client (WS) │   │  (per session)│                    │
   │   │  Capture    │   │              │   └──────────────┘                     │
   │   └─────┬───────┘   └─────┬────────┘            ▲                           │
   │         │ PCM16            │ JSON envelopes      │ TTSCoordinator (global)  │
   │         ▼                  ▼                                                │
   │   MicPassthrough     transcript callbacks ──▶ DOM (live turn, history)      │
   │         │                                                                   │
   │         ▼                                                                   │
   │   virtual-cable sinks                                                       │
   │                                                                             │
   └────────────────────────────┬────────────────────────────────────────────────┘
                                │ WSS
                                ▼
                Gemini Live  (generativelanguage.googleapis.com)


  optional, localhost:
   ┌──────────────────────────────────────────────────────────┐
   │ companion/windows/live-translator-companion.exe          │
   │   GET  /status      service health                       │
   │   GET  /apps        JSON list of audible processes       │
   │   WS   /audio[?pid] 16 kHz mono PCM16 loopback           │
   │   WS   /hotkey      JSON bind + key-down/up events       │
   └──────────────────────────────────────────────────────────┘
```

---

## 2. File map

| Path | Lines | Role |
|---|---|---|
| [index.html](index.html) | 420 | Layout, semantic landmarks, sheet/modal scaffolding, control bar, session-tab strip. Three UI modes (`Basic / Advanced / Full`) gated purely by CSS classes (`.advanced-only`, `.full-only`). |
| [css/style.css](css/style.css) | 1122 | Mobile-first responsive theme; sidebar↔overlay, status pill colors, segmented controls, live meter visuals, dark palette. |
| [js/audio.js](js/audio.js) | 1056 | All audio plumbing: capture (mic+display), companion WS capture, TTS playback (multi-sink), mic passthrough mix, settings-panel input preview, shared LevelMeter. |
| [js/gemini-live.js](js/gemini-live.js) | 573 | Gemini Live WebSocket client. Setup payload, message dispatch, GoAway → resume handoff, exponential reconnect, backpressure, system-prompt templates. |
| [js/app.js](js/app.js) | 4704 | Everything else. Session model, TTSCoordinator, PTT client, PiP, persistence, UI wiring, lifecycle. |
| [companion/windows/src/main.cpp](companion/windows/src/main.cpp) | 1228 | Native HTTP + WS server. Default-render or per-PID loopback via WASAPI; global low-level keyboard hook for PTT. |
| [README.md](README.md) | 238 | User-facing readme. |
| [plan.md](plan.md) | 202 | Working analysis of seamless-handoff feasibility — not implemented, but the seams it identifies are real. |
| [Documentation/](Documentation/) | — | Vendored Google Live API docs (read-only reference). |

`js/` is loaded with three plain `<script>` tags — no bundler, no modules,
no transpilation. Cross-file globals are hung on `window.LiveAudio` and
`window.GeminiLive`; `app.js` is the implicit entry point.

---

## 3. Runtime data model

### 3.1 The Session object — [js/app.js:270-328](js/app.js#L270-L328)

Every translation pipeline is owned by a `Session`. The browser holds up to
`MAX_SESSIONS = 3` of them at once. Each session owns:

- **Config snapshot** (`session.config`): mutable while idle, frozen while
  running. Holds language pair, voice, mode (audio/text/transcribe), direction
  (bidir/oneway), audio source (mic/display/companion/both), VAD preset or
  custom values, PTT mode, output device list.
- **Runtime objects** (allocated by `startSession`, torn down by `stopSession`):
  - `client` — a `GeminiLiveClient` instance.
  - `capture` — `AudioCapture` or `CompanionAudioCapture`.
  - `player` — `TTSPlayer` for audio mode, `null` for text/transcribe.
  - `resumeHandle` — latest session-resumption token. Persisted to localStorage.
- **Transcript state**: `liveTurn` (in-progress DOM nodes), `pendingInput` /
  `pendingOutput` buffers, finalized `history[]`.
- **DOM handles**: tab chip, status bits, meter fills, transcript host.
- **Gates**: `paused`, `muteInput`, `pttHeld`, `_swappingCapture`, `_stopping`,
  `switching` — small booleans that gate the hot audio path.

Sessions are stored in `state.sessions: Map<id, Session>`. The
`state.activeSessionId` controls which session the chrome (status pill, control
bar, settings sidebar) reflects. Other sessions keep running fine in the
background; only the *display* is single-session.

### 3.2 The global `state` object — [js/app.js:676-748](js/app.js#L676-L748)

Singleton bag of cross-cutting state:

| Field | Purpose |
|---|---|
| `sessions` | All live sessions, keyed by id. |
| `activeSessionId` | Whose chrome we're showing. |
| `ttsCoordinator` | Global "who speaks" arbiter (see §4.2). |
| `micPassthrough` | One `MicPassthrough` shared across all sessions. |
| `inputPreview` | Lazy settings-panel mic visualizer. |
| `archivedSessions` | Saved sessions beyond `MAX_SESSIONS` — preserved on disk but not loaded. |
| `pipPrefs` | Display mode + font size for the PiP window. |
| `pttClient` | `PttHotkeyClient` (lazily created on first PTT use). |
| `pttBinding` | Currently bound vkCode + modifiers. |
| `pip` / `pipFollowingSessionId` | The PiP window controller and which session it follows. |
| `companionAvailable` / `companionApps` | Result of `/status` and `/apps` polls. |
| `resolvedMicDeviceId` | What the OS handed us for "System default" — used to relabel the dropdown. |
| `systemPromptTemplate` | User-saved prompt or `null` to use the mode-derived default. |
| `uiMode` | `simple` / `mid` / `full` — toggles which sections are visible. |

`saveSessions()` (sessions blob) and `savePrefs()` (UI prefs blob) are the
two write paths into localStorage:

- `live-translator-sessions` → `{ sessions: [...], activeId }`. Per-session:
  `id, config, resumeHandle, history` (capped to last 500 turns).
- `live-translator-prefs`    → global UI defaults including API key, languages,
  voice, default audio source, output device list, PTT binding, PiP prefs,
  VAD preset, system prompt template.

Both writes are best-effort (`try/catch` swallow). Restoration is the inverse:
older saves missing fields fall back to the current UI snapshot.

---

## 4. Concurrency model

There are three independent concurrency surfaces in the app and they don't
generally know about each other. Understanding which one is in play at a given
moment is the key to reading the code.

### 4.1 Per-session audio pipeline

For each running session, four async streams co-exist:

1. **Capture → WS uplink.** An AudioWorklet (or companion WS) produces
   PCM16 chunks at ~10/s. Each chunk passes through `sendAudioGated`
   ([js/app.js:2629-2645](js/app.js#L2629-L2645)) which checks `paused`,
   `muteInput`, `pttHeld`, `_swappingCapture` and may substitute a zero-filled
   buffer to keep the stream warm without feeding the model real audio. Then
   `GeminiLiveClient.sendAudio` base64-encodes and JSON-wraps the chunk and
   drops it on the WebSocket. **Backpressure**: if `ws.bufferedAmount >
   256 KB` the frame is dropped on the floor and a warning is logged.
2. **WS downlink → callbacks.** `_onMessage` dispatches synchronously
   ([js/gemini-live.js:286-455](js/gemini-live.js#L286-L455)). Synchronous on
   purpose: see the `binaryType = 'arraybuffer'` comment. An `await` here would
   let frames be re-ordered and break `setupComplete` / `turnComplete`
   sequencing.
3. **TTS playback.** `onAudio(b64)` flows into `TTSCoordinator.enqueueChunk`,
   which either plays it immediately on the session's `TTSPlayer` or buffers
   it until the session is promoted to "current speaker" (see §4.2).
4. **Transcript flow.** `onInputChunk` / `onOutputChunk` append to per-session
   `pendingInput` / `pendingOutput` strings. `scheduleFlush` defers DOM updates
   to the next `requestAnimationFrame` so multiple chunks per frame collapse
   into one DOM write. `onTurnComplete` triggers `finalizeTurn`, which freezes
   the live turn into history.

### 4.2 The TTS Coordinator — [js/app.js:335-508](js/app.js#L335-L508)

When multiple sessions are running, they translate concurrently but **must
not all speak simultaneously** — they share the user's ears. The coordinator
owns the "who's speaking" slot:

- `currentSpeakerId` — exclusive ownership of the speaker.
- `queue[]` — FIFO of sessions waiting their turn.
- `entries: Map<id, { player, buffered, wantsToSpeak, turnComplete, suppressed }>`.

The flow for one model turn:

```
chunk arrives → enqueueChunk(session, b64)
  if first chunk:
      wantsToSpeak = true
      session.muteInput = true     ◀── stops mic from feeding while we speak
      _requestSpeak(id):
          if slot free → become speaker
          else         → push onto queue, buffer chunks
  if currently speaker:
      player.playChunk(b64)
  else:
      buffered.push(b64)
```

When a session signals `turnComplete` AND its player drains (`isActive() ===
false`), `_maybeFinishSpeaking` releases the slot, clears `muteInput`, and
`_tryStartNext` promotes the next queued session, replaying its buffered
chunks.

`hush()` (the Silence button) is the exception path: it stops the player
mid-turn and sets `entry.suppressed = true` so any *more* chunks from the same
turn are dropped until the next `turnComplete` clears suppression — otherwise
the model's still-streaming audio would restart immediately.

**Critical invariant.** `enqueueChunk(session, ...)` assumes one source per
session id. Two `onAudio` streams firing into the same session id would
double-play. This invariant matters for the seamless-handoff design discussed
in [plan.md](plan.md).

### 4.3 The GoAway handoff — [js/gemini-live.js:386-413](js/gemini-live.js#L386-L413), [350-384](js/gemini-live.js#L350-L384)

Gemini sends `goAway { timeLeft: "Ns" }` before forcibly closing a session.
The client doesn't close immediately. It:

1. Records a deadline = `now + timeLeft - safety(2s)`.
2. Sets `_switching = true` (a *flag*, not a state — see comment) so the UI
   can show a continuous "Switching" hint without lying about the state pill.
3. Waits for the *next* `sessionResumptionUpdate` with `resumable=true`.
   That's the save-point we can resume from cleanly. Two close triggers:
   - **Urgent** (`< 5 s` left or deadline timer fires): close on whatever
     resumable handle we have, accept a possible mid-turn fragment.
   - **Clean** (≥ 5 s left and a `turnComplete` has fired *since* the GoAway):
     close on the next handle, ending at a turn boundary so the server doesn't
     get stuck in a `generationComplete`-without-`turnComplete` state.
4. On close, the reconnect ladder (§4.4) re-establishes with the saved handle.

This whole orchestration is the reason "break-then-make" exists in the code
today. `plan.md` documents the proposed seamless ("make-before-break") design
and the three architectural seams that would need to change to support it
(`sendAudioGated`, the coordinator's per-session assumption, transcript
multiplexing). It is **not** implemented; the file is design notes.

### 4.4 Reconnect ladder — [js/gemini-live.js:457-531](js/gemini-live.js#L457-L531)

```
WS close:
  ev.code = 1008 / 1011  →  fatal, stop, surface error
  ev.code = 1000         →  clean (our own goaway close), 250 ms backoff
  else                   →  exponential 1.5s × 2^attempts, ±10% jitter, cap 30s
                            give up after MAX_RECONNECT_ATTEMPTS = 8

  If close happened before setupComplete AND we had a resumeHandle:
      drop the handle (likely stale) so the next attempt starts fresh.
```

`_reconnectAttempts` is reset to 0 inside `setupComplete`, not `onopen` — only
a successfully *accepted* setup resets the failure budget.

### 4.5 Mid-session capture swap — [js/app.js:2696-2745](js/app.js#L2696-L2745)

When the user changes the mic dropdown mid-session, two captures briefly run
in parallel:

```
session._swappingCapture = true       ◀─ sendAudioGated → silence for both
new capture.start()
old capture.stop()
session.capture = new capture
session._swappingCapture = false
```

The gate exists so the model doesn't receive overlapping audio from two mics
for the ~tens of ms window between `start` and `stop`.

---

## 5. Audio path in detail

### 5.1 Capture sources

Three flavours, exposed under one UI selector:

| `audioSource` | Implementation | Browser support |
|---|---|---|
| `mic` | `getUserMedia({ audio })` → AudioWorklet → 16 kHz Int16 PCM. | All. |
| `display` | `getDisplayMedia({ video:true, audio:true })`, video track stopped immediately. | Chromium only. |
| `companion` | WebSocket to `ws://127.0.0.1:52341/audio[?pid=N]`. Native PCM16, no resample. | Any browser, requires companion .exe running. |
| `both` | mic + display, summed in Web Audio before the worklet. | Chromium only. |

The worklet ([js/audio.js:70-146](js/audio.js#L70-L146)) is the only DSP
implemented in JS. It does linear interpolation from the context rate to
16 kHz, peak-detects for the level meter, and posts back `audio` + `level`
messages over a `MessagePort`. It is loaded as a Blob URL so it works from
`file://`.

`AudioCapture._abortStart` ([js/audio.js:265-280](js/audio.js#L265-L280)) is
load-bearing: anything that throws mid-`start()` would otherwise leak a mic
indicator, an `AudioContext`, a `MediaStream`, or a Blob URL.

### 5.2 TTS playback (`TTSPlayer`) — [js/audio.js:423-677](js/audio.js#L423-L677)

24 kHz Int16 PCM arrives base64-encoded. Each `playChunk`:

1. Decodes to Float32, creates a `createBuffer(1, n, 24000)`.
2. Schedules a `BufferSource.start(at)` where
   `at = max(now + 40 ms lead-in, nextStart)`. Chunks butt up cleanly without
   gaps because each one extends `nextStart`.
3. Connects to an `AnalyserNode → outputNode` chain. The analyser exists so
   the level meter (`_sampleAnalyserPeak`) reflects what's currently coming
   out of the speakers, not what's been scheduled — otherwise the meter
   would fall to 0 the moment the model stopped streaming, even with seconds
   of audio still buffered.

**Multi-sink output.** `_applyDevices(ids)` creates one
`MediaStreamDestination` + `<audio>` pair per requested output device,
calling `setSinkId` on each. Failed setSinkIds fall back to system default;
totally failed devices are dropped and a warning is added. `_applyDevicesQueue`
is a serial promise queue so a `playChunk` can never schedule into a
half-torn-down sink graph.

### 5.3 Mic passthrough (`MicPassthrough`) — [js/audio.js:722-1015](js/audio.js#L722-L1015)

Independent of any session: routes the user's mic (and optionally each
session's tab/companion audio) to one or more output devices — typically a
virtual cable so the translated meeting audio + the user's spoken-input
arrives on the other side.

Single `_mixNode` (`GainNode`) is the shared mix bus. Sources connect *in*,
sinks connect *out*. `attachStream(key, stream)` registers a session's display
MediaStream into the mix; `attachPcm16(key, sampleRate)` returns a writer that
schedules companion PCM into the mix (same scheduling pattern as `TTSPlayer`).

Session attachments persist across passthrough on/off cycles via
`_attachedStreams` / `_attachedPcm` registries, so the user can toggle the
passthrough without breaking session audio routing.

### 5.4 Shared `LevelMeter` — [js/audio.js:15-68](js/audio.js#L15-L68)

Three independent rAF loops (capture / passthrough / TTS) all wanted the same
pattern: per-frame exponential decay (~100 ms time constant), peak from an
external push or an `analyser` sampler, smooth fade-out tail. Extracted into
one shared class so all three meters have identical behaviour.

---

## 6. Gemini Live wire protocol (as used here)

Endpoint: `wss://generativelanguage.googleapis.com/ws/.../BidiGenerateContent?key=…`
Model: `models/gemini-3.1-flash-live-preview` (native-audio; only `AUDIO`
response modality, not `TEXT`).

### Client → server

| Message | When |
|---|---|
| `setup`            | First message after `onopen`. Carries `model`, `generationConfig` (voice, MEDIA_RESOLUTION_MEDIUM, `responseModalities: ['AUDIO']`), `systemInstruction`, `inputAudioTranscription`, `outputAudioTranscription` (unless transcribe mode), `realtimeInputConfig` (auto VAD or `disabled` for PTT), `contextWindowCompression` (sliding window, 104 857 trigger / 52 428 target tokens), `sessionResumption` (with handle if resuming). |
| `realtimeInput.audio` | Every PCM chunk: `{ data: base64, mimeType: 'audio/pcm;rate=16000' }`. |
| `realtimeInput.activityStart` / `activityEnd` | Only when `manualActivity = true` (PTT). Brackets each utterance. |

### Server → client

`_onMessage` recognises these top-level fields ([js/gemini-live.js:447-454](js/gemini-live.js#L447-L454)):

`setupComplete`, `serverContent`, `toolCall`, `toolCallCancellation`, `goAway`,
`sessionResumptionUpdate`, `usageMetadata`. Anything else is logged as
"Unhandled server message field" so future protocol additions surface loudly
rather than going silently dropped.

Inside `serverContent`:

- `inputTranscription.text`  → `onInputChunk`
- `outputTranscription.text` → `onOutputChunk`
- `modelTurn.parts[].inlineData.data` → `onAudio` (TTS audio)
- `modelTurn.parts[].text` → `onOutputChunk` (defensive — text mode)
- `turnComplete` → `onTurnComplete` and may arm the GoAway renewal
- `interrupted`, `generationComplete`, `groundingMetadata`,
  `urlContextMetadata` are logged.

### System prompt templates — [js/gemini-live.js:31-65](js/gemini-live.js#L31-L65)

Three built-in templates, selected from (`mode`, `dir`):

| mode | dir | template |
|---|---|---|
| `audio` | `bidir` | `DEFAULT_SYSTEM_PROMPT_TEMPLATE` (bidirectional) |
| `audio` | `oneway` | `ONE_WAY_SYSTEM_PROMPT_TEMPLATE` |
| `transcribe` | * | `TRANSCRIBE_SYSTEM_PROMPT_TEMPLATE` (model stays silent; we use transcripts only) |
| `text` | * | falls back to default |

`renderSystemPrompt` substitutes `{source}` and `{target}` placeholders with
the language names. The user can override the template entirely via the
prompt editor sheet; `state.systemPromptTemplate = null` means "use the
mode-derived default".

---

## 7. Push-to-talk

Two halves:

- **Browser side**: `PttHotkeyClient` ([js/app.js:515-674](js/app.js#L515-L674))
  maintains the `/hotkey` WebSocket. Subscribers register `(onDown, onUp)`
  callbacks; on receiving `{ event: "down" | "up" }` from the companion, the
  client fans out to all subscribers. Modes: `hold` (down/up follow the
  physical key) and `toggle` (each physical key-down flips a virtual state).
- **Companion side**: a low-level Windows keyboard hook installed by
  [companion/windows/src/main.cpp](companion/windows/src/main.cpp). When PTT
  is bound with `exclusive: true`, the bound key is *consumed* — other apps
  don't see it. Modifier keys always pass through (so Ctrl/Shift/Alt as the
  binding only suppresses the *bound* key, not modifiers themselves).

When a session is in PTT mode (`config.pttMode === 'ptt'`), the Gemini client
is constructed with `manualActivity: true` (disables server VAD) and the PTT
callbacks send `activityStart` / `activityEnd`. Outside the held window,
`sendAudioGated` substitutes silence to keep the stream warm without feeding
the model.

---

## 8. Picture-in-Picture

`PipController` ([js/app.js:3724-4574](js/app.js#L3724-L4574)) opens a
same-origin secondary window via `documentPictureInPicture.requestWindow` (or
`window.open` as a fallback). Because it's same-origin, closures and callbacks
run in the *main* JS context — PiP buttons reuse the same start/stop/hush/clear
actions the main control bar uses.

The PiP follows `state.pipFollowingSessionId`, which can differ from the
active session (e.g. when the TTS coordinator promotes a queued session, the
PiP follows the speaker rather than the UI's selection — see
`TTSCoordinator.onSpeakerStart`). It mirrors: input/output transcript, status
pill colour and text, running/paused/audio flags. Layout is a single compact
header row with container-query-based responsive hiding (priority list
documented in CSS at [js/app.js:3934-3963](js/app.js#L3934-L3963)).

User-tunable state in the PiP (`displayMode`, `fontStep`) round-trips through
`onPrefsChange → state.pipPrefs → savePrefs` so a re-pop-out remembers.

---

## 9. UI mode gating

Three modes selected by buttons in the topbar — `simple`, `mid`, `full`. The
implementation is purely CSS: sections carry `.advanced-only` and/or
`.full-only` classes, the body has a `data-ui-mode` attribute, and the
selectors decide what's visible. Changing mode also *resets* the controls
hidden by the new mode (`resetFullOnlySettings`, `resetAdvancedSettingsForBasic`,
`resetFullSettingsForAdvanced`) so a user in simple mode never has hidden
settings silently overriding their defaults.

---

## 10. Persistence

Two localStorage keys:

| Key | Owner | Contents |
|---|---|---|
| `live-translator-prefs`    | `savePrefs()` / `loadPrefs()` | Cross-session UI defaults: API key, language pair, voice, default audio source, output device list, passthrough devices, mode/dir, prompt template, companion app pick, VAD preset+custom, UI mode, PTT binding, PiP prefs. |
| `live-translator-sessions` | `saveSessions()` / `loadSavedSessions()` / `restoreSessionsFromStorage()` | `{ sessions: [{ id, config, resumeHandle, history }], activeId }`. History capped to last 500 turns per session. |

If the saved sessions array exceeds `MAX_SESSIONS` (because a future build
raised the cap, then this one ran), the excess sessions become
`state.archivedSessions` — they don't appear in the UI but every
`saveSessions()` call writes them back verbatim, so they survive intact until
a slot frees up (`maybePromoteArchivedSession`).

The API key is in `prefs` — explicitly so it survives reloads. It is *never*
sent anywhere but Google.

---

## 11. Native companion service

[companion/windows/src/main.cpp](companion/windows/src/main.cpp) — a single
~1200-line C++ source.

| Endpoint | Notes |
|---|---|
| `GET /status` | Plain text; used as a liveness probe by the browser. |
| `GET /apps`   | Enumerates audio sessions on the default render device, groups by exe, returns lowest PID per group. Only apps *currently making sound* appear. |
| `WS /audio[?pid=N]` | Binary frames of 16 kHz mono PCM16 (≤ 100 ms each). With `pid`, uses `ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` and `INCLUDE_TARGET_PROCESS_TREE` to capture the process tree (so Chrome's many child processes are picked up via the parent PID). |
| `WS /hotkey`  | JSON. Client sends `{ action: "bind", vkCode, ctrl, shift, alt, win, exclusive }`. Companion installs a `WH_KEYBOARD_LL` hook and forwards `{ event: "down" }` / `{ event: "up" }`. One binding per connection. |

Per-app capture needs Windows 10 build 20348+; SDK-aware fallback declarations
let the source compile on older SDKs but the runtime requirement is the same.

Origin checks: `null` (for `file://`), `http(s)://localhost:*`, `127.0.0.1:*`
are allowed by default. Set `LIVE_TRANSLATOR_ALLOWED_ORIGINS` for production
hosts.

`kMaxConnections = 32` is a fork-bomb guardrail, not a throughput knob — the
audience is one localhost browser tab.

---

## 12. Load-bearing invariants (don't break these silently)

These are the implicit contracts that pieces of the app depend on. They live
in comments throughout the code; collected here so a returning reader can
spot a violation before it ships.

1. **`session.client` is singular and stable for the session's lifetime.**
   `sendAudioGated` reads it on every chunk. A future seamless-handoff
   implementation would need an `activeInputClient` indirection — see
   [plan.md](plan.md).
2. **Exactly one `onAudio` stream per session id.** `TTSCoordinator` would
   double-queue otherwise.
3. **Single emitter of `onInputChunk` / `onOutputChunk` per session.** Two
   would interleave into the same `pendingInput` / `pendingOutput` buffer and
   corrupt the live turn DOM.
4. **`_onMessage` is synchronous.** An `await` inside lets the browser
   re-order frame delivery, which breaks `setupComplete` / `turnComplete`
   sequencing. The `binaryType = 'arraybuffer'` choice is downstream of this.
5. **GoAway close fires at a resumable-handle moment, not the deadline
   directly.** Closing elsewhere causes audio replay or a stuck-turn on resume.
6. **`session.muteInput` must be cleared eventually.** `TTSCoordinator`
   clears it on `_maybeFinishSpeaking`, on `unregister`, and on `hush`. Any
   future code path that grabs the speaker slot must also release it.
7. **`AudioCapture._abortStart` runs on every throw in `start`.** Leaks the
   mic indicator + AudioContext otherwise.
8. **`TTSPlayer._applyDevicesQueue` and `MicPassthrough._writePcm16`
   short-circuit when the graph isn't fully wired.** Don't bypass the queue.
9. **`session._stopping` is one-shot per stop.** `stopSession` can be entered
   from a user click, a WS close, a display-share end, *and* page unload —
   sometimes concurrently. The guard makes it idempotent.

---

## 13. Testing hooks already in place

- `GeminiLiveClient.simulateGoAway(timeLeftSec)` — injects a synthetic GoAway
  through the unmodified handler. Wired to the **Simulate GoAway** button in
  the Log sheet ([js/gemini-live.js:579-593](js/gemini-live.js#L579-L593),
  [js/app.js:4218](js/app.js#L4218)).
- `GeminiLiveClient.forceCloseWebSocket(code, reason)` — non-1000 close to
  exercise the reconnect ladder. Wired to **Force-close WS** in the Log sheet,
  and to the **Force reconnect** button in the control bar (with a different
  reason string so the log distinguishes them).
- Log export / clear in the Log sheet.

There is no automated test harness. Verification is manual via these hooks.

---

## 14. Open work / known design directions

- **Seamless session handoff (make-before-break).** Documented in
  [plan.md](plan.md). Implementable; three architectural seams identified.
- **Per-process Windows capture in production.** The wire protocol supports
  it (`?pid=N`) and the native code implements it; the UI exposes the picker.
  Requires Windows 10 20348+.
- **`AudioWorklet` support on Safari.** Capture path uses AudioWorklet; older
  Safari versions are flagged in the README's browser-support table.
- **No tool-calling.** `toolCall` / `toolCallCancellation` are *received* and
  logged loudly but not handled; the setup payload never enables tools.

---

## 15. Quick navigation

| If you're touching… | Start at… |
|---|---|
| WS protocol, reconnect, GoAway | [js/gemini-live.js](js/gemini-live.js) |
| Audio capture / playback / passthrough | [js/audio.js](js/audio.js) |
| Session lifecycle | [js/app.js:3089-3365](js/app.js#L3089-L3365) (`startSession` / `stopSession`) |
| Multi-session "who speaks" | [js/app.js:335-508](js/app.js#L335-L508) (`TTSCoordinator`) |
| Per-session DOM, tab chip | [js/app.js:874-963](js/app.js#L874-L963) |
| Status pill / chip colours | [js/app.js:2747-2824](js/app.js#L2747-L2824) and `.pill-*` rules in [css/style.css](css/style.css) |
| PIP window | [js/app.js:3716-4574](js/app.js#L3716-L4574) (`PipController`) |
| PTT browser | [js/app.js:515-674](js/app.js#L515-L674) (`PttHotkeyClient`) |
| PTT companion (Windows hook) | [companion/windows/src/main.cpp](companion/windows/src/main.cpp) |
| Persistence | [js/app.js:1539-1658](js/app.js#L1539-L1658) |
| UI mode visibility | `requestUIModeChange` / `updateUIVisibility` in [js/app.js](js/app.js); `.advanced-only`, `.full-only` rules in CSS |
