#include "logging.h"

#include "common.h"

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <mutex>

namespace companion {

namespace {

LONG CALLBACK unhandled_exception_filter(EXCEPTION_POINTERS* info) {
  if (!info || !info->ExceptionRecord) {
    dlog("CRASH: unhandled_exception_filter invoked with null info");
    return EXCEPTION_EXECUTE_HANDLER;
  }
  const DWORD code = info->ExceptionRecord->ExceptionCode;
  void* pc = info->ExceptionRecord->ExceptionAddress;
  const DWORD tid = GetCurrentThreadId();

  HMODULE mod = nullptr;
  uintptr_t modBase = 0;
  if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                         GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                         reinterpret_cast<LPCSTR>(pc), &mod) && mod) {
    modBase = reinterpret_cast<uintptr_t>(mod);
  }
  const uintptr_t pcRel = reinterpret_cast<uintptr_t>(pc) -
                          (modBase ? modBase : reinterpret_cast<uintptr_t>(pc));

  if (code == EXCEPTION_ACCESS_VIOLATION &&
      info->ExceptionRecord->NumberParameters >= 2) {
    const ULONG_PTR op = info->ExceptionRecord->ExceptionInformation[0];
    const ULONG_PTR fault = info->ExceptionRecord->ExceptionInformation[1];
    const char* opStr = op == 0 ? "read" : op == 1 ? "write" : "execute";
    dlog("CRASH: AccessViolation tid=%lu pc=%p (mod+0x%llx) %s addr=0x%p",
         tid, pc, (unsigned long long)pcRel, opStr, (void*)fault);
  } else {
    dlog("CRASH: code=0x%08lx tid=%lu pc=%p (mod+0x%llx)",
         code, tid, pc, (unsigned long long)pcRel);
  }
  return EXCEPTION_EXECUTE_HANDLER;
}

}  // namespace

void install_crash_handler() {
  SetUnhandledExceptionFilter(unhandled_exception_filter);
  dlog("crash handler installed");
}

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

#ifdef CONSOLE_BUILD
  fputs(line, stdout);
  fflush(stdout);
#endif

  if (log_file) {
    std::lock_guard<std::mutex> lock(log_mutex);
    fputs(line, log_file);
    fflush(log_file);
  }
}

}  // namespace companion
