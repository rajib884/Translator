#include "passthrough_loop.h"

#include "json_parse.h"
#include "passthrough_session.h"
#include "ws_util.h"

#include <cstdint>
#include <string>

namespace companion {

void passthrough_session_loop(SOCKET sock) {
  PassthroughSession session(sock);

  for (;;) {
    uint8_t hdr[2];
    int rh = recv(sock, reinterpret_cast<char*>(hdr), 2, MSG_WAITALL);
    if (rh != 2) break;
    const bool fin = (hdr[0] & 0x80) != 0;
    const uint8_t op = hdr[0] & 0x0F;
    const bool masked = (hdr[1] & 0x80) != 0;
    uint64_t len = hdr[1] & 0x7F;
    if (len == 126) {
      uint8_t ext[2];
      if (recv(sock, reinterpret_cast<char*>(ext), 2, MSG_WAITALL) != 2) break;
      len = ((uint64_t)ext[0] << 8) | ext[1];
    } else if (len == 127) {
      uint8_t ext[8];
      if (recv(sock, reinterpret_cast<char*>(ext), 8, MSG_WAITALL) != 8) break;
      len = 0;
      for (int i = 0; i < 8; ++i) len = (len << 8) | ext[i];
    }
    if (len > (1u << 18)) break;  // 256 KB cap for configure payloads
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

    if (op == 0x8) break;                                     // close
    if (op == 0x9) {                                          // ping → pong
      uint8_t pong[4];
      size_t pong_len;
      pong[0] = 0x8A;
      if (payload.size() < 126) { pong[1] = (uint8_t)payload.size(); pong_len = 2; }
      else {
        pong[1] = 126;
        pong[2] = (uint8_t)((payload.size() >> 8) & 0xff);
        pong[3] = (uint8_t)(payload.size() & 0xff);
        pong_len = 4;
      }
      if (!send_all(sock, pong, pong_len)) break;
      if (!payload.empty() &&
          !send_all(sock, (const uint8_t*)payload.data(), payload.size())) break;
      continue;
    }
    if (op == 0xA) continue;                                  // pong → ignore
    if (op != 0x1 || !fin) continue;                          // not complete text

    if (json_action_is(payload, "configure")) {
      session.configure(payload);
    } else if (json_action_is(payload, "stop")) {
      break;
    }
    session.emit_level_if_due();
  }

  session.shutdown();
}

}  // namespace companion
