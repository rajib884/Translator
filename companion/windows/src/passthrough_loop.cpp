#include "passthrough_loop.h"

#include "json_parse.h"
#include "logging.h"
#include "passthrough_session.h"
#include "ws_util.h"

#include <cstdint>
#include <string>

namespace companion {

void passthrough_session_loop(SOCKET sock) {
  dlog("pt ws loop: enter sock=%llu", (unsigned long long)sock);
  PassthroughSession session(sock);

  for (;;) {
    uint8_t hdr[2];
    int rh = recv(sock, reinterpret_cast<char*>(hdr), 2, MSG_WAITALL);
    if (rh != 2) {
      dlog("pt ws loop: header recv returned %d (wsa=%d), exiting", rh, WSAGetLastError());
      break;
    }
    const bool fin = (hdr[0] & 0x80) != 0;
    const uint8_t op = hdr[0] & 0x0F;
    const bool masked = (hdr[1] & 0x80) != 0;
    uint64_t len = hdr[1] & 0x7F;
    if (len == 126) {
      uint8_t ext[2];
      if (recv(sock, reinterpret_cast<char*>(ext), 2, MSG_WAITALL) != 2) {
        dlog("pt ws loop: 16-bit length recv failed, exiting");
        break;
      }
      len = ((uint64_t)ext[0] << 8) | ext[1];
    } else if (len == 127) {
      uint8_t ext[8];
      if (recv(sock, reinterpret_cast<char*>(ext), 8, MSG_WAITALL) != 8) {
        dlog("pt ws loop: 64-bit length recv failed, exiting");
        break;
      }
      len = 0;
      for (int i = 0; i < 8; ++i) len = (len << 8) | ext[i];
    }
    if (len > (1u << 18)) {
      dlog("pt ws loop: payload too large len=%llu, exiting", (unsigned long long)len);
      break;
    }
    uint8_t mask[4] = {};
    if (masked && recv(sock, reinterpret_cast<char*>(mask), 4, MSG_WAITALL) != 4) {
      dlog("pt ws loop: mask recv failed, exiting");
      break;
    }
    std::string payload(static_cast<size_t>(len), '\0');
    size_t got = 0;
    bool ok = true;
    while (got < len) {
      int r = recv(sock, payload.data() + got, static_cast<int>(len - got), 0);
      if (r <= 0) { ok = false; break; }
      got += r;
    }
    if (!ok) {
      dlog("pt ws loop: payload recv truncated (got=%zu of %llu), exiting",
           got, (unsigned long long)len);
      break;
    }
    if (masked) {
      for (size_t i = 0; i < payload.size(); ++i) payload[i] ^= mask[i & 3];
    }

    if (op == 0x8) { dlog("pt ws loop: close frame received"); break; }
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
      if (!send_all(sock, pong, pong_len)) { dlog("pt ws loop: pong header send failed"); break; }
      if (!payload.empty() &&
          !send_all(sock, (const uint8_t*)payload.data(), payload.size())) {
        dlog("pt ws loop: pong body send failed"); break;
      }
      continue;
    }
    if (op == 0xA) continue;                                  // pong → ignore
    if (op != 0x1 || !fin) {
      dlog("pt ws loop: skipping frame op=0x%x fin=%d len=%llu",
           op, fin ? 1 : 0, (unsigned long long)len);
      continue;
    }

    if (json_action_is(payload, "configure")) {
      session.configure(payload);
    } else if (json_action_is(payload, "stop")) {
      dlog("pt ws loop: stop action received");
      break;
    } else {
      dlog("pt ws loop: unknown action in payload (%.*s%s)",
           (int)(payload.size() > 120 ? 120 : payload.size()),
           payload.data(),
           payload.size() > 120 ? "..." : "");
    }
    // Level events are driven solely by the session's level thread;
    // emitting from here too would race on lastLevelAt.
  }

  dlog("pt ws loop: shutting down session");
  session.shutdown();
  dlog("pt ws loop: exit");
}

}  // namespace companion
