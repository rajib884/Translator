#include "hotkey_session.h"

#include "hotkey_hook.h"
#include "json_parse.h"
#include "ws_util.h"

#include <algorithm>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>

namespace companion {

void hotkey_session_loop(SOCKET sock) {
  ensure_hotkey_hook_thread();

  auto conn = std::make_shared<HotkeyConnection>();
  conn->sock = sock;
  std::thread(hotkey_sender_loop, conn).detach();
  {
    std::lock_guard<std::mutex> lock(g_hotkey_mutex);
    g_hotkey_connections.push_back(conn);
  }

  // Inline WebSocket frame reader — keeps pong sends + binding mutex in
  // scope so they don't need separate plumbing.
  for (;;) {
    uint8_t hdr[2];
    if (recv(sock, reinterpret_cast<char*>(hdr), 2, MSG_WAITALL) != 2) break;
    const bool fin   = (hdr[0] & 0x80) != 0;
    const uint8_t op = hdr[0] & 0x0F;
    const bool masked = (hdr[1] & 0x80) != 0;
    uint64_t len = hdr[1] & 0x7F;
    if (len == 126) {
      uint8_t ext[2];
      if (recv(sock, reinterpret_cast<char*>(ext), 2, MSG_WAITALL) != 2) break;
      len = (static_cast<uint64_t>(ext[0]) << 8) | ext[1];
    } else if (len == 127) {
      uint8_t ext[8];
      if (recv(sock, reinterpret_cast<char*>(ext), 8, MSG_WAITALL) != 8) break;
      len = 0;
      for (int i = 0; i < 8; ++i) len = (len << 8) | ext[i];
    }
    if (len > (1u << 16)) break;        // safety cap (our messages are tiny)
    uint8_t mask[4] = {};
    if (masked && recv(sock, reinterpret_cast<char*>(mask), 4, MSG_WAITALL) != 4) break;
    std::string payload(static_cast<size_t>(len), '\0');
    size_t got = 0;
    bool ok = true;
    while (got < len) {
      int r = recv(sock, payload.data() + got, static_cast<int>(len - got), 0);
      if (r <= 0) { ok = false; break; }
      got += r;
    }
    if (!ok) break;
    if (masked) {
      for (size_t i = 0; i < payload.size(); ++i) payload[i] ^= mask[i & 3];
    }

    if (op == 0x8) break;                                       // close
    if (op == 0x9) {                                            // ping → pong
      uint8_t pong_hdr[4];
      size_t pong_hdr_len;
      pong_hdr[0] = 0x8A;
      if (payload.size() < 126) {
        pong_hdr[1] = static_cast<uint8_t>(payload.size());
        pong_hdr_len = 2;
      } else {
        pong_hdr[1] = 126;
        pong_hdr[2] = static_cast<uint8_t>((payload.size() >> 8) & 0xff);
        pong_hdr[3] = static_cast<uint8_t>(payload.size() & 0xff);
        pong_hdr_len = 4;
      }
      std::lock_guard<std::mutex> sl(conn->sendMutex);
      if (!send_all(sock, pong_hdr, pong_hdr_len)) break;
      if (!payload.empty() &&
          !send_all(sock, reinterpret_cast<const uint8_t*>(payload.data()), payload.size())) break;
      continue;
    }
    if (op == 0xA) continue;                                    // pong → ignore
    if (op != 0x1 || !fin) continue;                            // not a complete text frame

    if (json_action_is(payload, "bind")) {
      std::lock_guard<std::mutex> bl(conn->bindMutex);
      conn->binding.vkCode    = json_int(payload, "vkCode", 0);
      conn->binding.ctrl      = json_bool(payload, "ctrl");
      conn->binding.shift     = json_bool(payload, "shift");
      conn->binding.alt       = json_bool(payload, "alt");
      conn->binding.win       = json_bool(payload, "win");
      conn->binding.exclusive = json_bool(payload, "exclusive");
      conn->binding.held      = false;
    } else if (json_action_is(payload, "unbind")) {
      std::lock_guard<std::mutex> bl(conn->bindMutex);
      conn->binding.vkCode    = 0;
      conn->binding.exclusive = false;
      conn->binding.held      = false;
    }
  }

  conn->alive = false;
  conn->outboxCv.notify_all();
  std::lock_guard<std::mutex> lock(g_hotkey_mutex);
  g_hotkey_connections.erase(
      std::remove_if(g_hotkey_connections.begin(), g_hotkey_connections.end(),
                     [&](auto& c) { return c.get() == conn.get(); }),
      g_hotkey_connections.end());
}

}  // namespace companion
