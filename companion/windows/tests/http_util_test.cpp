#include "http_util.h"

#include <gtest/gtest.h>

#include <cstdlib>

using namespace companion;

namespace {

// is_origin_allowed reads LIVE_TRANSLATOR_ALLOWED_ORIGINS at call time. Clear
// it for the default-policy tests so they don't pick up a host env var.
struct EnvScrub {
  EnvScrub() { _putenv_s("LIVE_TRANSLATOR_ALLOWED_ORIGINS", ""); }
};

}  // namespace

TEST(StartsWith, MatchesPrefix) {
  EXPECT_TRUE(starts_with("abcdef", "abc"));
}

TEST(StartsWith, RejectsNonPrefix) {
  EXPECT_FALSE(starts_with("abcdef", "xyz"));
}

TEST(StartsWith, AcceptsExactMatch) {
  EXPECT_TRUE(starts_with("abc", "abc"));
}

TEST(RequestTarget, ExtractsPathFromGetLine) {
  EXPECT_EQ(request_target("GET /status HTTP/1.1\r\n"), "/status");
}

TEST(RequestTarget, KeepsQueryString) {
  EXPECT_EQ(request_target("GET /audio?pid=1234 HTTP/1.1\r\n"),
            "/audio?pid=1234");
}

TEST(RequestTarget, MalformedFallsBackToRoot) {
  EXPECT_EQ(request_target("garbage"), "/");
}

TEST(PathOnly, StripsQueryString) {
  EXPECT_EQ(path_only("/audio?pid=42"), "/audio");
}

TEST(PathOnly, LeavesPathUntouchedWhenNoQuery) {
  EXPECT_EQ(path_only("/status"), "/status");
}

TEST(QueryParam, FindsKey) {
  EXPECT_EQ(query_param("/audio?pid=1234", "pid"), "1234");
}

TEST(QueryParam, MissingKeyReturnsEmpty) {
  EXPECT_EQ(query_param("/audio?other=1", "pid"), std::string());
}

TEST(QueryParam, NoQueryStringReturnsEmpty) {
  EXPECT_EQ(query_param("/audio", "pid"), std::string());
}

TEST(QueryParam, PicksFirstAmongMultiple) {
  EXPECT_EQ(query_param("/x?a=1&b=2&c=3", "b"), "2");
}

TEST(HeaderValue, ReadsBasicHeader) {
  const std::string req = "GET / HTTP/1.1\r\nHost: localhost:52341\r\n\r\n";
  EXPECT_EQ(header_value(req, "Host"), "localhost:52341");
}

TEST(HeaderValue, TrimsLeadingWhitespace) {
  const std::string req = "GET / HTTP/1.1\r\nSec-WebSocket-Key:    dGhl\r\n\r\n";
  EXPECT_EQ(header_value(req, "Sec-WebSocket-Key"), "dGhl");
}

TEST(HeaderValue, MissingHeaderReturnsEmpty) {
  const std::string req = "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n";
  EXPECT_EQ(header_value(req, "Origin"), std::string());
}

TEST(IsOriginAllowed, DefaultPolicyPermitsEmptyAndNull) {
  EnvScrub _;
  EXPECT_TRUE(is_origin_allowed(""));
  EXPECT_TRUE(is_origin_allowed("null"));
}

TEST(IsOriginAllowed, DefaultPolicyPermitsLocalhostAndLoopback) {
  EnvScrub _;
  EXPECT_TRUE(is_origin_allowed("http://localhost:3000"));
  EXPECT_TRUE(is_origin_allowed("https://localhost"));
  EXPECT_TRUE(is_origin_allowed("http://127.0.0.1:8080"));
  EXPECT_TRUE(is_origin_allowed("https://127.0.0.1"));
}

TEST(IsOriginAllowed, DefaultPolicyRejectsArbitraryOrigin) {
  EnvScrub _;
  EXPECT_FALSE(is_origin_allowed("https://evil.example.com"));
}

TEST(IsOriginAllowed, EnvAllowlistReplacesDefaults) {
  _putenv_s("LIVE_TRANSLATOR_ALLOWED_ORIGINS",
            "https://a.example.com, https://b.example.com");
  EXPECT_TRUE(is_origin_allowed("https://a.example.com"));
  EXPECT_TRUE(is_origin_allowed("https://b.example.com"));
  // Defaults are not unioned with the env list — localhost is no longer free.
  EXPECT_FALSE(is_origin_allowed("http://localhost:3000"));
  _putenv_s("LIVE_TRANSLATOR_ALLOWED_ORIGINS", "");
}
