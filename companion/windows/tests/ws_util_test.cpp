#include "ws_util.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <string>

using namespace companion;

namespace {

std::string b64(const std::string& s) {
  return base64(reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

}  // namespace

TEST(Base64, EmptyInputProducesEmptyOutput) {
  EXPECT_EQ(b64(""), "");
}

// RFC 4648 §10 reference vectors.
TEST(Base64, RfcVectorOneByte)    { EXPECT_EQ(b64("f"),       "Zg=="); }
TEST(Base64, RfcVectorTwoBytes)   { EXPECT_EQ(b64("fo"),      "Zm8="); }
TEST(Base64, RfcVectorThreeBytes) { EXPECT_EQ(b64("foo"),     "Zm9v"); }
TEST(Base64, RfcVectorFourBytes)  { EXPECT_EQ(b64("foob"),    "Zm9vYg=="); }
TEST(Base64, RfcVectorFiveBytes)  { EXPECT_EQ(b64("fooba"),   "Zm9vYmE="); }
TEST(Base64, RfcVectorSixBytes)   { EXPECT_EQ(b64("foobar"),  "Zm9vYmFy"); }

TEST(WebsocketAccept, MatchesRfc6455Example) {
  // RFC 6455 §1.3 example: client sends Sec-WebSocket-Key = "dGhlIHNhbXBsZSBub25jZQ==";
  // server must reply with Sec-WebSocket-Accept = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=".
  EXPECT_EQ(websocket_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
}

TEST(WebsocketAccept, EmptyKeyStillProducesAFixedHash) {
  // The function doesn't validate the key — it just SHA1s(key + magic) and
  // base64s. An empty key hashes the magic alone; this asserts the function
  // returns a non-empty result (rather than {} from a crypto-init failure).
  EXPECT_FALSE(websocket_accept("").empty());
}
