#pragma once

#include "common.h"

#include <atomic>

namespace companion {

// Process loopback — uses ActivateAudioInterfaceAsync with a process-loopback
// activation blob. Requires Windows 10 build 20348 / Windows 11. The captured
// stream covers the target pid and its child processes, which matters for
// browsers and other multi-process apps. Format is requested as 16 kHz mono
// PCM16 directly, so no resampling is needed.
void capture_process_loopback_to_websocket(SOCKET s, DWORD pid, std::atomic<bool>& alive);

}  // namespace companion
