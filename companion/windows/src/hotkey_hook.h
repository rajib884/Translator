#pragma once

#include "hotkey_types.h"

#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace companion {

// Shared state for the global keyboard hook + every live /hotkey connection.
extern std::mutex g_hotkey_mutex;
extern std::vector<std::shared_ptr<HotkeyConnection>> g_hotkey_connections;

bool ws_send_text(HotkeyConnection& conn, const std::string& text);

void queue_hotkey_event(const std::shared_ptr<HotkeyConnection>& conn, const char* text);

void hotkey_sender_loop(std::shared_ptr<HotkeyConnection> conn);

// Idempotent installer for the low-level keyboard hook. Spawns a detached
// message-pump thread the first time it's called; subsequent calls are no-ops.
void ensure_hotkey_hook_thread();

}  // namespace companion
