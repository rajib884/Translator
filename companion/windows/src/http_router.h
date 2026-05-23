#pragma once

#include "common.h"

namespace companion {

// Reads the HTTP request from `accepted`, applies the CORS / origin policy,
// dispatches to one of /status, /apps, /outputs, /audio, /hotkey,
// /passthrough, or returns 404. Owns the socket lifetime (via SocketGuard).
void handle_client(SOCKET accepted);

}  // namespace companion
