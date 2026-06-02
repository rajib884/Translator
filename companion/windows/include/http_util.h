#pragma once

#include <string>

namespace companion {

bool starts_with(const std::string& s, const char* prefix);
bool is_origin_allowed(const std::string& origin);
std::string header_value(const std::string& req, const std::string& name);
std::string request_target(const std::string& req);
std::string path_only(const std::string& target);

// Tiny query-string parser. Returns empty string when the key is absent.
// Doesn't bother with percent-decoding because the only value we ever read
// is a numeric process id.
std::string query_param(const std::string& target, const std::string& key);

}  // namespace companion
