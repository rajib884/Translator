#pragma once

#include "common.h"

#include <string>
#include <vector>

namespace companion {

// Used by /outputs to advertise render endpoints to the browser, and by the
// passthrough engine to resolve the user-picked mic label against the actual
// WASAPI capture endpoints (browser device IDs are origin-hashed and useless
// outside the browser, so we match by friendly name).
struct EndpointInfo {
  std::wstring id;     // WASAPI device id ("{0.0.0.00000000}.{...guid...}")
  std::wstring name;   // friendly name
  bool isDefault = false;
};

std::wstring endpoint_friendly_name(IMMDevice* dev);
std::vector<EndpointInfo> enumerate_endpoints(EDataFlow flow);
std::string serialize_endpoints(const std::vector<EndpointInfo>& eps, const char* field);

// Open an IMMDevice* for a specific render/capture endpoint id. Caller must
// Release() the returned pointer. Returns nullptr on miss.
IMMDevice* open_endpoint_by_id(const std::wstring& id);

// Fuzzy match a label against capture-endpoint friendly names. We try exact
// match first, then case-insensitive containment in either direction. Returns
// AddRef'd IMMDevice* (caller must Release), or nullptr on miss. The "label"
// is what the browser saw from MediaDeviceInfo.label, which is usually the
// same string Windows reports as the endpoint friendly name.
IMMDevice* find_capture_endpoint_by_label(const std::string& labelUtf8);

}  // namespace companion
