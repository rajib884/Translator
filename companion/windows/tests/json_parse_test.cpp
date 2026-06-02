#include "json_parse.h"

#include <gtest/gtest.h>

using namespace companion;

TEST(JsonInt, ReadsBareInteger) {
  EXPECT_EQ(json_int("{\"vkCode\":162}", "vkCode", 0u), 162u);
}

TEST(JsonInt, MissingKeyReturnsDefault) {
  EXPECT_EQ(json_int("{}", "vkCode", 42u), 42u);
}

TEST(JsonInt, ToleratesWhitespaceAroundColon) {
  EXPECT_EQ(json_int("{\"pid\"  :   123}", "pid", 0u), 123u);
}

TEST(JsonInt, NoDigitsReturnsDefault) {
  EXPECT_EQ(json_int("{\"pid\":\"abc\"}", "pid", 7u), 7u);
}

TEST(JsonBool, PresentTrueReturnsTrue) {
  EXPECT_TRUE(json_bool("{\"loopback\":true}", "loopback"));
}

TEST(JsonBool, PresentFalseReturnsFalse) {
  EXPECT_FALSE(json_bool("{\"loopback\":false}", "loopback"));
}

TEST(JsonBool, MissingReturnsFalse) {
  EXPECT_FALSE(json_bool("{}", "loopback"));
}

TEST(JsonActionIs, MatchesExact) {
  EXPECT_TRUE(json_action_is("{\"action\":\"configure\"}", "configure"));
}

TEST(JsonActionIs, RejectsDifferent) {
  EXPECT_FALSE(json_action_is("{\"action\":\"stop\"}", "configure"));
}

TEST(JsonActionIs, RejectsPrefixOrSuffixMatch) {
  // The whole quoted action value must equal the candidate, not just a prefix.
  EXPECT_FALSE(json_action_is("{\"action\":\"configure\"}", "config"));
  EXPECT_FALSE(json_action_is("{\"action\":\"config\"}", "configure"));
}

TEST(JsonActionIs, MissingActionKeyReturnsFalse) {
  EXPECT_FALSE(json_action_is("{\"vkCode\":123}", "configure"));
}

TEST(JsonString, ReadsPlainValue) {
  EXPECT_EQ(json_string("{\"micLabel\":\"Headset\"}", "micLabel"), "Headset");
}

TEST(JsonString, MissingKeyReturnsEmpty) {
  EXPECT_EQ(json_string("{}", "micLabel"), std::string());
}

TEST(JsonString, DecodesEscapedQuoteAndBackslash) {
  EXPECT_EQ(json_string("{\"x\":\"a\\\"b\\\\c\"}", "x"), "a\"b\\c");
}

TEST(JsonString, DecodesNewlineEscape) {
  EXPECT_EQ(json_string("{\"x\":\"line1\\nline2\"}", "x"), "line1\nline2");
}

TEST(JsonString, DecodesUnicodeBmpAscii) {
  EXPECT_EQ(json_string("{\"x\":\"\\u0041\"}", "x"), "A");
}

TEST(JsonString, DecodesUnicodeTwoByteUtf8) {
  // U+00E9 (é) → 0xC3 0xA9 in UTF-8
  std::string got = json_string("{\"x\":\"\\u00e9\"}", "x");
  ASSERT_EQ(got.size(), 2u);
  EXPECT_EQ(static_cast<unsigned char>(got[0]), 0xC3u);
  EXPECT_EQ(static_cast<unsigned char>(got[1]), 0xA9u);
}

TEST(JsonStringArray, ReadsMultipleItems) {
  auto v = json_string_array("{\"sinks\":[\"a\",\"b\",\"c\"]}", "sinks");
  ASSERT_EQ(v.size(), 3u);
  EXPECT_EQ(v[0], "a");
  EXPECT_EQ(v[1], "b");
  EXPECT_EQ(v[2], "c");
}

TEST(JsonStringArray, MissingKeyReturnsEmpty) {
  EXPECT_TRUE(json_string_array("{}", "sinks").empty());
}

TEST(JsonStringArray, EmptyArrayReturnsEmpty) {
  EXPECT_TRUE(json_string_array("{\"sinks\":[]}", "sinks").empty());
}

TEST(JsonStringArray, ToleratesEscapedQuotes) {
  // The array parser treats `\X` as `X` literally — confirm it doesn't crash
  // or run off the end on escapes the browser actually emits in endpoint ids.
  auto v = json_string_array("{\"sinks\":[\"a\\\"b\"]}", "sinks");
  ASSERT_EQ(v.size(), 1u);
  EXPECT_EQ(v[0], "a\"b");
}

TEST(JsonStringArray, ToleratesWhitespaceAndCommas) {
  auto v = json_string_array("{\"sinks\": [ \"a\" , \"b\" ]}", "sinks");
  ASSERT_EQ(v.size(), 2u);
  EXPECT_EQ(v[0], "a");
  EXPECT_EQ(v[1], "b");
}
