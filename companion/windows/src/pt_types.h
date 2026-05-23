#pragma once

#include "common.h"
#include "pt_ring.h"

#include <atomic>
#include <string>
#include <thread>

namespace companion {

struct PtSink {
  std::wstring endpointId;
  std::string endpointIdUtf8;
  std::thread thread;
  std::atomic<bool> alive{true};
  PtRing ring;
};

struct PtSourceConfig {
  // Mic: pick the input endpoint by id, or fall back to label match.
  std::wstring micEndpointId;
  std::string  micLabel;
  bool         haveMic = false;

  // Loopback: per-pid if pid != 0, otherwise system loopback (when haveLoopback).
  DWORD pid = 0;
  bool  haveLoopback = false;
};

}  // namespace companion
