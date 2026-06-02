@rem Pass "console" as the first arg to build a console-subsystem exe with dlog() mirrored to stdout.
@if /I "%1"=="console" (
  @set "_SUBSYS=-mconsole -DCONSOLE_BUILD"
) else (
  @set "_SUBSYS=-mwindows"
)

"C:\Users\user\Downloads\mingw64\bin\g++.exe" -std=c++17 -O2 %_SUBSYS% -static -Iinclude -o live_translator.exe ^
  src/main.cpp ^
  src/env.cpp ^
  src/logging.cpp ^
  src/string_util.cpp ^
  src/process_util.cpp ^
  src/http_util.cpp ^
  src/ws_util.cpp ^
  src/json_parse.cpp ^
  src/audio_format.cpp ^
  src/activation_handler.cpp ^
  src/system_loopback.cpp ^
  src/process_loopback.cpp ^
  src/process_loopback_hub.cpp ^
  src/audio_apps.cpp ^
  src/endpoints.cpp ^
  src/pt_ring.cpp ^
  src/passthrough_session.cpp ^
  src/passthrough_loop.cpp ^
  src/hotkey_hook.cpp ^
  src/hotkey_session.cpp ^
  src/http_router.cpp ^
  -lws2_32 -lbcrypt -lavrt -lole32 -lmmdevapi -luuid -lpsapi
