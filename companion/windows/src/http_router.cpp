#include "http_router.h"

#include "audio_apps.h"
#include "endpoints.h"
#include "hotkey_session.h"
#include "http_util.h"
#include "passthrough_loop.h"
#include "process_loopback.h"
#include "socket_guard.h"
#include "system_loopback.h"
#include "ws_util.h"

#include <atomic>
#include <string>
#include <thread>

namespace companion {
namespace {

// Maximum total header bytes we'll accumulate before giving up. 64 KB covers
// every realistic browser request (extensions can add a lot of cookies +
// Sec-CH-* headers), while still being a hard ceiling against a slowloris-style
// peer dripping bytes forever.
constexpr size_t kMaxHeaderBytes = 64 * 1024;

}  // namespace

void handle_client(SOCKET accepted) {
  SocketGuard client{accepted};
  // Drain bytes until we see the end-of-headers marker (or the cap, or the
  // peer disconnects). The previous single 8 KB recv would silently truncate
  // headers from clients that ship a lot of metadata.
  std::string req;
  req.reserve(4096);
  char chunk[4096];
  for (;;) {
    int n = recv(client.s, chunk, sizeof(chunk), 0);
    if (n <= 0) return;
    req.append(chunk, n);
    if (req.find("\r\n\r\n") != std::string::npos) break;
    if (req.size() > kMaxHeaderBytes) {
      send_text(client.s,
                "HTTP/1.1 431 Request Header Fields Too Large\r\n"
                "Content-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
  }
  const std::string target = request_target(req);
  const std::string path = path_only(target);
  const std::string origin = header_value(req, "Origin");

  const std::string cors =
      "Access-Control-Allow-Origin: " + (origin.empty() ? std::string("null") : origin) + "\r\n"
      "Access-Control-Allow-Methods: GET, OPTIONS\r\n"
      "Access-Control-Allow-Headers: Content-Type, X-Live-Translator\r\n"
      "Access-Control-Allow-Private-Network: true\r\n";

  if (!is_origin_allowed(origin)) {
    // Include the CORS header so the browser can read the 403 body and show
    // a clear "403 Forbidden" error instead of a misleading "CORS header missing".
    send_text(client.s, "HTTP/1.1 403 Forbidden\r\n" + cors + "Content-Length: 0\r\n\r\n");
    return;
  }

  if (starts_with(req, "OPTIONS ")) {
    send_text(client.s, "HTTP/1.1 204 No Content\r\n" + cors + "Content-Length: 0\r\n\r\n");
    return;
  }

  if (path == "/status") {
    const std::string body =
        "{\"status\":\"ok\",\"version\":\"0.4.0\","
        "\"audio\":\"pcm16-16000-mono\","
        "\"features\":[\"system-loopback\",\"process-loopback\",\"app-enumeration\",\"ptt-hotkey\",\"passthrough\"]}";
    send_text(client.s, "HTTP/1.1 200 OK\r\n" + cors +
                        "Content-Type: application/json\r\n"
                        "Cache-Control: no-store\r\n"
                        "Content-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body);
    return;
  }

  if (path == "/apps") {
    auto apps = enumerate_audio_apps();
    const std::string body = serialize_apps(apps);
    send_text(client.s, "HTTP/1.1 200 OK\r\n" + cors +
                        "Content-Type: application/json\r\n"
                        "Cache-Control: no-store\r\n"
                        "Content-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body);
    return;
  }

  if (path == "/outputs") {
    // Render endpoints the browser can route session passthrough audio to.
    // Sinks live on the companion side now, so the IDs returned here are
    // WASAPI endpoint ids — not the origin-hashed deviceIds the browser sees
    // in enumerateDevices() for the TTS playback section.
    auto eps = enumerate_endpoints(eRender);
    const std::string body = serialize_endpoints(eps, "outputs");
    send_text(client.s, "HTTP/1.1 200 OK\r\n" + cors +
                        "Content-Type: application/json\r\n"
                        "Cache-Control: no-store\r\n"
                        "Content-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body);
    return;
  }

  if (path == "/audio") {
    const std::string key = header_value(req, "Sec-WebSocket-Key");
    const std::string accept = websocket_accept(key);
    if (key.empty() || accept.empty()) {
      send_text(client.s, "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    send_text(client.s,
              "HTTP/1.1 101 Switching Protocols\r\n"
              "Upgrade: websocket\r\n"
              "Connection: Upgrade\r\n"
              "Sec-WebSocket-Accept: " + accept + "\r\n\r\n");

    DWORD pid = 0;
    const std::string pid_str = query_param(target, "pid");
    if (!pid_str.empty()) {
      try { pid = static_cast<DWORD>(std::stoul(pid_str)); }
      catch (...) { pid = 0; }
    }

    std::atomic<bool> alive{true};
    std::thread capture([&] {
      if (pid != 0) capture_process_loopback_to_websocket(client.s, pid, alive);
      else          capture_system_loopback_to_websocket(client.s, alive);
    });
    while (alive) {
      char tmp[2] = {};
      int r = recv(client.s, tmp, sizeof(tmp), 0);
      if (r <= 0) alive = false;
    }
    if (capture.joinable()) capture.join();
    return;
  }

  if (path == "/hotkey") {
    const std::string key = header_value(req, "Sec-WebSocket-Key");
    const std::string accept = websocket_accept(key);
    if (key.empty() || accept.empty()) {
      send_text(client.s, "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    send_text(client.s,
              "HTTP/1.1 101 Switching Protocols\r\n"
              "Upgrade: websocket\r\n"
              "Connection: Upgrade\r\n"
              "Sec-WebSocket-Accept: " + accept + "\r\n\r\n");
    hotkey_session_loop(client.s);
    return;
  }

  if (path == "/passthrough") {
    const std::string key = header_value(req, "Sec-WebSocket-Key");
    const std::string accept = websocket_accept(key);
    if (key.empty() || accept.empty()) {
      send_text(client.s, "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    send_text(client.s,
              "HTTP/1.1 101 Switching Protocols\r\n"
              "Upgrade: websocket\r\n"
              "Connection: Upgrade\r\n"
              "Sec-WebSocket-Accept: " + accept + "\r\n\r\n");
    passthrough_session_loop(client.s);
    return;
  }

  send_text(client.s, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
}

}  // namespace companion
