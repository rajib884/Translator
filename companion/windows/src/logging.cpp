#include "logging.h"

#include "common.h"

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <mutex>

namespace companion {

void dlog(const char* fmt, ...) {
  static FILE* log_file = nullptr;
  static std::once_flag init_flag;
  static std::mutex log_mutex;
  std::call_once(init_flag, [] {
    char path[MAX_PATH];
    DWORD n = GetTempPathA(MAX_PATH, path);
    if (n == 0 || n >= MAX_PATH - 40) return;
    if (strcat_s(path + n, MAX_PATH - n, "live-translator-companion.log") != 0) return;
    // Opened "ab" so writes from a previous run are preserved and so we can
    // fflush each line for crash visibility without sweeping over prior text.
    fopen_s(&log_file, path, "ab");
  });

  va_list args;
  va_start(args, fmt);
  char msg[512];
  vsnprintf(msg, sizeof(msg), fmt, args);
  va_end(args);

  SYSTEMTIME st;
  GetLocalTime(&st);
  char line[640];
  snprintf(line, sizeof(line), "[%02d:%02d:%02d.%03d] %s\r\n",
           st.wHour, st.wMinute, st.wSecond, st.wMilliseconds, msg);

  OutputDebugStringA(line);

  if (log_file) {
    std::lock_guard<std::mutex> lock(log_mutex);
    fputs(line, log_file);
    fflush(log_file);
  }
}

}  // namespace companion
