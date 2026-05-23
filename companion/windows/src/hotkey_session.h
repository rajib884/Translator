#pragma once

#include "common.h"

namespace companion {

// Owns one /hotkey WebSocket connection. Reads `bind`/`unbind` actions from
// the browser, registers the connection with the global hook, and drains
// outbound events through a sender thread until the socket closes.
void hotkey_session_loop(SOCKET sock);

}  // namespace companion
