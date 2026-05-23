#pragma once

#include "common.h"

#include <string>
#include <vector>

namespace companion {

// Walks the default render device's audio sessions, groups by exe name, and
// returns one entry per app. We pick the lowest pid we see for each exe — for
// multi-process apps (Chrome, Discord, …)
// PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE captures from the chosen
// pid plus its descendants, so the root pid catches everything.
struct AppInfo {
  DWORD pid;
  std::string name;          // exe basename, UTF-8
  std::string displayName;   // session DisplayName or exe name, UTF-8
};

std::vector<AppInfo> enumerate_audio_apps();
std::string serialize_apps(const std::vector<AppInfo>& apps);

}  // namespace companion
