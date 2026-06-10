# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

Pure-client browser app (`index.html` + `css/` + `js/`) that talks directly to Google's Gemini Live WebSocket API, plus an optional Windows-only native companion (`companion/windows/`, C++) that provides per-app audio loopback, multi-sink passthrough, and a global push-to-talk hook. **No backend, no bundler, no transpilation.** `js/audio.js`, `js/gemini-live.js`, and `js/app.js` load via deferred `<script>` tags (`js/pip.js` is lazy-loaded on first Pop-out click); cross-file globals hang off `window.LiveAudio` and `window.GeminiLive` (plus the bare `PipController` class once pip.js loads); `app.js` is the implicit entry point.

`ARCHITECTURE.md` is the authoritative deep-dive map (sessions, TTS coordinator, GoAway handoff, reconnect ladder, native protocol, load-bearing invariants). Consult it before non-trivial changes — section §12 lists invariants that look innocent but break things silently. It's a restored snapshot of an older `dev` HEAD (see its header note for known drift); trust its structure and invariants, not its line numbers.

## Running the web app

The web app works directly from `file://`, but for iterating in a browser the repo ships a no-cache static server:

```bash
python serve-nocache.py            # serves cwd on :8000
python serve-nocache.py path/      # serves a specific dir
```

There is no build step, lint config, or JS test harness for the web client. Verification of UI behavior is manual — the Log sheet exposes `Simulate GoAway` and `Force-close WS` test hooks (`GeminiLiveClient.simulateGoAway` / `forceCloseWebSocket`) for exercising the reconnect/handoff paths without waiting for the server.

## Building & testing the Windows companion

Sources in `companion/windows/src/`, headers in `companion/windows/include/` (added to the lib's `PUBLIC` include dirs by CMake; `make.bat` passes `-Iinclude`). Split into ~20 translation units, all compiled into a static lib `live-translator-lib` that both the exe and the test binary link against (see `CMakeLists.txt`).

**CMake (Visual Studio / Ninja / MinGW):**
```powershell
cd companion\windows
cmake -S . -B build
cmake --build build --config Release
.\build\Release\live-translator-companion.exe     # MSVC layout
.\build\live-translator-companion.exe             # single-config layout
```

**MinGW one-shot (hardcoded path in script):** `companion\windows\make.bat [console]` — pass `console` to build a console-subsystem exe so `dlog()` mirrors to stdout.

**Console build via CMake:** `-DCONSOLE_BUILD=ON` toggles `WIN32` off and defines `CONSOLE_BUILD`.

**Unit tests (GoogleTest, fetched via FetchContent):**
```powershell
cmake -S . -B build_tests -DBUILD_TESTS=ON
cmake --build build_tests
ctest --test-dir build_tests --output-on-failure
# or run a single test directly:
.\build_tests\Release\live-translator-tests.exe --gtest_filter=PtRingTest.*
```

**Integration tests (Python, spin up the real exe on :52341):**
```bash
cd companion/windows/tests/integration
pip install -r requirements.txt
pytest                                 # finds the exe via COMPANION_EXE env, then build_tests/, build/, live_translator.exe
COMPANION_EXE=/path/to/exe pytest test_passthrough_ws.py::test_name
```
Port 52341 is hardcoded (`include/constants.h`); there is no CLI flag to override it. Don't run integration tests while another companion instance is bound to that port.

## Architecture orientation (skim, then read `ARCHITECTURE.md`)

### Three concurrency surfaces in the web app

Knowing which one is in play is the key to reading `js/app.js` (5k+ lines):

1. **Per-session audio pipeline** — `Session` object owns its `client` (`GeminiLiveClient`), `capture` (`AudioCapture` or `CompanionAudioCapture`), `player` (`TTSPlayer`), and `micPassthrough` (`CompanionPassthrough`). Up to `MAX_SESSIONS = 3` run concurrently.
2. **`TTSCoordinator`** (`js/app.js` §4.2) — global arbiter for "who's speaking." Multiple sessions translate in parallel but share the user's ears: one `currentSpeakerId` at a time, others buffer until promoted. `enqueueChunk` assumes **one `onAudio` stream per session id** — violating that double-plays.
3. **GoAway → resume handoff** (`js/gemini-live.js`) — server sends `goAway { timeLeft }`; the client waits for the *next* resumable `sessionResumptionUpdate` before closing, then reconnects with that handle. Closing on the deadline directly causes audio replay or stuck turns.

### Load-bearing invariants (§12 of ARCHITECTURE.md — full list there)

These are easy to break silently:

- `session.client` is **singular and stable** for a session's lifetime. `sendAudioGated` reads it on every chunk. Any handoff design needs an `activeInputClient` indirection.
- Exactly one emitter of `onInputChunk` / `onOutputChunk` per session — two would corrupt `pendingInput` / `pendingOutput` and the live-turn DOM.
- `_onMessage` in `gemini-live.js` is **synchronous on purpose** — an `await` lets the browser re-order frame delivery and breaks `setupComplete` / `turnComplete` sequencing. `binaryType = 'arraybuffer'` is downstream of this.
- `AudioCapture._abortStart` must run on every throw in `start` — leaks mic indicator + `AudioContext` otherwise.
- `session.muteInput` must be cleared by every code path that grabs the speaker slot (set true on first TTS chunk, cleared in `_maybeFinishSpeaking`, `unregister`, `hush`).
- `session._stopping` is one-shot — `stopSession` is reentrant from user click, WS close, display-share end, and page unload, sometimes concurrently.

### Persistence

Two localStorage keys, both written by best-effort `try/catch`:

- `live-translator-prefs` — cross-session UI defaults (API key, languages, voice, audio source, output device list, prompt template, PTT binding, PiP prefs, UI mode).
- `live-translator-sessions` — `{ sessions: [{ id, config, resumeHandle, history }], activeId }`, history capped to last 500 turns per session. Sessions beyond `MAX_SESSIONS` survive as `state.archivedSessions` and round-trip verbatim.

The API key lives in prefs by design — it survives reloads and is never sent anywhere but Google.

### Companion wire protocol (`companion/windows/`)

All on `127.0.0.1:52341`. Origin checks allow `null` (for `file://`), `localhost`, `127.0.0.1`; production hosts go in `LIVE_TRANSLATOR_ALLOWED_ORIGINS`.

| Endpoint | Purpose |
|---|---|
| `GET /status`, `/apps`, `/outputs` | Health, audible-process enumeration, WASAPI render endpoints |
| `WS /audio[?pid=N]` | 16 kHz mono PCM16 loopback — system default, or process tree of `pid` (needs Win10 build 20348+) |
| `WS /hotkey` | Global low-level keyboard hook for PTT; one binding per connection |
| `WS /passthrough` | Per-session capture+mix+multi-sink WASAPI render; configured via JSON, emits level frames ~12×/sec |

The browser's `/audio` capture and the `/passthrough` engine are **independent capture sessions** in the OS — under `audioSource = mic|companion` you'll see two mic indicators / two per-pid loopback activations on the same target. That's intentional, not a bug (isolates passthrough render from the browser's audio graph).

Passthrough sink IDs (WASAPI endpoint strings like `{0.0.0.00000000}.{guid}`) are a different ID space from the browser's `MediaDeviceInfo.deviceId` values — they don't interchange.

## Conventions to match

- **No external runtime deps** in the web app — uses native Web Audio, WebSocket, Fetch, AudioWorklet only. The worklet is loaded as a Blob URL so the app works from `file://`.
- **UI modes (`simple` / `mid` / `full`)** are gated purely by CSS (`.advanced-only`, `.full-only` + `data-ui-mode` body attribute). Mode switches *reset* the controls hidden by the new mode so nothing silently overrides defaults.
- **PiP window** is same-origin, so its buttons reuse the main control bar's start/stop/clear actions directly. It follows `state.pipFollowingSessionId`, which can differ from `state.activeSessionId` (it tracks the speaker when the TTS coordinator promotes a queue).
- **Retired UI stays as commented-out markup/JS**, not deleted — the Pause/Hush buttons (main bar and PiP) are commented out with `DEPRECATED` markers in case the feature returns. `TTSCoordinator.hush` and `session.paused` still exist in code; only their buttons are gone.

## Quick navigation (from ARCHITECTURE.md §15)

| Touching… | Start at… |
|---|---|
| WS protocol, reconnect, GoAway | `js/gemini-live.js` |
| Audio capture / playback / passthrough | `js/audio.js` |
| Session lifecycle | `js/app.js` — `startSession` / `stopSession` |
| Multi-session "who speaks" | `js/app.js` — `TTSCoordinator` |
| PiP | `js/pip.js` — `PipController` (lazy-load bootstrap: `loadPipModule` in `js/app.js`) |
| PTT browser side | `js/app.js` — `PttHotkeyClient` |
| Companion native code | `companion/windows/src/` for `.cpp`, `companion/windows/include/` for `.h` (entry: `src/main.cpp`, routing: `src/http_router.cpp`, passthrough: `src/passthrough_session.cpp`) |
