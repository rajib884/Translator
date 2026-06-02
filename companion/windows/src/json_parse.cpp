#include "json_parse.h"

#include <cctype>
#include <cstdio>
#include <cstring>

namespace companion {

DWORD json_int(const std::string& s, const char* key, DWORD def) {
  std::string needle = std::string("\"") + key + "\"";
  size_t p = s.find(needle);
  if (p == std::string::npos) return def;
  p += needle.size();
  while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == ':')) ++p;
  size_t end = p;
  while (end < s.size() && isdigit(static_cast<unsigned char>(s[end]))) ++end;
  if (end == p) return def;
  try { return static_cast<DWORD>(std::stoul(s.substr(p, end - p))); }
  catch (...) { return def; }
}

bool json_bool(const std::string& s, const char* key) {
  std::string needle = std::string("\"") + key + "\"";
  size_t p = s.find(needle);
  if (p == std::string::npos) return false;
  p += needle.size();
  while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == ':')) ++p;
  return p + 4 <= s.size() && s.compare(p, 4, "true") == 0;
}

bool json_action_is(const std::string& s, const char* value) {
  size_t p = s.find("\"action\"");
  if (p == std::string::npos) return false;
  p += 8;
  while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == ':')) ++p;
  if (p >= s.size() || s[p] != '"') return false;
  ++p;
  size_t end = s.find('"', p);
  if (end == std::string::npos) return false;
  const size_t want = std::strlen(value);
  return (end - p) == want && s.compare(p, want, value) == 0;
}

std::string json_string(const std::string& s, const char* key) {
  std::string needle = std::string("\"") + key + "\"";
  size_t p = s.find(needle);
  if (p == std::string::npos) return {};
  p += needle.size();
  while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == ':')) ++p;
  if (p >= s.size() || s[p] != '"') return {};
  ++p;
  std::string out;
  while (p < s.size() && s[p] != '"') {
    if (s[p] == '\\' && p + 1 < s.size()) {
      char esc = s[p + 1];
      switch (esc) {
        case '\\': out += '\\'; break;
        case '"':  out += '"';  break;
        case 'n':  out += '\n'; break;
        case 'r':  out += '\r'; break;
        case 't':  out += '\t'; break;
        case '/':  out += '/';  break;
        case 'u': {
          // Minimal \uXXXX handling for BMP chars; encode as UTF-8.
          if (p + 5 < s.size()) {
            unsigned cp = 0;
            sscanf_s(s.substr(p + 2, 4).c_str(), "%x", &cp);
            if (cp < 0x80) out += (char)cp;
            else if (cp < 0x800) {
              out += (char)(0xC0 | (cp >> 6));
              out += (char)(0x80 | (cp & 0x3F));
            } else {
              out += (char)(0xE0 | (cp >> 12));
              out += (char)(0x80 | ((cp >> 6) & 0x3F));
              out += (char)(0x80 | (cp & 0x3F));
            }
            p += 6; continue;
          }
          break;
        }
        default: out += esc; break;
      }
      p += 2;
    } else {
      out += s[p++];
    }
  }
  return out;
}

std::vector<std::string> json_string_array(const std::string& s, const char* key) {
  std::vector<std::string> out;
  std::string needle = std::string("\"") + key + "\"";
  size_t p = s.find(needle);
  if (p == std::string::npos) return out;
  p += needle.size();
  while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == ':')) ++p;
  if (p >= s.size() || s[p] != '[') return out;
  ++p;
  while (p < s.size() && s[p] != ']') {
    while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == ',' || s[p] == '\n' || s[p] == '\r')) ++p;
    if (p >= s.size() || s[p] == ']') break;
    if (s[p] != '"') { ++p; continue; }
    ++p;
    std::string item;
    while (p < s.size() && s[p] != '"') {
      if (s[p] == '\\' && p + 1 < s.size()) { item += s[p + 1]; p += 2; }
      else item += s[p++];
    }
    if (p < s.size()) ++p;  // closing "
    out.push_back(std::move(item));
  }
  return out;
}

}  // namespace companion
