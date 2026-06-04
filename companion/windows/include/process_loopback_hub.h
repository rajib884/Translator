#pragma once

#include "common.h"

namespace companion {

// Shares one process-loopback capture per PID across every /audio?pid=...
// websocket subscribed to that process.
void process_loopback_hub_session(SOCKET s, DWORD pid);

}  // namespace companion
