#pragma once

namespace companion {

// Diagnostic logging. The binary calls FreeConsole() at startup, so stdout is
// useless — writes to a file in %TEMP% and mirrors to OutputDebugString so
// DebugView picks it up. Cheap enough that we sprinkle it freely on the
// process-loopback path; the log file handle is opened once via call_once
// and reused (the previous implementation opened/closed per call, which
// became measurable during the every-500ms silent-tick heartbeat).
void dlog(const char* fmt, ...);

}  // namespace companion
