#include "http_util.h"

#include "env.h"

#include <sstream>

namespace companion {

bool starts_with(const std::string& s, const char* prefix) {
  return s.rfind(prefix, 0) == 0;
}

bool is_origin_allowed(const std::string& origin) {
  const std::string configured = getenv_string("LIVE_TRANSLATOR_ALLOWED_ORIGINS");
  if (!configured.empty()) {
    std::stringstream ss(configured);
    std::string item;
    while (std::getline(ss, item, ',')) {
      while (!item.empty() && item.front() == ' ') item.erase(item.begin());
      while (!item.empty() && item.back() == ' ') item.pop_back();
      if (origin == item) return true;
    }
    return false;
  }

  return origin.empty() ||
         origin == "null" ||
         starts_with(origin, "http://localhost") ||
         starts_with(origin, "https://localhost") ||
         starts_with(origin, "http://127.0.0.1") ||
         starts_with(origin, "https://127.0.0.1") ||
         origin == "https://rajib884.github.io";
}

std::string header_value(const std::string& req, const std::string& name) {
  const std::string needle = "\r\n" + name + ":";
  size_t pos = req.find(needle);
  if (pos == std::string::npos) return {};
  pos += needle.size();
  while (pos < req.size() && req[pos] == ' ') ++pos;
  size_t end = req.find("\r\n", pos);
  if (end == std::string::npos) return {};
  return req.substr(pos, end - pos);
}

std::string request_target(const std::string& req) {
  size_t first = req.find(' ');
  if (first == std::string::npos) return "/";
  size_t second = req.find(' ', first + 1);
  if (second == std::string::npos) return "/";
  return req.substr(first + 1, second - first - 1);
}

std::string path_only(const std::string& target) {
  size_t q = target.find('?');
  return q == std::string::npos ? target : target.substr(0, q);
}

std::string query_param(const std::string& target, const std::string& key) {
  size_t q = target.find('?');
  if (q == std::string::npos) return {};
  std::string query = target.substr(q + 1);
  size_t pos = 0;
  while (pos < query.size()) {
    size_t amp = query.find('&', pos);
    if (amp == std::string::npos) amp = query.size();
    size_t eq = query.find('=', pos);
    if (eq != std::string::npos && eq < amp) {
      if (query.compare(pos, eq - pos, key) == 0) {
        return query.substr(eq + 1, amp - eq - 1);
      }
    }
    pos = amp + 1;
  }
  return {};
}

}  // namespace companion
