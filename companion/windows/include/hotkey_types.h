#pragma once

#include "common.h"

#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>

namespace companion {

struct HotkeyBinding {
  DWORD vkCode = 0;
  bool ctrl = false, shift = false, alt = false, win = false;
  // When true, the hook swallows the bound key so other apps don't see it.
  // Off by default — opt-in from the web client per bind message.
  bool exclusive = false;
  std::atomic<bool> held{false};
};

struct HotkeyConnection {
  SOCKET sock = INVALID_SOCKET;
  std::mutex bindMutex;
  HotkeyBinding binding;
  std::atomic<bool> alive{true};
  std::mutex sendMutex;          // serialise writes (hook thread + pong sender)
  std::mutex outboxMutex;
  std::condition_variable outboxCv;
  std::deque<std::string> outbox;
};

}  // namespace companion
