#include "common.h"

#include "constants.h"
#include "http_router.h"
#include "logging.h"
#include "socket_guard.h"

#include <atomic>
#include <string>
#include <thread>

namespace {

// Live connection count. Bumped before spawning the worker thread, decremented
// when handle_client returns (or when accept() rejects with 503).
std::atomic<int> g_connection_count{0};

}  // namespace

int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
  using namespace companion;

  FreeConsole();
  WSADATA wsa = {};
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 1;

  SocketGuard server{socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)};
  if (server.s == INVALID_SOCKET) return 1;

  BOOL reuse = TRUE;
  setsockopt(server.s, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse), sizeof(reuse));

  sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(kPort);
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

  if (bind(server.s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) return 1;
  if (listen(server.s, SOMAXCONN) != 0) return 1;

  while (true) {
    SOCKET client = accept(server.s, nullptr, nullptr);
    if (client == INVALID_SOCKET) continue;

    // Reject when we're already at the cap. Sending 503 (instead of just
    // closing) gives the calling page a structured error to surface instead
    // of a confusing connection-refused.
    if (g_connection_count.load(std::memory_order_acquire) >= kMaxConnections) {
      dlog("connection refused: at cap (%d)", kMaxConnections);
      const std::string body = "Too many concurrent connections";
      const std::string resp =
          "HTTP/1.1 503 Service Unavailable\r\n"
          "Content-Type: text/plain\r\n"
          "Connection: close\r\n"
          "Content-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body;
      send(client, resp.c_str(), static_cast<int>(resp.size()), 0);
      closesocket(client);
      continue;
    }

    g_connection_count.fetch_add(1, std::memory_order_acq_rel);
    std::thread([client] {
      handle_client(client);
      g_connection_count.fetch_sub(1, std::memory_order_acq_rel);
    }).detach();
  }

  WSACleanup();
  return 0;
}
