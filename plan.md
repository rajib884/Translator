# Session Reconnect — Current Flow Analysis & Seamless Handoff Feasibility

## Context

`flow.md` in this repo already documents the "break-then-make" reconnect implementation and proposes a "Seamless Handoff (Make-before-break)" strategy as future work. Before committing to that proposal, this document maps the current flow precisely (code + docs) and assesses whether the proposed design is implementable given the current architecture.

**Question being answered:** Is the seamless handoff doable in this codebase as it stands today?

**Short answer:** Yes, but it requires touching three architectural seams that currently assume `session.client` is singular and stable. The change is contained — no new dependencies — but the seams are load-bearing.

---

## Current Flow (Code)

### GoAway → close → reconnect

| Step | Where | Notes |
|---|---|---|
| Server sends `goAway` | — | `timeLeft` field, e.g. `"5s"` |
| `_onMessage` handles it | `js/gemini-live.js:284-293` | Computes `delay = max(0, timeLeft*1000 - GOAWAY_SAFETY_MS)` (safety = 2000 ms) |
| State → `'reconnecting'` immediately | `js/gemini-live.js:288` | UI updates via `onState` callback |
| `_goAwayTimer` fires at deadline | `js/gemini-live.js:290-292` | Calls `ws.close(1000, 'goaway')` — clean close |
| `_onClose` fires | `js/gemini-live.js:296-349` | Clean close = 250 ms backoff; non-clean = exponential 1.5 s × 2^attempts, jitter ±10%, cap 30 s |
| `_connect()` re-runs | `js/gemini-live.js:154-182` | Builds new WS with same `apiKey` + most recent `resumeHandle` |
| `setupComplete` arrives | `js/gemini-live.js:244-252` | State → `'connected'`, `_reconnectAttempts = 0` |

**Real user-perceived gap:** WS close → next `setupComplete` ≈ 450–750 ms on a healthy network. During this window `sendAudio` early-returns (lines 351-353); captured PCM is dropped.

### `resumeHandle` lifecycle

| Where | What |
|---|---|
| `js/gemini-live.js:112` | Constructor accepts `resumeHandle` |
| `js/gemini-live.js:218` | Sent to server in `setup.sessionResumption` if non-null |
| `js/gemini-live.js:276-282` | `sessionResumptionUpdate` → `this.resumeHandle = u.newHandle`; fires `onResumeHandle` callback |
| `js/app.js:2805-2807` | Callback persists into `session.resumeHandle`, triggers `saveSessions()` |
| `js/app.js:2941` | On stop, copies final handle back to session |

**Implication for handoff:** the handle is updated continuously during a session. Any Shadow client instantiated at T=0 with handle H1 may be stale at T+1 s when Active has H2. Must address staleness explicitly.

### Audio capture → client (the hot path)

```
worklet → AudioCapture.onChunk → sendAudioGated(session, buf) → session.client.sendAudio(buf)
```

- `js/app.js:2350-2358` — `createAudioCapture` wires the worklet's `onChunk` to `sendAudioGated`.
- `js/app.js:2332-2348` — `sendAudioGated` reads `session.client` on every chunk (~10/sec) and gates on `paused / muteInput / pttMode / _swappingCapture`.
- **Critical assumption:** `session.client` is a single stable instance per session. There is no per-chunk demux.

### TTS audio (client → speakers)

```
client.onAudio(b64)
  → state.ttsCoordinator.enqueueChunk(session, b64)
    → entry.player.playChunk(b64)            // if this session owns the speaker slot
    OR entry.buffered.push(b64)              // otherwise queue
```

- `js/app.js:2810` — `onAudio` callback bridge.
- `js/app.js:365-388` (`TTSCoordinator.enqueueChunk`) — assumes one client per session id.
- First chunk of turn sets `session.muteInput = true`, requesting the speaking slot.

**Critical assumption:** Exactly one `onAudio` stream per session. Two clients firing into the same session id would double-queue.

### Transcript flow

```
client.onInputChunk(text)  → session.pendingInput  += text → scheduleFlush(session)
client.onOutputChunk(text) → session.pendingOutput += text → scheduleFlush(session)
client.onTurnComplete()    → finalizeTurn(session)
```

- `js/app.js:2527` `scheduleFlush` → rAF → `flushPending` → mutates `session.liveTurn` DOM nodes.
- **Critical assumption:** Single emitter of chunks per session. Two clients would interleave text into the same `pendingInput` buffer and both call `finalizeTurn` (which nulls `liveTurn` — second call no-ops, but DOM may already be corrupted).

### Multi-session

- `MAX_SESSIONS = 3` (`js/app.js`). Each session has its own client/capture/player.
- `state.ttsCoordinator` (global) orchestrates "who speaks" across sessions.
- Reconnect on one session never touches siblings today. A handoff design must preserve that isolation.

### Test hooks (already in place)

- `simulateGoAway(timeLeftSec)` — `js/gemini-live.js:395-408`. Injects a synthetic `goAway` and runs the unmodified handler.
- `forceCloseWebSocket(code, reason)` — `js/gemini-live.js:414-423`. Non-1000 close to exercise the reconnect ladder.
- Wired to Log-sheet dev buttons — `js/app.js:4218`.

These provide a ready-made testbed for any handoff implementation.

---

## What the Docs Say

### Google's docs (`Documentation/*.md`)

- `Session management with Live API.md:21-22` — confirms `goAway` semantics with `timeLeft`.
- `Session management with Live API.md:56-106` — resumption flow; tokens valid 2 hours after last termination.
- `Live API best practices.md:91-92` — *recommends* using `sessionResumption` and `timeLeft` to "gracefully wrap up or reconnect" — but **does not prescribe** make-before-break. Google's docs assume serial reconnect.

### Repo docs

- `README.md:47-55` — high-level state machine: `idle → connecting → connected → error → reconnecting`. Single client per session.
- `flow.md:61-95` — **already proposes the exact Seamless Handoff design** under "Proposed Improvements." Covers parallel init, quiet-point detection (silence + turn-complete), forced-handoff fallback, and resource-usage notes.
- `todo2.md` — prior audit; does not flag this area.

The proposed design is therefore already documented at the high level. This analysis confirms whether the codebase can *execute* it.

---

## Feasibility Verdict: **Yes, doable**

Three architectural seams need explicit updates. None require new dependencies. All have well-defined contracts.

### Seam 1 — `sendAudioGated`'s `session.client` read

**Today:** Reads `session.client` per chunk. One client per session.
**Change needed:** Distinguish "active for input" client from "the client object the session knows about." During the handoff window, route input either:
- (a) atomically to a single `session.activeInputClient` reference that swaps at the switch moment, OR
- (b) to both clients briefly (broadcast) — rejected: doubles uplink at exactly the moment the network is worst.

Recommend (a): a single `activeInputClient` field, swapped atomically at the chosen quiet point.

### Seam 2 — TTSCoordinator's per-session assumption

**Today:** `enqueueChunk(session, b64)` assumes one source per session id. Two `onAudio` callbacks racing into the coordinator would double-play.
**Change needed:** Only the "active for output" client's `onAudio` should reach the coordinator. The Shadow client's `onAudio` must be ignored until promotion. Recommend a per-callback gate: `if (session.activeOutputClient !== this) return;` inside the bridge.

The switch flips both `activeInputClient` and `activeOutputClient` atomically.

### Seam 3 — Transcript chunk multiplexing

**Today:** `onInputChunk` / `onOutputChunk` append directly to `session.pendingInput` / `session.pendingOutput`. `onTurnComplete` calls `finalizeTurn`.
**Change needed:** Same client-gate pattern. Only the promoted client's chunks should land in the active live turn. If a forced handoff happens mid-turn, call `finalizeTurn(session)` on the old client before promoting Shadow, so the Shadow's first chunk starts a fresh `liveTurn`.

### Other things to handle (not seams, but specifics)

- **`resumeHandle` staleness** — instantiate Shadow eagerly with current handle. If a new `sessionResumptionUpdate` arrives on Active before promotion, store the latest on the session; at promotion, if Shadow is still pre-`setupComplete`, abort and fall back to break-then-make.
- **Shadow init failure** — if Shadow's `setupComplete` doesn't arrive by `deadline - safety - 300 ms`, abort handoff. Original `_goAwayTimer` already fires `close(1000)` — falls through to today's path.
- **Quiet-point inputs** — already available locally:
  - "User silent" ≈ no `inputChunk` for ≥ 300 ms (or local LevelMeter peak < threshold).
  - "Model silent" ≈ `state.ttsCoordinator.currentSpeakerId !== session.id` OR `session.player.isActive() === false`.
- **Overlapping GoAways** — guard: at most one Shadow per session. If a second `goAway` arrives during a handoff window, ignore until done.
- **Per-session isolation** — Shadow lives inside the session object as `session.shadowClient`. No cross-session leakage.

---

## Critical Files to Modify

| File | What changes |
|---|---|
| `js/gemini-live.js` | No structural changes. `GeminiLiveClient` stays single-WS. Add a `clone()` method that returns a new instance with the same options + current `resumeHandle`. Existing `simulateGoAway` continues to work. |
| `js/app.js` (session lifecycle) | Add `session.shadowClient`, `session.activeInputClient`, `session.activeOutputClient`. Refactor `sendAudioGated` to read `activeInputClient`. Wrap `onAudio` / `onInputChunk` / `onOutputChunk` / `onTurnComplete` callbacks with a client-identity gate. |
| `js/app.js` (handoff state machine) | New helpers: `beginShadowHandoff(session)`, `promoteShadow(session)`, `abortHandoff(session)`. Hook `beginShadowHandoff` from the client's `onState('reconnecting')` triggered by a `goAway`. |
| `js/app.js` (quiet-point detection) | Reuse existing signals: `session.lastMicLevel`, `state.ttsCoordinator.currentSpeakerId`, `session.player.isActive()`. No new instrumentation needed. |

### Reusable existing utilities

- `LevelMeter` (`js/audio.js:15-68`) — already drives mic level; can inform quiet-point.
- `TTSCoordinator.isQueued/_maybeFinishSpeaking` (`js/app.js:391-460`) — already tracks "is this session speaking right now."
- `GeminiLiveClient.simulateGoAway` (`js/gemini-live.js:395-408`) — already wired to a UI button for testing.

No new abstractions needed. The change is additive: existing call sites keep working, new code adds the demux gates and state machine.

---

## Risks & Open Questions

1. **`resumeHandle` race window.** If Active receives a new handle while Shadow is mid-handshake, Shadow's setup payload is stale. Acceptable cost: model uses recent audio context to recover, may briefly hallucinate one turn. Document and accept, or add a "re-init Shadow on handle update" path (more code, marginal gain).
2. **Two WS + audio contexts per session.** Memory ~+50 KB per Shadow, network ~+1 KB/s of keepalive — negligible. The `MAX_SESSIONS = 3` × 2 = 6 concurrent WS upper bound is well within browser limits.
3. **Forced handoff cleanliness.** Cutting Active mid-turn: must call `finalizeTurn` and `state.ttsCoordinator.hush(session)` on Active before promoting. Skipping this leaves a half-rendered turn and stuck mute state.
4. **PIP visual state.** The PIP's `setEffectiveStatus` already handles `'reconnecting'` (warn-amber bg with stripe). During handoff window the user sees the reconnect color; on successful seamless promotion they see the color flip back to `connected` / `translating` without ever going through a visible gap. Already covered — no new PIP work needed.
5. **Testing.** `simulateGoAway` already exists; success criterion is "no audible gap when simulating GoAway during continuous TTS playback in PIP."

---

## Verification (end-to-end)

When this is implemented, validate by:

1. Open the app in browser, paste API key, start a session in audio mode.
2. Get the model talking continuously (ask it to recite something long).
3. Open the Log sheet, click **Simulate GoAway**.
4. **Expected:** PIP status pill flips to `Reconnecting` briefly but TTS audio playback remains uninterrupted. The chip color shifts amber → blue without ever stalling.
5. Open Log sheet again, click **Force-close WS** mid-turn (no GoAway warning).
6. **Expected:** Brief gap (this is the forced-close path with no resume preparation), but the live turn finalizes cleanly and the next turn starts fresh — no stuck "Speaking" state.
7. Repeat (3)–(4) while user is mid-utterance (talk continuously).
8. **Expected:** Forced handoff fires at deadline; brief cut in input audio but transcript continues on the next turn.

Manual verification only; no new automated tests required (the project has no test harness today).

---

## Recommendation

**Approve as buildable.** The proposed design in `flow.md:61-95` is implementable against the current architecture with contained changes (one method on `GeminiLiveClient`, three new fields on `session`, callback gates in `app.js`). The pre-existing `simulateGoAway` test hook makes verification straightforward.

Before coding, resolve:
- **R1:** Stale `resumeHandle` policy — accept staleness, or re-init Shadow on handle updates. **Recommendation:** Accept staleness; the resume window is short (< 5 s typical).
- **R2:** Exact quiet-point thresholds — propose silence ≥ 300 ms OR ≥ 500 ms after last input chunk. Tune by ear.
- **R3:** Whether to expose a user setting for "disable seamless handoff" — recommend no, it should just work; revisit if regressions surface.
