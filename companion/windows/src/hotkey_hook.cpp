#include "hotkey_hook.h"

#include "logging.h"
#include "ws_util.h"

#include <atomic>
#include <thread>

namespace companion {

std::mutex g_hotkey_mutex;
std::vector<std::shared_ptr<HotkeyConnection>> g_hotkey_connections;
static std::atomic<bool> g_hook_started{false};

bool ws_send_text(HotkeyConnection& conn, const std::string& text) {
  uint8_t hdr[4];
  size_t hdr_len;
  hdr[0] = 0x81;                  // FIN + opcode=text
  const size_t len = text.size();
  if (len < 126) {
    hdr[1] = static_cast<uint8_t>(len);
    hdr_len = 2;
  } else if (len <= 0xFFFF) {
    hdr[1] = 126;
    hdr[2] = static_cast<uint8_t>((len >> 8) & 0xff);
    hdr[3] = static_cast<uint8_t>(len & 0xff);
    hdr_len = 4;
  } else {
    return false;
  }
  std::lock_guard<std::mutex> lock(conn.sendMutex);
  if (!conn.alive) return false;
  return send_all(conn.sock, hdr, hdr_len) &&
         send_all(conn.sock, reinterpret_cast<const uint8_t*>(text.data()), len);
}

void queue_hotkey_event(const std::shared_ptr<HotkeyConnection>& conn, const char* text) {
  if (!conn || !conn->alive.load()) return;
  {
    std::lock_guard<std::mutex> lock(conn->outboxMutex);
    if (!conn->alive.load()) return;
    if (conn->outbox.size() >= 16) conn->outbox.pop_front();
    conn->outbox.emplace_back(text);
  }
  conn->outboxCv.notify_one();
}

void hotkey_sender_loop(std::shared_ptr<HotkeyConnection> conn) {
  for (;;) {
    std::string msg;
    {
      std::unique_lock<std::mutex> lock(conn->outboxMutex);
      conn->outboxCv.wait(lock, [&] {
        return !conn->alive.load() || !conn->outbox.empty();
      });
      if (conn->outbox.empty()) {
        if (!conn->alive.load()) break;
        continue;
      }
      msg = std::move(conn->outbox.front());
      conn->outbox.pop_front();
    }
    if (!ws_send_text(*conn, msg)) {
      conn->alive = false;
      conn->outboxCv.notify_all();
      break;
    }
  }
}

static LRESULT CALLBACK hotkey_hook_proc(int nCode, WPARAM wParam, LPARAM lParam) {
  bool suppress = false;
  if (nCode == HC_ACTION) {
    const KBDLLHOOKSTRUCT* k = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);
    const bool isDown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
    const bool isUp   = (wParam == WM_KEYUP   || wParam == WM_SYSKEYUP);
    if (isDown || isUp) {
      const bool ctrl  = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
      const bool shift = (GetAsyncKeyState(VK_SHIFT)   & 0x8000) != 0;
      const bool alt   = (GetAsyncKeyState(VK_MENU)    & 0x8000) != 0;
      const bool win   = ((GetAsyncKeyState(VK_LWIN) | GetAsyncKeyState(VK_RWIN)) & 0x8000) != 0;

      // Snapshot the list under the lock; iterate without it so a slow send()
      // never holds the global mutex (and never blocks /audio handshakes).
      std::vector<std::shared_ptr<HotkeyConnection>> snapshot;
      {
        std::lock_guard<std::mutex> lock(g_hotkey_mutex);
        snapshot = g_hotkey_connections;
      }
      for (auto& conn : snapshot) {
        if (!conn->alive.load()) continue;
        DWORD vk;
        bool wantCtrl, wantShift, wantAlt, wantWin, wantExclusive;
        {
          std::lock_guard<std::mutex> bl(conn->bindMutex);
          vk            = conn->binding.vkCode;
          wantCtrl      = conn->binding.ctrl;
          wantShift     = conn->binding.shift;
          wantAlt       = conn->binding.alt;
          wantWin       = conn->binding.win;
          wantExclusive = conn->binding.exclusive;
        }
        if (vk == 0) continue;

        DWORD hookVk = k->vkCode;
        if (hookVk == VK_LSHIFT || hookVk == VK_RSHIFT) hookVk = VK_SHIFT;
        else if (hookVk == VK_LCONTROL || hookVk == VK_RCONTROL) hookVk = VK_CONTROL;
        else if (hookVk == VK_LMENU || hookVk == VK_RMENU) hookVk = VK_MENU;

        if (hookVk != vk) continue;

        if (isDown) {
          // Modifier check only on press — the user may release modifiers
          // before the main key, and we still want a clean UP event.
          if (wantCtrl != ctrl || wantShift != shift ||
              wantAlt != alt   || wantWin != win) continue;
          if (!conn->binding.held.exchange(true)) {
            queue_hotkey_event(conn, R"({"event":"down"})");
          }
          // Swallow the key event so other apps never see it — but only when
          // the client opted into exclusive capture. Only the bound main key
          // is suppressed (Ctrl/Shift/Alt/Win pass through normally, because
          // the hook never matches them as the vk for a chord), so common
          // modifier-based shortcuts in other apps stay usable.
          if (wantExclusive) suppress = true;
        } else {
          if (conn->binding.held.exchange(false)) {
            queue_hotkey_event(conn, R"({"event":"up"})");
            // Pair the suppressed down with a suppressed up so the OS never
            // sees a dangling release. If we weren't tracking this press as
            // held (held was already false), the down wasn't ours either,
            // so leave the up alone. Same exclusive-only gating as down.
            if (wantExclusive) suppress = true;
          }
        }
      }
    }
  }
  // Returning non-zero from a low-level hook tells the OS to drop the event
  // before any other hook/app receives it. When no connection is bound (or
  // the page is closed and all connections were removed), we always fall
  // through to CallNextHookEx so the keyboard behaves normally.
  if (suppress) return 1;
  return CallNextHookEx(nullptr, nCode, wParam, lParam);
}

static void hotkey_hook_thread() {
  // The low-level hook needs a message pump on its installing thread.
  HHOOK hook = SetWindowsHookExW(WH_KEYBOARD_LL, hotkey_hook_proc,
                                 GetModuleHandleW(nullptr), 0);
  if (!hook) {
    dlog("SetWindowsHookExW(WH_KEYBOARD_LL) failed: %lu", GetLastError());
    return;
  }
  MSG msg;
  while (GetMessage(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessage(&msg);
  }
  UnhookWindowsHookEx(hook);
}

void ensure_hotkey_hook_thread() {
  bool expected = false;
  if (g_hook_started.compare_exchange_strong(expected, true)) {
    std::thread(hotkey_hook_thread).detach();
  }
}

}  // namespace companion
