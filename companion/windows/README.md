# Live Translator Companion for Windows

Headless localhost audio bridge for browsers that cannot capture app audio.

This service exposes:

- `GET /status` on `http://127.0.0.1:52341/status`
- `GET /apps` on `http://127.0.0.1:52341/apps` — JSON list of apps currently
  playing audio (one entry per executable, lowest PID seen).
- `GET /audio` WebSocket on `ws://127.0.0.1:52341/audio[?pid=N]`
  - No `pid` → default render-device loopback (everything you hear).
  - `pid=N`  → per-app loopback for that process **and its child processes**
    (handy for Chrome/Edge/Discord/etc., which spawn many helpers).
- `GET /hotkey` WebSocket on `ws://127.0.0.1:52341/hotkey` — global keyboard
  hook for push-to-talk. The web client sends a JSON bind message, the
  companion installs a low-level hook (works system-wide, even when the page
  is in the background), and forwards key-down / key-up events back as JSON.

The `/audio` WebSocket streams mono 16 kHz signed PCM16 frames, matching what
the web app already sends to Gemini.

### Push-to-talk wire format

Client → companion (JSON text frames):

```jsonc
{ "action": "bind", "vkCode": 32, "ctrl": false, "shift": false, "alt": false, "win": false }
{ "action": "unbind" }
```

`vkCode` is a Windows virtual-key code (e.g. `32` = Space, `0x70` = F1).
Modifier flags describe what must be held alongside the main key on press.

Companion → client (JSON text frames):

```jsonc
{ "event": "down" }   // bound combo just became pressed
{ "event": "up" }     // bound key just released
```

Only one binding per connection; multiple connections each maintain their own.

## Build

From a Visual Studio Developer PowerShell:

```powershell
cd companion\windows
cmake -S . -B build
cmake --build build --config Release
```

Run:

```powershell
.\build\Release\live-translator-companion.exe
```

With single-config generators such as Ninja/MinGW, the exe may be at:

```powershell
.\build\live-translator-companion.exe
```

The binary is built as a Windows-subsystem app, so it has no console window in
normal use.

## Capture modes

| URL                                  | Source                             |
|--------------------------------------|------------------------------------|
| `ws://127.0.0.1:52341/audio`         | Default render device loopback     |
| `ws://127.0.0.1:52341/audio?pid=N`   | Process `N` and its descendants    |

**Per-app capture requires Windows 10 build 20348 or newer (Windows 11
recommended).** It uses `ActivateAudioInterfaceAsync` with
`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` and
`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`, so picking the root PID is
enough — child processes (e.g. each Chrome tab/renderer) are captured too.

`/apps` enumerates the audio sessions on the default render device, groups them
by executable name, and returns the lowest PID for each group. Apps that aren't
actively playing audio won't appear; refresh after starting playback.

## Origin checks

By default the service allows common local development origins:

- `null` for `file://`
- `http://localhost:*`
- `https://localhost:*`
- `http://127.0.0.1:*`
- `https://127.0.0.1:*`

For a deployed page, set allowed origins before launch:

```powershell
$env:LIVE_TRANSLATOR_ALLOWED_ORIGINS="https://your-real-domain.com,https://www.your-real-domain.com"
.\build\Release\live-translator-companion.exe
```

## Wire format

Each WebSocket message is one binary frame of raw 16-bit little-endian PCM,
mono, 16 kHz, at most 100 ms per frame (1600 samples / 3200 bytes). Frames are
back-to-back; the client can concatenate them into a continuous stream.
