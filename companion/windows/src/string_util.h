#pragma once

#include <string>

namespace companion {

std::string wide_to_utf8(const std::wstring& w);
std::string json_escape(const std::string& s);

// Wide-string lower for fuzzy endpoint-name matching.
std::wstring lower(std::wstring s);

}  // namespace companion
