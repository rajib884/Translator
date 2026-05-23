#include "ws_util.h"

#include <algorithm>

namespace companion {

std::string base64(const uint8_t* data, size_t len) {
  static constexpr char kTable[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  for (size_t i = 0; i < len; i += 3) {
    uint32_t v = data[i] << 16;
    if (i + 1 < len) v |= data[i + 1] << 8;
    if (i + 2 < len) v |= data[i + 2];
    out.push_back(kTable[(v >> 18) & 63]);
    out.push_back(kTable[(v >> 12) & 63]);
    out.push_back(i + 1 < len ? kTable[(v >> 6) & 63] : '=');
    out.push_back(i + 2 < len ? kTable[v & 63] : '=');
  }
  return out;
}

std::string websocket_accept(const std::string& key) {
  const std::string magic = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  uint8_t hash[20] = {};
  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE h = nullptr;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA1_ALGORITHM, nullptr, 0) != 0) return {};
  if (BCryptCreateHash(alg, &h, nullptr, 0, nullptr, 0, 0) != 0) {
    BCryptCloseAlgorithmProvider(alg, 0);
    return {};
  }
  NTSTATUS st = BCryptHashData(h,
      reinterpret_cast<PUCHAR>(const_cast<char*>(magic.data())),
      static_cast<ULONG>(magic.size()), 0);
  if (st == 0) st = BCryptFinishHash(h, hash, sizeof(hash), 0);
  BCryptDestroyHash(h);
  BCryptCloseAlgorithmProvider(alg, 0);
  if (st != 0) return {};
  return base64(hash, sizeof(hash));
}

bool send_all(SOCKET s, const uint8_t* data, size_t len) {
  while (len > 0) {
    int n = send(s, reinterpret_cast<const char*>(data),
                 static_cast<int>(std::min<size_t>(len, 16384)), 0);
    if (n <= 0) return false;
    data += n;
    len -= n;
  }
  return true;
}

bool send_text(SOCKET s, const std::string& text) {
  return send_all(s, reinterpret_cast<const uint8_t*>(text.data()), text.size());
}

bool send_ws_binary(SOCKET s, const uint8_t* data, size_t len) {
  uint8_t hdr[10] = {};
  size_t hdr_len = 0;
  hdr[0] = 0x82;
  if (len < 126) {
    hdr[1] = static_cast<uint8_t>(len);
    hdr_len = 2;
  } else if (len <= 0xffff) {
    hdr[1] = 126;
    hdr[2] = static_cast<uint8_t>((len >> 8) & 0xff);
    hdr[3] = static_cast<uint8_t>(len & 0xff);
    hdr_len = 4;
  } else {
    return false;
  }
  return send_all(s, hdr, hdr_len) && send_all(s, data, len);
}

}  // namespace companion
