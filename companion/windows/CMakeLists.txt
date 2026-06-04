cmake_minimum_required(VERSION 3.20)
project(live_translator_companion LANGUAGES CXX)

option(CONSOLE_BUILD "Build as a console app so dlog() output is visible in the terminal" OFF)
option(BUILD_TESTS "Build the unit-test suite (uses GoogleTest via FetchContent)" OFF)

if(CONSOLE_BUILD)
  set(_subsystem "")
else()
  set(_subsystem WIN32)
endif()

set(COMPANION_LIB_SOURCES
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
  src/process_loopback_hub.cpp
  src/audio_apps.cpp
  src/endpoints.cpp
  src/pt_ring.cpp
  src/passthrough_session.cpp
  src/passthrough_loop.cpp
  src/hotkey_hook.cpp
  src/hotkey_session.cpp
  src/http_router.cpp
)

# Everything except main.cpp goes into a static lib so the test binary can link
# the same translation units without re-listing them.
add_library(live-translator-lib STATIC ${COMPANION_LIB_SOURCES})
target_compile_features(live-translator-lib PUBLIC cxx_std_17)
target_compile_definitions(live-translator-lib PUBLIC
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)
target_include_directories(live-translator-lib PUBLIC include)
target_link_libraries(live-translator-lib PUBLIC
  ws2_32
  ole32
  avrt
  bcrypt
  mmdevapi
)

add_executable(live-translator-companion ${_subsystem} src/main.cpp)
target_link_libraries(live-translator-companion PRIVATE live-translator-lib)
if(CONSOLE_BUILD)
  target_compile_definitions(live-translator-companion PRIVATE CONSOLE_BUILD)
endif()

if(BUILD_TESTS)
  include(FetchContent)
  FetchContent_Declare(
    googletest
    GIT_REPOSITORY https://github.com/google/googletest.git
    GIT_TAG        v1.15.2
  )
  # Match the CRT linkage MSVC users will pick up; harmless on MinGW.
  set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(googletest)

  enable_testing()
  add_executable(live-translator-tests
    tests/pt_ring_test.cpp
    tests/stereo_resampler_test.cpp
    tests/json_parse_test.cpp
    tests/audio_format_test.cpp
    tests/string_util_test.cpp
    tests/http_util_test.cpp
    tests/ws_util_test.cpp
  )
  target_link_libraries(live-translator-tests PRIVATE
    live-translator-lib
    GTest::gtest_main
  )

  include(GoogleTest)
  gtest_discover_tests(live-translator-tests)
endif()
