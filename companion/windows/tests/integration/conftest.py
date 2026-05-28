"""Pytest fixtures for the live-translator companion integration suite.

Launches the companion executable on its fixed port (52341), waits for
/status to respond, and tears the process down at session end. Override the
binary path with the COMPANION_EXE env var, otherwise fall back to common
build outputs.
"""
import os
import socket
import subprocess
import time
from pathlib import Path

import pytest

HOST = "127.0.0.1"
PORT = 52341  # Matches kPort in src/constants.h — no override CLI flag exists.

WINDOWS_ROOT = Path(__file__).resolve().parents[2]


def _candidate_binaries():
    env = os.environ.get("COMPANION_EXE")
    if env:
        yield Path(env)
    yield WINDOWS_ROOT / "build_tests" / "live-translator-companion.exe"
    yield WINDOWS_ROOT / "build" / "live-translator-companion.exe"
    yield WINDOWS_ROOT / "live_translator.exe"


def _resolve_binary() -> Path:
    for p in _candidate_binaries():
        if p.exists():
            return p
    raise RuntimeError(
        "live-translator-companion executable not found. Build it (e.g. "
        "`cmake --build build_tests --target live-translator-companion`) "
        "or set COMPANION_EXE."
    )


def _port_open(host: str, port: int, timeout: float = 0.2) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


@pytest.fixture(scope="session")
def companion():
    """Launch the companion binary; yield the subprocess; terminate at teardown."""
    if _port_open(HOST, PORT):
        raise RuntimeError(
            f"port {PORT} is already in use — another companion is likely "
            "running. Stop it before running the integration tests."
        )

    exe = _resolve_binary()
    proc = subprocess.Popen(
        [str(exe)],
        cwd=str(exe.parent),
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )

    deadline = time.time() + 5.0
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(
                f"companion exited early with code {proc.returncode}"
            )
        if _port_open(HOST, PORT):
            break
        time.sleep(0.1)
    else:
        proc.terminate()
        raise RuntimeError("companion did not start listening within 5 s")

    try:
        yield proc
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture
def base_url(companion):
    return f"http://{HOST}:{PORT}"


@pytest.fixture
def ws_url(companion):
    return f"ws://{HOST}:{PORT}"


@pytest.fixture
def localhost_origin():
    """Origin header the companion's default policy accepts."""
    return "http://localhost:3000"
