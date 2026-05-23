#pragma once

#include "common.h"

#include <string>
#include <vector>

namespace companion {

// Tiny JSON-ish parsers — the wire protocol is flat (action / vkCode / bools)
// and fully under our control, so we avoid pulling in a JSON dependency.
DWORD json_int(const std::string& s, const char* key, DWORD def);
bool json_bool(const std::string& s, const char* key);
bool json_action_is(const std::string& s, const char* value);

// Parse helpers for /passthrough configure payloads. The JSON is small and
// flat enough that bespoke parsers stay simpler than dragging in a library.
std::string json_string(const std::string& s, const char* key);

// Pull each string element from a JSON array under "key". Tolerates simple
// whitespace and the kind of escapes browsers actually emit.
std::vector<std::string> json_string_array(const std::string& s, const char* key);

}  // namespace companion
