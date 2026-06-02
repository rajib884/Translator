#pragma once

#include "common.h"

#include <memory>

namespace companion {

struct SocketGuard {
  SOCKET s = INVALID_SOCKET;
  ~SocketGuard() { if (s != INVALID_SOCKET) closesocket(s); }
};

struct CoTaskMemDeleter {
  void operator()(void* p) const { CoTaskMemFree(p); }
};

template <typename T>
using CoTaskPtr = std::unique_ptr<T, CoTaskMemDeleter>;

}  // namespace companion
