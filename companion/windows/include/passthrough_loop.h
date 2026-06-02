#pragma once

#include "common.h"

namespace companion {

// Owns the PassthroughSession for one /passthrough WebSocket. Reads incoming
// frames from the browser, dispatches `configure`/`stop` actions, replies to
// pings, and tears the session down cleanly on close.
void passthrough_session_loop(SOCKET sock);

}  // namespace companion
