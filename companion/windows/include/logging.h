#pragma once

namespace companion {

// Diagnostic logging. The binary calls FreeConsole() at startup, so stdout is
// useless — writes to a file in %TEMP% and mirrors to OutputDebugString so
// DebugView picks it up. Cheap enough that we sprinkle it freely on the
// process-loopback path; the log file handle is opened once via call_once
// and reused (the previous implementation opened/closed per call, which
// became measurable during the every-500ms silent-tick heartbeat).
void dlog(const char* fmt, ...);

// Install a Windows unhandled-exception filter that writes the exception
// code, faulting PC, faulting address (for AVs), and thread id via dlog()
// before the process is terminated. Without this, an access violation in
// any worker thread kills the exe silently with no log line.
void install_crash_handler();

}  // namespace companion
