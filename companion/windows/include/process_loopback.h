#pragma once

#include "common.h"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>

namespace companion {

using ProcessLoopbackFrameSink = std::function<bool(const uint8_t* data, size_t bytes)>;

// Process loopback — uses ActivateAudioInterfaceAsync with a process-loopback
// activation blob. Requires Windows 10 build 20348 / Windows 11. The captured
// stream covers the target pid and its child processes, which matters for
// browsers and other multi-process apps. Format is requested as 16 kHz mono
// PCM16 directly, so no resampling is needed.
void capture_process_loopback(DWORD pid,
                              std::atomic<bool>& alive,
                              const ProcessLoopbackFrameSink& on_frame);

void capture_process_loopback_to_websocket(SOCKET s, DWORD pid, std::atomic<bool>& alive);

}  // namespace companion
