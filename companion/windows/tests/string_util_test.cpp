#include "string_util.h"

#include <gtest/gtest.h>

using namespace companion;

TEST(JsonEscape, PassesPlainAsciiThrough) {
  EXPECT_EQ(json_escape("hello"), "hello");
}

TEST(JsonEscape, EscapesQuoteAndBackslash) {
  EXPECT_EQ(json_escape("a\"b\\c"), "a\\\"b\\\\c");
}

TEST(JsonEscape, EscapesCommonControlChars) {
  EXPECT_EQ(json_escape("\b\f\n\r\t"), "\\b\\f\\n\\r\\t");
}

TEST(JsonEscape, EscapesUnknownControlAsUnicode) {
  std::string in;
  in.push_back(static_cast<char>(0x01));
  EXPECT_EQ(json_escape(in), "\\u0001");
}

TEST(JsonEscape, LeavesHighAsciiAlone) {
  // High bytes are passed through unchanged; UTF-8 callers handle this above.
  std::string in;
  in.push_back(static_cast<char>(0xC3));
  in.push_back(static_cast<char>(0xA9));  // 'é' in UTF-8
  EXPECT_EQ(json_escape(in), in);
}

TEST(Lower, LowercasesAsciiLetters) {
  EXPECT_EQ(lower(L"HelloWorld"), std::wstring(L"helloworld"));
}

TEST(Lower, LeavesNonLettersUntouched) {
  EXPECT_EQ(lower(L"Mic 1 (USB)"), std::wstring(L"mic 1 (usb)"));
}

TEST(WideToUtf8, ConvertsAscii) {
  EXPECT_EQ(wide_to_utf8(L"abc"), "abc");
}

TEST(WideToUtf8, EmptyInputReturnsEmpty) {
  EXPECT_EQ(wide_to_utf8(L""), std::string());
}
