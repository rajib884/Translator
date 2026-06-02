#pragma once

#include "common.h"

#include <atomic>

namespace companion {

// System (default render device) loopback — captures everything the user can
// hear. Used when /audio is opened without a pid= query parameter.
void capture_system_loopback_to_websocket(SOCKET s, std::atomic<bool>& alive);

}  // namespace companion
