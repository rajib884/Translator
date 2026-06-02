#pragma once

#include "common.h"

#include <cstddef>
#include <cstdint>
#include <string>

namespace companion {

std::string base64(const uint8_t* data, size_t len);
std::string websocket_accept(const std::string& key);

bool send_all(SOCKET s, const uint8_t* data, size_t len);
bool send_text(SOCKET s, const std::string& text);
bool send_ws_binary(SOCKET s, const uint8_t* data, size_t len);

}  // namespace companion
