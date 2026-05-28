"""Integration tests that exercise the real WASAPI source/sink threads.

These run against the host's actual audio devices:
- Discover the default render endpoint via /outputs.
- Configure /passthrough with that endpoint as a sink and the system
  loopback as a source.
- Verify the threads come up and the level ticker keeps emitting while they
  run (catches deadlocks in sinksMu, send-path stalls, source-thread join
  hangs, etc.).
- Verify clean shutdown with all WASAPI threads active.
- Optional audible test (gated on LIVE_TRANSLATOR_AUDIBLE) plays a tone and
  asserts the loopback source's peak rises above the silence floor.

Skipped automatically when the host has no render endpoints.
"""
import asyncio
import json
import math
import os
import struct
import tempfile
import winsound
from pathlib import Path

import pytest
import requests
import websockets


async def _recv_event(ws, name, timeout=3.0):
    loop = asyncio.get_event_loop()
    end = loop.time() + timeout
    while True:
        remaining = end - loop.time()
        if remaining <= 0:
            raise asyncio.TimeoutError(f"timed out waiting for event={name!r}")
        msg = await asyncio.wait_for(ws.recv(), timeout=remaining)
        data = json.loads(msg)
        if data.get("event") == name:
            return data


async def _collect_events(ws, name, duration):
    out = []
    loop = asyncio.get_event_loop()
    end = loop.time() + duration
    while True:
        remaining = end - loop.time()
        if remaining <= 0:
            break
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except asyncio.TimeoutError:
            break
        data = json.loads(msg)
        if data.get("event") == name:
            out.append(data)
    return out


def _default_render_endpoint_id(base_url, origin):
    r = requests.get(f"{base_url}/outputs", headers={"Origin": origin})
    body = r.json()
    outputs = body.get("outputs", body)
    if not outputs:
        return None
    for o in outputs:
        if isinstance(o, dict) and o.get("isDefault"):
            return o.get("id")
    first = outputs[0]
    return first.get("id") if isinstance(first, dict) else first


def _sine_wav_bytes(freq_hz=1000, duration_s=1.0, rate=44100, amplitude=0.3):
    n = int(rate * duration_s)
    body = bytearray(n * 2)
    for i in range(n):
        s = int(amplitude * 32767 * math.sin(2.0 * math.pi * freq_hz * i / rate))
        struct.pack_into("<h", body, i * 2, s)
    header = (
        b"RIFF" + struct.pack("<I", 36 + len(body)) + b"WAVE"
        + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
        + b"data" + struct.pack("<I", len(body))
    )
    return bytes(header + body)


@pytest.fixture
def real_render_endpoint(base_url, localhost_origin):
    ep = _default_render_endpoint_id(base_url, localhost_origin)
    if not ep:
        pytest.skip("no render endpoints available on this host")
    return ep


async def test_real_render_endpoint_appears_active_in_ready(
    ws_url, localhost_origin, real_render_endpoint
):
    async with websockets.connect(
        f"{ws_url}/passthrough", origin=localhost_origin
    ) as ws:
        await ws.send(json.dumps({
            "action": "configure",
            "sinks": [real_render_endpoint],
        }))
        ready = await _recv_event(ws, "ready")
        assert real_render_endpoint in ready["sinks"]


async def test_system_loopback_source_runs_alongside_sink(
    ws_url, localhost_origin, real_render_endpoint
):
    """Level events keep flowing while WASAPI source + sink threads run."""
    async with websockets.connect(
        f"{ws_url}/passthrough", origin=localhost_origin
    ) as ws:
        await ws.send(json.dumps({
            "action": "configure",
            "sinks": [real_render_endpoint],
            "loopback": True,
        }))
        ready = await _recv_event(ws, "ready")
        assert ready["loopback"] == "system"
        assert real_render_endpoint in ready["sinks"]

        # Level ticker emits at ~12 fps; allow wide margin for jitter and
        # for the WASAPI init delay before the first level frame arrives.
        levels = await _collect_events(ws, "level", duration=1.2)
        assert len(levels) >= 5, f"only {len(levels)} level events in 1.2 s"


async def test_reconfigure_swaps_sink_while_source_active(
    ws_url, localhost_origin, real_render_endpoint
):
    """sink+loopback → loopback only → sink+loopback should not stall."""
    async with websockets.connect(
        f"{ws_url}/passthrough", origin=localhost_origin
    ) as ws:
        await ws.send(json.dumps({
            "action": "configure",
            "sinks": [real_render_endpoint],
            "loopback": True,
        }))
        await _recv_event(ws, "ready")

        await ws.send(json.dumps({"action": "configure", "loopback": True}))
        ready2 = await _recv_event(ws, "ready")
        assert ready2["sinks"] == []
        assert ready2["loopback"] == "system"

        await ws.send(json.dumps({
            "action": "configure",
            "sinks": [real_render_endpoint],
            "loopback": True,
        }))
        ready3 = await _recv_event(ws, "ready")
        assert real_render_endpoint in ready3["sinks"]


async def test_clean_shutdown_after_real_threads_active(
    ws_url, localhost_origin, real_render_endpoint
):
    """`stop` tears down the session even with WASAPI threads pumping."""
    async with websockets.connect(
        f"{ws_url}/passthrough", origin=localhost_origin
    ) as ws:
        await ws.send(json.dumps({
            "action": "configure",
            "sinks": [real_render_endpoint],
            "loopback": True,
        }))
        await _recv_event(ws, "ready")
        # Give WASAPI threads a moment to actually move packets — empty
        # shutdown wouldn't exercise thread-join paths.
        await asyncio.sleep(0.3)

        await ws.send(json.dumps({"action": "stop"}))
        with pytest.raises(websockets.ConnectionClosed):
            # Drain pending level events; the socket close should arrive
            # within a few hundred ms (one WAIT_TIMEOUT cycle per source).
            while True:
                await asyncio.wait_for(ws.recv(), timeout=3.0)


@pytest.mark.skipif(
    not os.environ.get("LIVE_TRANSLATOR_AUDIBLE"),
    reason="set LIVE_TRANSLATOR_AUDIBLE=1 to run (plays audible audio)",
)
async def test_loopback_captures_audible_tone(
    ws_url, localhost_origin, real_render_endpoint
):
    """End-to-end audio: play a tone, watch the source's peak rise above silence."""
    async with websockets.connect(
        f"{ws_url}/passthrough", origin=localhost_origin
    ) as ws:
        await ws.send(json.dumps({
            "action": "configure",
            "sinks": [real_render_endpoint],
            "loopback": True,
        }))
        await _recv_event(ws, "ready")

        # Drain ambient level events so peaks are scored against the tone
        # window only, not any stale system audio captured during startup.
        await _collect_events(ws, "level", duration=0.3)

        # Python's winsound rejects SND_MEMORY|SND_ASYNC, so stage the WAV
        # in a temp file and use SND_FILENAME|SND_ASYNC instead.
        wav_path = Path(tempfile.gettempdir()) / "live_translator_tone.wav"
        wav_path.write_bytes(
            _sine_wav_bytes(freq_hz=1000, duration_s=2.0, amplitude=0.9)
        )
        winsound.PlaySound(
            str(wav_path), winsound.SND_FILENAME | winsound.SND_ASYNC
        )
        try:
            # Give WASAPI loopback a beat to start capturing the active stream
            # before we score the window.
            await asyncio.sleep(0.2)
            levels = await _collect_events(ws, "level", duration=1.5)
        finally:
            winsound.PlaySound(None, 0)
            try:
                wav_path.unlink()
            except OSError:
                pass

        peaks = [l.get("peak", 0.0) for l in levels]
        assert peaks, "no level events captured during playback"
        assert max(peaks) > 0.01, (
            f"loopback did not pick up the played tone (peaks: {peaks}). "
            "Check that the system's default render endpoint is unmuted and "
            "has working playback — WASAPI loopback reports SILENT packets "
            "when no audio stream is active on the device."
        )
