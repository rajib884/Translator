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

// Registers (or refreshes) the translatorcompanion:// custom URL protocol
// under HKEY_CURRENT_USER so no administrator rights are required.
// Running the EXE again after moving it will silently update the path.
void register_url_protocol(const wchar_t* exe_path) {
  using namespace companion;

  // Build the expected command value: "<exe_path>" "%1"
  std::wstring cmd = L"\"";
  cmd += exe_path;
  cmd += L"\" \"%1\"";

  // Helper: open-or-create a HKCU registry key.
  auto open_key = [](const wchar_t* sub_key, HKEY* out) -> bool {
    return RegCreateKeyExW(HKEY_CURRENT_USER, sub_key, 0, nullptr,
                           REG_OPTION_NON_VOLATILE,
                           KEY_READ | KEY_SET_VALUE, nullptr,
                           out, nullptr) == ERROR_SUCCESS;
  };

  // Helper: write a REG_SZ value if it differs from the current one.
  auto set_sz = [](HKEY key, const wchar_t* name, const std::wstring& value) {
    wchar_t buf[1024] = {};
    DWORD sz = sizeof(buf);
    DWORD type = REG_SZ;
    bool same = false;
    if (RegQueryValueExW(key, name, nullptr, &type,
                         reinterpret_cast<BYTE*>(buf), &sz) == ERROR_SUCCESS) {
      same = (value == buf);
    }
    if (!same) {
      RegSetValueExW(key, name, 0, REG_SZ,
                     reinterpret_cast<const BYTE*>(value.c_str()),
                     static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
    }
  };

  // HKCU\Software\Classes\translatorcompanion
  HKEY hProto = nullptr;
  if (open_key(L"Software\\Classes\\translatorcompanion", &hProto)) {
    set_sz(hProto, L"", L"URL:Translator Companion Protocol");
    // "URL Protocol" empty-string value marks this key as a protocol handler.
    set_sz(hProto, L"URL Protocol", L"");
    RegCloseKey(hProto);
  }

  // HKCU\Software\Classes\translatorcompanion\shell\open\command
  HKEY hCmd = nullptr;
  if (open_key(L"Software\\Classes\\translatorcompanion\\shell\\open\\command",
               &hCmd)) {
    set_sz(hCmd, L"", cmd);
    RegCloseKey(hCmd);
  }

  dlog("protocol registration done");
}

}  // namespace

#ifdef CONSOLE_BUILD
int main(int argc, char* argv[]) {
#else
int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR lpCmdLine, int) {
  // Recover argc/argv in GUI builds so we can inspect the launch URL.
  int argc = __argc;
  char** argv = __argv;
#endif
  using namespace companion;

#ifndef CONSOLE_BUILD
  FreeConsole();
#endif
  install_crash_handler();

  // ── Log launch URL (if invoked via the translatorcompanion:// protocol) ──
  if (argc >= 2 && argv[1] && argv[1][0] != '\0') {
    dlog("Launched with URL: %s", argv[1]);
  }

  WSADATA wsa = {};
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 1;

  // ── Single-instance guard ─────────────────────────────────────────────────
  // Must come immediately after WSAStartup so the guard is released on any
  // early-exit path that calls WSACleanup.
  HANDLE hMutex = CreateMutexW(nullptr, TRUE, L"Global\\LiveTranslatorCompanion");
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    if (hMutex) CloseHandle(hMutex);
    MessageBoxW(nullptr, L"Companion is already running.",
                L"Live Translator", MB_OK | MB_ICONINFORMATION);
    WSACleanup();
    return 0;
  }

  // ── Protocol self-registration ────────────────────────────────────────────
  // Refresh on every run so that moving the EXE auto-updates the registry.
  {
    wchar_t exe_path[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, exe_path, MAX_PATH);
    register_url_protocol(exe_path);
  }

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
