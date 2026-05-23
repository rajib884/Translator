#include "audio_apps.h"

#include "process_util.h"
#include "string_util.h"

#include <map>

namespace companion {

std::vector<AppInfo> enumerate_audio_apps() {
  std::vector<AppInfo> apps;
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);

  IMMDeviceEnumerator* enumerator = nullptr;
  IMMDevice* device = nullptr;
  IAudioSessionManager2* mgr = nullptr;
  IAudioSessionEnumerator* sessions = nullptr;

  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
  if (SUCCEEDED(hr)) hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  if (SUCCEEDED(hr)) hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&mgr);
  if (SUCCEEDED(hr)) hr = mgr->GetSessionEnumerator(&sessions);

  int count = 0;
  if (SUCCEEDED(hr) && sessions) sessions->GetCount(&count);

  struct Candidate { DWORD pid; std::wstring display; };
  std::map<std::wstring, Candidate> by_exe;

  for (int i = 0; i < count; ++i) {
    IAudioSessionControl* ctrl = nullptr;
    if (FAILED(sessions->GetSession(i, &ctrl)) || !ctrl) continue;

    IAudioSessionControl2* ctrl2 = nullptr;
    ctrl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&ctrl2);

    DWORD pid = 0;
    if (ctrl2) ctrl2->GetProcessId(&pid);

    if (pid != 0) {
      std::wstring exe = exe_basename(pid);
      if (!exe.empty()) {
        LPWSTR raw_display = nullptr;
        ctrl->GetDisplayName(&raw_display);
        std::wstring display = (raw_display && *raw_display)
                                   ? std::wstring(raw_display)
                                   : exe;
        if (raw_display) CoTaskMemFree(raw_display);

        // Some apps publish display names like "@%SystemRoot%\\...,-1234" —
        // a resource string we can't resolve cheaply. Fall back to the exe
        // name in that case so the UI doesn't look broken.
        if (!display.empty() && display.front() == L'@') display = exe;

        auto it = by_exe.find(exe);
        if (it == by_exe.end() || pid < it->second.pid) {
          by_exe[exe] = {pid, display};
        }
      }
    }

    if (ctrl2) ctrl2->Release();
    ctrl->Release();
  }

  apps.reserve(by_exe.size());
  for (auto& kv : by_exe) {
    apps.push_back({kv.second.pid, wide_to_utf8(kv.first), wide_to_utf8(kv.second.display)});
  }

  if (sessions) sessions->Release();
  if (mgr) mgr->Release();
  if (device) device->Release();
  if (enumerator) enumerator->Release();
  CoUninitialize();
  return apps;
}

std::string serialize_apps(const std::vector<AppInfo>& apps) {
  std::string out = "{\"apps\":[";
  for (size_t i = 0; i < apps.size(); ++i) {
    if (i > 0) out += ",";
    out += "{\"pid\":" + std::to_string(apps[i].pid) +
           ",\"name\":\"" + json_escape(apps[i].name) + "\"" +
           ",\"displayName\":\"" + json_escape(apps[i].displayName) + "\"}";
  }
  out += "]}";
  return out;
}

}  // namespace companion
