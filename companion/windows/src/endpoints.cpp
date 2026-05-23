#include "endpoints.h"

#include "string_util.h"

namespace companion {
namespace {

// PKEY_Device_FriendlyName from functiondiscoverykeys_devpkey.h. Inlined so
// the build doesn't pull that header (which is missing in some toolchains).
const PROPERTYKEY kDeviceFriendlyNameKey = {
    {0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 14};

}  // namespace

std::wstring endpoint_friendly_name(IMMDevice* dev) {
  IPropertyStore* props = nullptr;
  std::wstring out;
  if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props)) && props) {
    PROPVARIANT pv = {};
    if (SUCCEEDED(props->GetValue(kDeviceFriendlyNameKey, &pv)) &&
        pv.vt == VT_LPWSTR && pv.pwszVal) {
      out = pv.pwszVal;
      CoTaskMemFree(pv.pwszVal);
    }
    props->Release();
  }
  return out;
}

std::vector<EndpointInfo> enumerate_endpoints(EDataFlow flow) {
  std::vector<EndpointInfo> result;
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);

  IMMDeviceEnumerator* enumerator = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
  if (FAILED(hr) || !enumerator) { CoUninitialize(); return result; }

  std::wstring defaultId;
  IMMDevice* defaultDev = nullptr;
  if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(flow, eConsole, &defaultDev)) && defaultDev) {
    LPWSTR did = nullptr;
    if (SUCCEEDED(defaultDev->GetId(&did)) && did) {
      defaultId = did;
      CoTaskMemFree(did);
    }
    defaultDev->Release();
  }

  IMMDeviceCollection* coll = nullptr;
  if (SUCCEEDED(enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &coll)) && coll) {
    UINT count = 0;
    coll->GetCount(&count);
    for (UINT i = 0; i < count; ++i) {
      IMMDevice* dev = nullptr;
      if (FAILED(coll->Item(i, &dev)) || !dev) continue;
      LPWSTR id = nullptr;
      std::wstring idStr;
      if (SUCCEEDED(dev->GetId(&id)) && id) {
        idStr = id;
        CoTaskMemFree(id);
      }
      EndpointInfo info;
      info.id = idStr;
      info.name = endpoint_friendly_name(dev);
      info.isDefault = !idStr.empty() && idStr == defaultId;
      result.push_back(std::move(info));
      dev->Release();
    }
    coll->Release();
  }

  enumerator->Release();
  CoUninitialize();
  return result;
}

std::string serialize_endpoints(const std::vector<EndpointInfo>& eps, const char* field) {
  std::string out = "{\"";
  out += field;
  out += "\":[";
  for (size_t i = 0; i < eps.size(); ++i) {
    if (i > 0) out += ",";
    out += "{\"id\":\"" + json_escape(wide_to_utf8(eps[i].id)) + "\"";
    out += ",\"name\":\"" + json_escape(wide_to_utf8(eps[i].name)) + "\"";
    out += std::string(",\"isDefault\":") + (eps[i].isDefault ? "true" : "false");
    out += "}";
  }
  out += "]}";
  return out;
}

IMMDevice* open_endpoint_by_id(const std::wstring& id) {
  if (id.empty()) return nullptr;
  IMMDeviceEnumerator* enumerator = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
  if (FAILED(hr) || !enumerator) return nullptr;
  IMMDevice* dev = nullptr;
  enumerator->GetDevice(id.c_str(), &dev);
  enumerator->Release();
  return dev;
}

IMMDevice* find_capture_endpoint_by_label(const std::string& labelUtf8) {
  if (labelUtf8.empty()) return nullptr;
  // Convert UTF-8 to wide for comparison
  int wlen = MultiByteToWideChar(CP_UTF8, 0, labelUtf8.data(),
                                 static_cast<int>(labelUtf8.size()), nullptr, 0);
  if (wlen <= 0) return nullptr;
  std::wstring wantedRaw(static_cast<size_t>(wlen), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, labelUtf8.data(),
                      static_cast<int>(labelUtf8.size()),
                      wantedRaw.data(), wlen);
  const std::wstring wanted = lower(wantedRaw);

  auto endpoints = enumerate_endpoints(eCapture);
  // Try exact name match first.
  for (const auto& ep : endpoints) {
    if (lower(ep.name) == wanted) return open_endpoint_by_id(ep.id);
  }
  // Then containment in either direction (browser sometimes truncates,
  // and "Default - X" prefixes are common).
  for (const auto& ep : endpoints) {
    const std::wstring n = lower(ep.name);
    if (n.find(wanted) != std::wstring::npos ||
        wanted.find(n) != std::wstring::npos) return open_endpoint_by_id(ep.id);
  }
  return nullptr;
}

}  // namespace companion
