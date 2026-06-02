"""Integration tests for the /passthrough WebSocket protocol.

These tests exercise the configure/diff logic and the WS frame loop in
[passthrough_loop.cpp](../../src/passthrough_loop.cpp) and
[passthrough_session.cpp](../../src/passthrough_session.cpp) without needing
real audio devices: requested sinks appear in the `event:"ready"` payload
regardless of whether the WASAPI endpoint actually opens (that happens on a
background thread and is reported only as warnings/errors).
"""
import asyncio
import json

import pytest
import websockets


async def _recv_event(ws, name, timeout=2.0):
    """Receive frames until one with `event == name` arrives, then return it."""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise asyncio.TimeoutError(f"timed out waiting for event={name!r}")
        msg = await asyncio.wait_for(ws.recv(), timeout=remaining)
        data = json.loads(msg)
        if data.get("event") == name:
            return data


async def test_configure_with_no_sources_emits_ready(ws_url, localhost_origin):
    async with websockets.connect(
        f"{ws_url}/passthrough", origin=localhost_origin
    ) as ws:
        await ws.send(json.dumps({"action": "configure"}))
        ready = await _recv_event(ws, "ready")
        assert ready["mic"] == "off"
        assert ready["loopback"] == "off"
        assert ready["sinks"] == []


async def test_configure_echoes_requested_sinks_in_ready(ws_url, localhost_origin):
    # The WASAPI sink thread runs asynchronously; the synchronous `ready`
    # event lists every requested sink regardless of whether the endpoint
    # eventually opens successfully.
    bogus = "{0.0.0.00000000}.{deadbeef-0000-0000-0000-000000000000}"
    async with websockets.connect(
        f"{ws_url}/passthrough", origin=localhost_origin
    ) as ws:
        await ws.send(json.dumps({"action": "configure", "sinks": [bogus]}))
        ready = await _recv_event(ws, "ready")
        assert bogus in ready["sinks"]


async def test_reconfigure_drops_removed_sink(ws_url, localhost_origin):
    a = "{0.0.0.00000000}.{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}"
    b = "{0.0.0.00000000}.{bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb}"
    async with websockets.connect(
        f"{ws_url}/passthrough", origin=localhost_origin
    ) as ws:
        await ws.send(json.dumps({"action": "configure", "sinks": [a, b]}))
        ready1 = await _recv_event(ws, "ready")
        assert set(ready1["sinks"]) == {a, b}

        await ws.send(json.dumps({"action": "configure", "sinks": [a]}))
        ready2 = await _recv_event(ws, "ready")
        assert ready2["sinks"] == [a]


async def test_loopback_request_reported_in_ready(ws_url, localhost_origin):
    async with websockets.connect(
        f"{ws_url}/passthrough", origin=localhost_origin
    ) as ws:
        await ws.send(json.dumps({"action": "configure", "loopback": True}))
        ready = await _recv_event(ws, "ready")
        assert ready["loopback"] == "system"


async def test_pid_request_reported_as_pid_loopback(ws_url, localhost_origin):
    async with websockets.connect(
        f"{ws_url}/passthrough", origin=localhost_origin
    ) as ws:
        # pid=4 (System) won't actually capture anything useful, but the
        # configure-diff path should report it as a per-pid loopback request.
        await ws.send(json.dumps({"action": "configure", "pid": 4}))
        ready = await _recv_event(ws, "ready")
        assert ready["loopback"] == "pid"


async def test_ping_pong_keeps_connection_alive(ws_url, localhost_origin):
    async with websockets.connect(
        f"{ws_url}/passthrough", origin=localhost_origin
    ) as ws:
        pong_waiter = await ws.ping(b"hello")
        await asyncio.wait_for(pong_waiter, timeout=2.0)


async def test_stop_action_closes_session(ws_url, localhost_origin):
    async with websockets.connect(
        f"{ws_url}/passthrough", origin=localhost_origin
    ) as ws:
        await ws.send(json.dumps({"action": "stop"}))
        with pytest.raises(websockets.ConnectionClosed):
            # The server breaks its read loop and the socket gets torn down;
            # the next recv either yields close info or raises immediately.
            while True:
                await asyncio.wait_for(ws.recv(), timeout=2.0)
