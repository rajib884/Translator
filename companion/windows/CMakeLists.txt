cmake_minimum_required(VERSION 3.20)
project(live_translator_companion LANGUAGES CXX)

add_executable(live-translator-companion WIN32
  src/main.cpp
  src/env.cpp
  src/logging.cpp
  src/string_util.cpp
  src/process_util.cpp
  src/http_util.cpp
  src/ws_util.cpp
  src/json_parse.cpp
  src/audio_format.cpp
  src/activation_handler.cpp
  src/system_loopback.cpp
  src/process_loopback.cpp
  src/audio_apps.cpp
  src/endpoints.cpp
  src/pt_ring.cpp
  src/passthrough_session.cpp
  src/passthrough_loop.cpp
  src/hotkey_hook.cpp
  src/hotkey_session.cpp
  src/http_router.cpp
)

target_compile_features(live-translator-companion PRIVATE cxx_std_17)
target_compile_definitions(live-translator-companion PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)

target_link_libraries(live-translator-companion PRIVATE
  ws2_32
  ole32
  avrt
  bcrypt
  mmdevapi   # ActivateAudioInterfaceAsync (process-loopback capture)
)
