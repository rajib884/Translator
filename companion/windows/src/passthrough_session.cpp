#include "passthrough_session.h"

#include "activation_handler.h"
#include "audio_format.h"
#include "endpoints.h"
#include "json_parse.h"
#include "logging.h"
#include "socket_guard.h"
#include "stereo_resampler.h"
#include "string_util.h"
#include "ws_util.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <unordered_set>

namespace companion {

PassthroughSession::PassthroughSession(SOCKET s) : sock(s) {
  dlog("pt session: ctor sock=%llu", (unsigned long long)s);
  // Light-touch ticker that streams `{event:"level"}` frames to the browser
  // at ~12 fps. Source threads update peakLevel atomically; the ticker just
  // drains it. Cheap enough to always run.
  levelThread = std::thread([this] {
    // Win32 Sleep() instead of std::this_thread::sleep_for — the latter
    // links against ucrtbase!nanosleep64 on newer MinGW-w64, which is
    // missing on stock Windows installs and surfaces as "Entry Point Not
    // Found" at startup.
    while (running.load()) {
      Sleep(80);
      if (!running.load()) break;
      emit_level_if_due();
    }
  });
}

void PassthroughSession::shutdown() {
  if (!running.exchange(false)) {
    dlog("pt session: shutdown (already shut down)");
    return;
  }
  dlog("pt session: shutdown begin (mic=%d loop=%d)",
       micAlive.load() ? 1 : 0, loopbackAlive.load() ? 1 : 0);
  micAlive = false;
  loopbackAlive = false;
  std::vector<std::unique_ptr<PtSink>> drained;
  {
    std::lock_guard<std::mutex> lock(sinksMu);
    for (auto& s : sinks) s->alive = false;
    drained = std::move(sinks);
    sinks.clear();
  }
  dlog("pt session: shutdown joining %zu sink thread(s)", drained.size());
  if (micThread.joinable()) micThread.join();
  if (loopbackThread.joinable()) loopbackThread.join();
  for (auto& s : drained) { if (s->thread.joinable()) s->thread.join(); }
  if (levelThread.joinable()) levelThread.join();
  dlog("pt session: shutdown complete");
}

void PassthroughSession::close_socket() {
  if (sockAlive.exchange(false)) {
    ::shutdown(sock, SD_BOTH);
  }
}

void PassthroughSession::emit_level_if_due() {
  using clk = std::chrono::steady_clock;
  auto now = clk::now();
  if (now - lastLevelAt < std::chrono::milliseconds(80)) return;
  lastLevelAt = now;
  float p = peakLevel.exchange(0.0f);
  send_json("{\"event\":\"level\",\"peak\":" + format_float(p) + "}");
}

void PassthroughSession::send_event_ready(const std::vector<std::string>& warnings,
                                          const std::vector<std::string>& activeSinks,
                                          const std::string& micState,
                                          const std::string& loopbackState) {
  std::string s = "{\"event\":\"ready\",\"mic\":\"" + json_escape(micState) +
                  "\",\"loopback\":\"" + json_escape(loopbackState) +
                  "\",\"sinks\":[";
  for (size_t i = 0; i < activeSinks.size(); ++i) {
    if (i) s += ",";
    s += "\"" + json_escape(activeSinks[i]) + "\"";
  }
  s += "],\"warnings\":[";
  for (size_t i = 0; i < warnings.size(); ++i) {
    if (i) s += ",";
    s += warnings[i];
  }
  s += "]}";
  send_json(s);
}

void PassthroughSession::distribute(uint64_t startFrame, const float* L, const float* R, size_t n) {
  std::lock_guard<std::mutex> lock(sinksMu);
  for (auto& s : sinks) {
    if (s->alive.load()) s->ring.mixIn(startFrame, L, R, n);
  }
}

void PassthroughSession::distribute_logged(const char* who, uint64_t startFrame,
                                           const float* L, const float* R, size_t n,
                                           bool verbose) {
  if (verbose) {
    size_t nSinks = 0;
    { std::lock_guard<std::mutex> lock(sinksMu); nSinks = sinks.size(); }
    dlog("pt %s: distribute start frame=%llu n=%zu sinks=%zu Lptr=%p Rptr=%p",
         who, (unsigned long long)startFrame, n, nSinks, (void*)L, (void*)R);
  }
  distribute(startFrame, L, R, n);
  if (verbose) {
    dlog("pt %s: distribute done frame=%llu n=%zu",
         who, (unsigned long long)startFrame, n);
  }
}

void PassthroughSession::update_peak(float p) {
  float prev = peakLevel.load();
  while (p > prev && !peakLevel.compare_exchange_weak(prev, p)) {}
}

std::string PassthroughSession::format_float(float f) {
  char b[32];
  snprintf(b, sizeof(b), "%.4f", f);
  return b;
}

bool PassthroughSession::send_json(const std::string& text) {
  if (!sockAlive.load()) {
    dlog("pt send_json: socket dead, dropping (len=%zu)", text.size());
    return false;
  }
  std::lock_guard<std::mutex> lock(sendMu);
  uint8_t hdr[4];
  size_t hdr_len;
  hdr[0] = 0x81;
  const size_t len = text.size();
  if (len < 126) { hdr[1] = (uint8_t)len; hdr_len = 2; }
  else if (len <= 0xFFFF) {
    hdr[1] = 126;
    hdr[2] = (uint8_t)((len >> 8) & 0xff);
    hdr[3] = (uint8_t)(len & 0xff);
    hdr_len = 4;
  } else {
    dlog("pt send_json: payload too large (len=%zu), dropping", len);
    return false;
  }
  if (!send_all(sock, hdr, hdr_len) ||
      !send_all(sock, reinterpret_cast<const uint8_t*>(text.data()), len)) {
    dlog("pt send_json: send_all failed (len=%zu), marking socket dead", len);
    sockAlive = false;
    return false;
  }
  return true;
}

void PassthroughSession::mic_source_thread() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  dlog("pt mic source: starting (label=\"%s\" id-set=%d)",
       srcCfg.micLabel.c_str(), srcCfg.micEndpointId.empty() ? 0 : 1);

  IMMDevice* device = nullptr;
  if (!srcCfg.micEndpointId.empty()) {
    device = open_endpoint_by_id(srcCfg.micEndpointId);
    dlog("pt mic source: open_endpoint_by_id -> %p", (void*)device);
  }
  if (!device && !srcCfg.micLabel.empty()) {
    device = find_capture_endpoint_by_label(srcCfg.micLabel);
    dlog("pt mic source: find_capture_endpoint_by_label(\"%s\") -> %p",
         srcCfg.micLabel.c_str(), (void*)device);
  }
  if (!device) {
    // Final fallback: default capture endpoint so the user still gets *some*
    // mic in the cable when the label match fails (browser sometimes hands us
    // an empty label until permission is granted).
    IMMDeviceEnumerator* en = nullptr;
    HRESULT enHr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                    __uuidof(IMMDeviceEnumerator), (void**)&en);
    if (SUCCEEDED(enHr) && en) {
      HRESULT defHr = en->GetDefaultAudioEndpoint(eCapture, eCommunications, &device);
      dlog("pt mic source: default capture fallback hr=0x%08x device=%p",
           defHr, (void*)device);
      en->Release();
    } else {
      dlog("pt mic source: enumerator create failed hr=0x%08x", enHr);
    }
  }
  if (!device) {
    dlog("pt mic source: no capture endpoint found, exiting");
    micAlive = false;
    CoUninitialize();
    return;
  }

  IAudioClient* client = nullptr;
  WAVEFORMATEX* raw_format = nullptr;
  IAudioCaptureClient* capture = nullptr;
  HANDLE event = nullptr;
  HANDLE task = nullptr;
  DWORD taskIdx = 0;

  HRESULT hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client);
  dlog("pt mic source: Activate hr=0x%08x client=%p", hr, (void*)client);
  if (SUCCEEDED(hr)) {
    hr = client->GetMixFormat(&raw_format);
    dlog("pt mic source: GetMixFormat hr=0x%08x raw_format=%p", hr, (void*)raw_format);
  }
  CoTaskPtr<WAVEFORMATEX> format(raw_format);
  if (SUCCEEDED(hr)) {
    event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!event) { hr = E_OUTOFMEMORY; dlog("pt mic source: CreateEvent failed"); }
  }
  if (SUCCEEDED(hr) && format) {
    dlog("pt mic source: format tag=%u ch=%u rate=%lu bits=%u block=%u",
         format->wFormatTag, format->nChannels, format->nSamplesPerSec,
         format->wBitsPerSample, format->nBlockAlign);
  }
  if (SUCCEEDED(hr)) {
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                            2000000, 0, format.get(), nullptr);
    dlog("pt mic source: Initialize hr=0x%08x", hr);
  }
  if (SUCCEEDED(hr)) {
    hr = client->SetEventHandle(event);
    dlog("pt mic source: SetEventHandle hr=0x%08x", hr);
  }
  if (SUCCEEDED(hr)) {
    hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
    dlog("pt mic source: GetService(capture) hr=0x%08x capture=%p", hr, (void*)capture);
  }
  if (SUCCEEDED(hr)) {
    task = AvSetMmThreadCharacteristicsW(L"Audio", &taskIdx);
    dlog("pt mic source: AvSetMmThreadCharacteristics task=%p", (void*)task);
  }
  if (SUCCEEDED(hr)) {
    hr = client->Start();
    dlog("pt mic source: Start hr=0x%08x", hr);
  }
  if (FAILED(hr)) {
    dlog("pt mic source: init failed hr=0x%08x", hr);
    if (event) CloseHandle(event);
    if (capture) capture->Release();
    if (client) client->Release();
    if (device) device->Release();
    micAlive = false;
    CoUninitialize();
    return;
  }

  const WORD channels = format->nChannels;
  const WORD bits = format->wBitsPerSample;
  const WORD block = format->nBlockAlign;
  const int in_rate = (int)format->nSamplesPerSec;
  const bool is_float = is_float_format(format.get());
  const WORD bytes_per_sample = bits / 8;
  dlog("pt mic source: loop start ch=%u bits=%u block=%u rate=%d is_float=%d",
       channels, bits, block, in_rate, is_float ? 1 : 0);
  StereoResampler resampler;
  uint64_t frame = 0;
  std::vector<float> inL, inR, outL, outR;
  uint64_t packetCount = 0;
  uint64_t lastHeartbeatFrame = 0;

  while (micAlive.load() && running.load()) {
    DWORD wait = WaitForSingleObject(event, 200);
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) {
      dlog("pt mic source: WaitForSingleObject unexpected=%lu, breaking", wait);
      break;
    }
    while (true) {
      UINT32 packet = 0;
      hr = capture->GetNextPacketSize(&packet);
      if (FAILED(hr)) {
        dlog("pt mic source: GetNextPacketSize failed hr=0x%08x", hr);
        break;
      }
      if (packet == 0) break;
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) {
        dlog("pt mic source: GetBuffer failed hr=0x%08x", hr);
        break;
      }
      ++packetCount;
      if (packetCount <= 30 || (packetCount % 500) == 0) {
        dlog("pt mic source: packet #%llu frames=%u flags=0x%08lx data=%p block=%u",
             (unsigned long long)packetCount, frames, flags, (void*)data, block);
      }
      if (data == nullptr && frames > 0 && !(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
        dlog("pt mic source: WARNING null data ptr with frames=%u flags=0x%08lx", frames, flags);
      }

      inL.assign(frames, 0.0f);
      inR.assign(frames, 0.0f);
      if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && data != nullptr) {
        for (UINT32 i = 0; i < frames; ++i) {
          const BYTE* p = data + i * block;
          float l = sample_to_float(p, bits, is_float);
          float r = (channels >= 2)
                        ? sample_to_float(p + bytes_per_sample, bits, is_float)
                        : l;
          inL[i] = l; inR[i] = r;
        }
      }
      capture->ReleaseBuffer(frames);

      outL.clear(); outR.clear();
      resampler.process(inL, inR, in_rate, outL, outR);
      if (!outL.empty()) {
        // Peak across the chunk for level metering.
        float peak = 0.0f;
        for (float v : outL) { float a = v < 0 ? -v : v; if (a > peak) peak = a; }
        for (float v : outR) { float a = v < 0 ? -v : v; if (a > peak) peak = a; }
        update_peak(peak);
        const bool verbose = packetCount <= 10 || (packetCount % 500) == 0;
        distribute_logged("mic source", frame, outL.data(), outR.data(), outL.size(), verbose);
        frame += outL.size();
        if (frame - lastHeartbeatFrame >= (uint64_t)kPtMixRate * 5) {  // every ~5s
          dlog("pt mic source: heartbeat frame=%llu packets=%llu",
               (unsigned long long)frame, (unsigned long long)packetCount);
          lastHeartbeatFrame = frame;
        }
      }
    }
  }

  dlog("pt mic source: loop exit micAlive=%d running=%d frames=%llu packets=%llu",
       micAlive.load() ? 1 : 0, running.load() ? 1 : 0,
       (unsigned long long)frame, (unsigned long long)packetCount);
  client->Stop();
  if (task) AvRevertMmThreadCharacteristics(task);
  if (event) CloseHandle(event);
  if (capture) capture->Release();
  if (client) client->Release();
  device->Release();
  CoUninitialize();
  dlog("pt mic source: exit");
}

void PassthroughSession::loopback_source_thread() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const DWORD pid = srcCfg.pid;
  dlog("pt loopback source: starting (pid=%lu)", pid);

  // Activate either the per-process loopback (Win 10 20348+) or the default
  // render endpoint with AUDCLNT_STREAMFLAGS_LOOPBACK.
  IAudioClient* client = nullptr;
  WAVEFORMATEX format = {};
  WAVEFORMATEX* raw_format = nullptr;
  CoTaskPtr<WAVEFORMATEX> format_owner;
  HANDLE event = nullptr;
  HANDLE task = nullptr;
  DWORD taskIdx = 0;
  IAudioCaptureClient* capture = nullptr;
  HRESULT hr = S_OK;

  if (pid != 0) {
    dlog("pt loopback source: activating per-pid loopback for pid=%lu", pid);
    HANDLE actEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!actEvent) {
      dlog("pt loopback source: CreateEventW failed for activation");
      loopbackAlive = false; CoUninitialize(); return;
    }

    AUDIOCLIENT_ACTIVATION_PARAMS activation = {};
    activation.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activation.ProcessLoopbackParams.TargetProcessId = pid;
    activation.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT propvar = {};
    propvar.vt = VT_BLOB;
    propvar.blob.cbSize = sizeof(activation);
    propvar.blob.pBlobData = reinterpret_cast<BYTE*>(&activation);

    ActivationHandler* handler = new ActivationHandler(actEvent);
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
    hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                     __uuidof(IAudioClient),
                                     &propvar, handler, &asyncOp);
    dlog("pt loopback source: ActivateAudioInterfaceAsync hr=0x%08x asyncOp=%p",
         hr, (void*)asyncOp);
    if (FAILED(hr) || !asyncOp) {
      handler->Release();
      CloseHandle(actEvent);
      loopbackAlive = false;
      CoUninitialize();
      return;
    }
    WaitForSingleObject(actEvent, INFINITE);
    CloseHandle(actEvent);

    HRESULT activate_hr = S_OK;
    IUnknown* unk = nullptr;
    asyncOp->GetActivateResult(&activate_hr, &unk);
    asyncOp->Release();
    dlog("pt loopback source: GetActivateResult hr=0x%08x unk=%p",
         activate_hr, (void*)unk);
    if (FAILED(activate_hr) || !unk) {
      if (unk) unk->Release();
      loopbackAlive = false;
      CoUninitialize();
      return;
    }
    unk->QueryInterface(__uuidof(IAudioClient), (void**)&client);
    unk->Release();
    if (!client) {
      dlog("pt loopback source: QI(IAudioClient) returned null");
      loopbackAlive = false; CoUninitialize(); return;
    }

    // Fixed format that the process-loopback virtual device accepts: stereo
    // float 48k matches our internal mix rate so the downstream resampler is
    // effectively a no-op for pid loopback.
    format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    format.nChannels = 2;
    format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 32;
    format.nBlockAlign = 8;
    format.nAvgBytesPerSec = 384000;
    raw_format = &format;
    dlog("pt loopback source: pid path using fixed float32 stereo 48k");
  } else {
    dlog("pt loopback source: activating system loopback on default render endpoint");
    // System loopback on the default render endpoint.
    IMMDeviceEnumerator* enumerator = nullptr;
    IMMDevice* device = nullptr;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                          __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    dlog("pt loopback source: enumerator hr=0x%08x", hr);
    if (SUCCEEDED(hr)) {
      hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
      dlog("pt loopback source: GetDefaultAudioEndpoint hr=0x%08x device=%p",
           hr, (void*)device);
    }
    if (SUCCEEDED(hr)) {
      hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client);
      dlog("pt loopback source: device->Activate hr=0x%08x client=%p",
           hr, (void*)client);
    }
    if (SUCCEEDED(hr)) {
      hr = client->GetMixFormat(&raw_format);
      dlog("pt loopback source: GetMixFormat hr=0x%08x raw_format=%p",
           hr, (void*)raw_format);
    }
    if (device) device->Release();
    if (enumerator) enumerator->Release();
    if (FAILED(hr)) {
      dlog("pt loopback source: system loopback setup failed hr=0x%08x", hr);
      if (client) client->Release();
      loopbackAlive = false;
      CoUninitialize();
      return;
    }
    format_owner.reset(raw_format);
  }

  if (raw_format) {
    dlog("pt loopback source: format tag=%u ch=%u rate=%lu bits=%u block=%u",
         raw_format->wFormatTag, raw_format->nChannels, raw_format->nSamplesPerSec,
         raw_format->wBitsPerSample, raw_format->nBlockAlign);
  } else {
    dlog("pt loopback source: WARNING raw_format is null before Initialize");
  }

  event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!event) dlog("pt loopback source: CreateEventW failed");
  DWORD flagsInit = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flagsInit,
                          2000000, 0, raw_format, nullptr);
  dlog("pt loopback source: Initialize hr=0x%08x", hr);
  if (SUCCEEDED(hr)) {
    hr = client->SetEventHandle(event);
    dlog("pt loopback source: SetEventHandle hr=0x%08x", hr);
  }
  if (SUCCEEDED(hr)) {
    hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
    dlog("pt loopback source: GetService(capture) hr=0x%08x capture=%p",
         hr, (void*)capture);
  }
  if (SUCCEEDED(hr)) {
    task = AvSetMmThreadCharacteristicsW(L"Audio", &taskIdx);
    dlog("pt loopback source: AvSetMmThreadCharacteristics task=%p", (void*)task);
  }
  if (SUCCEEDED(hr)) {
    hr = client->Start();
    dlog("pt loopback source: Start hr=0x%08x", hr);
  }
  if (FAILED(hr)) {
    dlog("pt loopback source: init failed hr=0x%08x", hr);
    if (event) CloseHandle(event);
    if (capture) capture->Release();
    if (client) client->Release();
    loopbackAlive = false;
    CoUninitialize();
    return;
  }

  const WORD channels = raw_format->nChannels;
  const WORD bits = raw_format->wBitsPerSample;
  const WORD block = raw_format->nBlockAlign;
  const int in_rate = (int)raw_format->nSamplesPerSec;
  const bool is_float = is_float_format(raw_format);
  const WORD bytes_per_sample = bits / 8;
  dlog("pt loopback source: loop start ch=%u bits=%u block=%u rate=%d is_float=%d",
       channels, bits, block, in_rate, is_float ? 1 : 0);
  StereoResampler resampler;
  uint64_t frame = 0;
  std::vector<float> inL, inR, outL, outR;
  uint64_t packetCount = 0;
  uint64_t lastHeartbeatFrame = 0;

  while (loopbackAlive.load() && running.load()) {
    DWORD wait = WaitForSingleObject(event, 200);
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) {
      dlog("pt loopback source: WaitForSingleObject unexpected=%lu, breaking", wait);
      break;
    }
    while (true) {
      UINT32 packet = 0;
      hr = capture->GetNextPacketSize(&packet);
      if (FAILED(hr)) {
        dlog("pt loopback source: GetNextPacketSize failed hr=0x%08x", hr);
        break;
      }
      if (packet == 0) break;
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) {
        dlog("pt loopback source: GetBuffer failed hr=0x%08x", hr);
        break;
      }
      ++packetCount;
      if (packetCount <= 30 || (packetCount % 500) == 0) {
        dlog("pt loopback source: packet #%llu frames=%u flags=0x%08lx data=%p block=%u",
             (unsigned long long)packetCount, frames, flags, (void*)data, block);
      }
      if (data == nullptr && frames > 0 && !(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
        dlog("pt loopback source: WARNING null data ptr with frames=%u flags=0x%08lx",
             frames, flags);
      }

      inL.assign(frames, 0.0f);
      inR.assign(frames, 0.0f);
      if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && data != nullptr) {
        for (UINT32 i = 0; i < frames; ++i) {
          const BYTE* p = data + i * block;
          float l = sample_to_float(p, bits, is_float);
          float r = (channels >= 2)
                        ? sample_to_float(p + bytes_per_sample, bits, is_float)
                        : l;
          inL[i] = l; inR[i] = r;
        }
      }
      capture->ReleaseBuffer(frames);

      outL.clear(); outR.clear();
      resampler.process(inL, inR, in_rate, outL, outR);
      if (!outL.empty()) {
        float peak = 0.0f;
        for (float v : outL) { float a = v < 0 ? -v : v; if (a > peak) peak = a; }
        for (float v : outR) { float a = v < 0 ? -v : v; if (a > peak) peak = a; }
        update_peak(peak);
        const bool verbose = packetCount <= 10 || (packetCount % 500) == 0;
        distribute_logged("loopback source", frame, outL.data(), outR.data(), outL.size(), verbose);
        frame += outL.size();
        if (frame - lastHeartbeatFrame >= (uint64_t)kPtMixRate * 5) {
          dlog("pt loopback source: heartbeat frame=%llu packets=%llu",
               (unsigned long long)frame, (unsigned long long)packetCount);
          lastHeartbeatFrame = frame;
        }
      }
    }
  }

  dlog("pt loopback source: loop exit loopbackAlive=%d running=%d frames=%llu packets=%llu",
       loopbackAlive.load() ? 1 : 0, running.load() ? 1 : 0,
       (unsigned long long)frame, (unsigned long long)packetCount);
  client->Stop();
  if (task) AvRevertMmThreadCharacteristics(task);
  if (event) CloseHandle(event);
  if (capture) capture->Release();
  if (client) client->Release();
  CoUninitialize();
  dlog("pt loopback source: exit");
}

void PassthroughSession::sink_render_thread(PtSink* sink) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  dlog("pt sink \"%s\": starting", sink->endpointIdUtf8.c_str());

  IMMDevice* device = open_endpoint_by_id(sink->endpointId);
  if (!device) {
    dlog("pt sink \"%s\": endpoint not found", sink->endpointIdUtf8.c_str());
    sink->alive = false;
    CoUninitialize();
    return;
  }

  IAudioClient* client = nullptr;
  IAudioRenderClient* render = nullptr;
  WAVEFORMATEX* raw_format = nullptr;
  HANDLE event = nullptr;
  HANDLE task = nullptr;
  DWORD taskIdx = 0;

  HRESULT hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client);
  dlog("pt sink \"%s\": Activate hr=0x%08x client=%p",
       sink->endpointIdUtf8.c_str(), hr, (void*)client);
  if (SUCCEEDED(hr)) {
    hr = client->GetMixFormat(&raw_format);
    dlog("pt sink \"%s\": GetMixFormat hr=0x%08x raw_format=%p",
         sink->endpointIdUtf8.c_str(), hr, (void*)raw_format);
  }
  CoTaskPtr<WAVEFORMATEX> format(raw_format);
  if (SUCCEEDED(hr)) {
    event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!event) {
      hr = E_OUTOFMEMORY;
      dlog("pt sink \"%s\": CreateEventW failed", sink->endpointIdUtf8.c_str());
    }
  }
  if (SUCCEEDED(hr) && format) {
    dlog("pt sink \"%s\": format tag=%u ch=%u rate=%lu bits=%u block=%u",
         sink->endpointIdUtf8.c_str(),
         format->wFormatTag, format->nChannels, format->nSamplesPerSec,
         format->wBitsPerSample, format->nBlockAlign);
  }
  // 100 ms buffer is a comfortable trade-off — small enough to keep latency
  // reasonable for a passthrough, large enough that GC pauses on the source
  // side don't underrun.
  if (SUCCEEDED(hr)) {
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                            1000000, 0, format.get(), nullptr);
    dlog("pt sink \"%s\": Initialize hr=0x%08x",
         sink->endpointIdUtf8.c_str(), hr);
  }
  if (SUCCEEDED(hr)) {
    hr = client->SetEventHandle(event);
    dlog("pt sink \"%s\": SetEventHandle hr=0x%08x",
         sink->endpointIdUtf8.c_str(), hr);
  }
  if (SUCCEEDED(hr)) {
    hr = client->GetService(__uuidof(IAudioRenderClient), (void**)&render);
    dlog("pt sink \"%s\": GetService(render) hr=0x%08x render=%p",
         sink->endpointIdUtf8.c_str(), hr, (void*)render);
  }
  UINT32 bufferFrames = 0;
  if (SUCCEEDED(hr)) {
    hr = client->GetBufferSize(&bufferFrames);
    dlog("pt sink \"%s\": GetBufferSize hr=0x%08x bufferFrames=%u",
         sink->endpointIdUtf8.c_str(), hr, bufferFrames);
  }
  if (SUCCEEDED(hr)) {
    task = AvSetMmThreadCharacteristicsW(L"Audio", &taskIdx);
    dlog("pt sink \"%s\": AvSetMmThreadCharacteristics task=%p",
         sink->endpointIdUtf8.c_str(), (void*)task);
  }

  // Pre-fill the buffer with silence so the device-side clock starts cleanly.
  if (SUCCEEDED(hr) && bufferFrames > 0) {
    BYTE* buf = nullptr;
    HRESULT prefillHr = render->GetBuffer(bufferFrames, &buf);
    if (SUCCEEDED(prefillHr) && buf) {
      memset(buf, 0, bufferFrames * format->nBlockAlign);
      render->ReleaseBuffer(bufferFrames, AUDCLNT_BUFFERFLAGS_SILENT);
    } else {
      dlog("pt sink \"%s\": prefill GetBuffer hr=0x%08x buf=%p",
           sink->endpointIdUtf8.c_str(), prefillHr, (void*)buf);
    }
  }
  if (SUCCEEDED(hr)) {
    hr = client->Start();
    dlog("pt sink \"%s\": Start hr=0x%08x", sink->endpointIdUtf8.c_str(), hr);
  }
  if (FAILED(hr)) {
    dlog("pt sink \"%s\": init failed hr=0x%08x", sink->endpointIdUtf8.c_str(), hr);
    if (event) CloseHandle(event);
    if (render) render->Release();
    if (client) client->Release();
    device->Release();
    sink->alive = false;
    CoUninitialize();
    return;
  }

  const WORD channels = format->nChannels;
  const WORD bits = format->wBitsPerSample;
  const WORD block = format->nBlockAlign;
  const int out_rate = (int)format->nSamplesPerSec;
  const bool is_float = is_float_format(format.get());
  const WORD bytes_per_sample = bits / 8;
  (void)bytes_per_sample;
  dlog("pt sink \"%s\": render loop start ch=%u bits=%u block=%u rate=%d is_float=%d bufferFrames=%u",
       sink->endpointIdUtf8.c_str(), channels, bits, block, out_rate,
       is_float ? 1 : 0, bufferFrames);

  // Persistent mix-rate buffer of unconsumed samples across render calls.
  // Linear-interp resample mix-rate (48k stereo float) → out_rate. `rsPos`
  // is the fractional position within `mixBufL` of the next interp's left
  // endpoint; samples at indices [0, floor(rsPos)) are dropped after each
  // call. The previous design carried only a single rsPrev sample, which
  // silently lost the extra mix samples pulled by the `+1`/`+2` over-pull
  // — ~2 frames per render call — producing periodic clicks and a steady
  // ring-buffer underrun.
  const double ratio = static_cast<double>(kPtMixRate) / static_cast<double>(out_rate);
  std::vector<float> mixBufL, mixBufR;
  mixBufL.reserve(8192);
  mixBufR.reserve(8192);
  double rsPos = 0.0;

  uint64_t iterCount = 0;
  uint64_t totalWritten = 0;
  uint64_t lastHeartbeat = 0;

  while (sink->alive.load() && running.load()) {
    DWORD wait = WaitForSingleObject(event, 200);
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) {
      dlog("pt sink \"%s\": WaitForSingleObject unexpected=%lu, breaking",
           sink->endpointIdUtf8.c_str(), wait);
      break;
    }
    ++iterCount;
    const bool verbose = iterCount <= 5 || (iterCount % 1000) == 0;
    if (verbose) dlog("pt sink \"%s\": iter=%llu A:waited wait=%lu",
                       sink->endpointIdUtf8.c_str(),
                       (unsigned long long)iterCount, wait);

    UINT32 padding = 0;
    HRESULT padHr = client->GetCurrentPadding(&padding);
    if (FAILED(padHr)) {
      dlog("pt sink \"%s\": GetCurrentPadding failed hr=0x%08x",
           sink->endpointIdUtf8.c_str(), padHr);
      break;
    }
    UINT32 free = bufferFrames > padding ? bufferFrames - padding : 0;
    if (verbose) dlog("pt sink \"%s\": iter=%llu B:padding=%u free=%u mixBuf=%zu",
                       sink->endpointIdUtf8.c_str(),
                       (unsigned long long)iterCount, padding, free, mixBufL.size());
    if (free == 0) continue;

    BYTE* buf = nullptr;
    HRESULT gbHr = render->GetBuffer(free, &buf);
    if (FAILED(gbHr) || !buf) {
      dlog("pt sink \"%s\": render GetBuffer failed hr=0x%08x buf=%p free=%u",
           sink->endpointIdUtf8.c_str(), gbHr, (void*)buf, free);
      break;
    }

    // Pull just enough mix-rate samples into the persistent buffer so that
    // the inner loop can produce `free` output samples without overshooting.
    // `+2` is a small slack for FP rounding on the rsPos+free*ratio bound;
    // unconsumed slack stays in mixBufL for the next call (no waste).
    const size_t needMix =
        static_cast<size_t>(std::ceil(rsPos + free * ratio)) + 2;
    if (mixBufL.size() < needMix) {
      const size_t off = mixBufL.size();
      const size_t toPull = needMix - off;
      mixBufL.resize(off + toPull, 0.0f);
      mixBufR.resize(off + toPull, 0.0f);
      sink->ring.consume(mixBufL.data() + off, mixBufR.data() + off, toPull);
    }
    if (verbose) dlog("pt sink \"%s\": iter=%llu C:after pull mixBuf=%zu rsPos=%.4f needMix=%zu",
                       sink->endpointIdUtf8.c_str(),
                       (unsigned long long)iterCount, mixBufL.size(), rsPos, needMix);

    UINT32 written = 0;
    for (UINT32 i = 0; i < free; ++i) {
      if (rsPos + 1.0 >= mixBufL.size()) break;
      const size_t idx = (size_t)rsPos;
      const double frac = rsPos - idx;
      float L = mixBufL[idx] + (float)((mixBufL[idx + 1] - mixBufL[idx]) * frac);
      float R = mixBufR[idx] + (float)((mixBufR[idx + 1] - mixBufR[idx]) * frac);

      BYTE* dst = buf + i * block;
      if (is_float && bits == 32) {
        float* f = (float*)dst;
        f[0] = L;
        if (channels >= 2) f[1] = R;
        for (WORD c = 2; c < channels; ++c) f[c] = 0.0f;
      } else if (bits == 16) {
        int16_t* s = (int16_t*)dst;
        float clL = L < -1 ? -1 : (L > 1 ? 1 : L);
        float clR = R < -1 ? -1 : (R > 1 ? 1 : R);
        s[0] = (int16_t)(clL * 32767.0f);
        if (channels >= 2) s[1] = (int16_t)(clR * 32767.0f);
        for (WORD c = 2; c < channels; ++c) s[c] = 0;
      } else {
        // Unsupported render format — write silence and let the device sort
        // it out. Modern Windows always negotiates 16/32-bit shared mode so
        // this branch is mostly defensive.
        memset(dst, 0, block);
      }

      rsPos += ratio;
      ++written;
    }

    // Drop the samples we've finished using as left endpoints. The interp at
    // i=written-1 used mixBuf[idx] and mixBuf[idx+1]; the next call's first
    // interp will use mixBuf[floor(rsPos)] (now == old idx+1) and the one
    // after it. So drop [0, floor(rsPos)) and keep the rest for next call.
    size_t drop = static_cast<size_t>(rsPos);
    if (drop > mixBufL.size()) drop = mixBufL.size();
    if (drop > 0) {
      mixBufL.erase(mixBufL.begin(), mixBufL.begin() + drop);
      mixBufR.erase(mixBufR.begin(), mixBufR.begin() + drop);
      rsPos -= static_cast<double>(drop);
    }

    HRESULT rbHr = render->ReleaseBuffer(written, written == 0 ? AUDCLNT_BUFFERFLAGS_SILENT : 0);
    if (FAILED(rbHr)) {
      dlog("pt sink \"%s\": ReleaseBuffer failed hr=0x%08x written=%u",
           sink->endpointIdUtf8.c_str(), rbHr, written);
    }
    if (verbose) dlog("pt sink \"%s\": iter=%llu D:released hr=0x%08x written=%u drop=%zu mixBuf=%zu rsPos=%.4f",
                       sink->endpointIdUtf8.c_str(),
                       (unsigned long long)iterCount, rbHr, written, drop,
                       mixBufL.size(), rsPos);
    totalWritten += written;
    if (totalWritten - lastHeartbeat >= (uint64_t)out_rate * 5) {
      dlog("pt sink \"%s\": heartbeat iter=%llu totalWritten=%llu mixBuf=%zu",
           sink->endpointIdUtf8.c_str(),
           (unsigned long long)iterCount, (unsigned long long)totalWritten,
           mixBufL.size());
      lastHeartbeat = totalWritten;
    }
  }

  dlog("pt sink \"%s\": render loop exit alive=%d running=%d iters=%llu totalWritten=%llu",
       sink->endpointIdUtf8.c_str(), sink->alive.load() ? 1 : 0,
       running.load() ? 1 : 0,
       (unsigned long long)iterCount, (unsigned long long)totalWritten);
  client->Stop();
  if (task) AvRevertMmThreadCharacteristics(task);
  if (event) CloseHandle(event);
  if (render) render->Release();
  if (client) client->Release();
  device->Release();
  CoUninitialize();
  dlog("pt sink \"%s\": exit", sink->endpointIdUtf8.c_str());
}

void PassthroughSession::configure(const std::string& payload) {
  dlog("pt configure: payload (%zu bytes): %.*s",
       payload.size(),
       (int)(payload.size() > 400 ? 400 : payload.size()), payload.data());
  // Pull sinks and source descriptors from the JSON. Anything missing means
  // "stop using that source/sink".
  std::vector<std::string> wantedSinks = json_string_array(payload, "sinks");

  // Source descriptors live under "mic" and "loopback" — we read string keys
  // off the flat JSON since the homemade parser doesn't grok nesting. The
  // browser writes them as flat fields too: "micLabel", "micId", "pid".
  // Presence of micLabel/micId means mic is wanted; presence of pid means
  // per-pid loopback; pid=0 with "loopback":true means system loopback.
  std::string micLabel = json_string(payload, "micLabel");
  std::string micId    = json_string(payload, "micId");
  DWORD pid = json_int(payload, "pid", 0);
  bool wantLoopback = json_bool(payload, "loopback") || pid != 0;
  bool wantMic = !micLabel.empty() || !micId.empty();
  dlog("pt configure: parsed wantedSinks=%zu micLabel=\"%s\" micId-len=%zu pid=%lu wantLoopback=%d wantMic=%d",
       wantedSinks.size(), micLabel.c_str(), micId.size(),
       pid, wantLoopback ? 1 : 0, wantMic ? 1 : 0);
  for (size_t i = 0; i < wantedSinks.size(); ++i) {
    dlog("pt configure: wantedSinks[%zu] = \"%s\"", i, wantedSinks[i].c_str());
  }

  PtSourceConfig nextCfg;
  nextCfg.haveMic = wantMic;
  nextCfg.micLabel = micLabel;
  if (!micId.empty()) {
    int wlen = MultiByteToWideChar(CP_UTF8, 0, micId.data(), (int)micId.size(), nullptr, 0);
    nextCfg.micEndpointId.resize(wlen);
    MultiByteToWideChar(CP_UTF8, 0, micId.data(), (int)micId.size(),
                        nextCfg.micEndpointId.data(), wlen);
  }
  nextCfg.haveLoopback = wantLoopback;
  nextCfg.pid = pid;

  // ─── Diff sinks: stop sinks no longer wanted, start newly wanted ones.
  // Mark dead sinks under the lock, move them out, then join outside the
  // lock so reader paths (source threads' distribute()) aren't blocked.
  std::vector<std::string> activeSinkIds;
  std::vector<std::string> warnings;
  std::vector<std::unique_ptr<PtSink>> drained;
  {
    std::lock_guard<std::mutex> lock(sinksMu);
    std::unordered_set<std::string> wanted(wantedSinks.begin(), wantedSinks.end());
    std::vector<std::unique_ptr<PtSink>> keep;
    keep.reserve(sinks.size());
    for (auto& s : sinks) {
      if (wanted.count(s->endpointIdUtf8) == 0) {
        dlog("pt configure: stopping sink \"%s\"", s->endpointIdUtf8.c_str());
        s->alive = false;
        drained.push_back(std::move(s));
      } else {
        wanted.erase(s->endpointIdUtf8);
        activeSinkIds.push_back(s->endpointIdUtf8);
        keep.push_back(std::move(s));
      }
    }
    sinks = std::move(keep);
    for (const auto& id : wantedSinks) {
      if (!wanted.count(id)) continue;  // already running
      dlog("pt configure: starting sink \"%s\"", id.c_str());
      auto sink = std::make_unique<PtSink>();
      int wlen = MultiByteToWideChar(CP_UTF8, 0, id.data(), (int)id.size(), nullptr, 0);
      sink->endpointId.resize(wlen);
      MultiByteToWideChar(CP_UTF8, 0, id.data(), (int)id.size(),
                          sink->endpointId.data(), wlen);
      sink->endpointIdUtf8 = id;
      PtSink* raw = sink.get();
      sink->thread = std::thread([this, raw] { sink_render_thread(raw); });
      sinks.push_back(std::move(sink));
      activeSinkIds.push_back(id);
    }
  }
  if (!drained.empty()) {
    dlog("pt configure: joining %zu drained sink(s)", drained.size());
  }
  for (auto& s : drained) { if (s->thread.joinable()) s->thread.join(); }

  // ─── Diff sources.
  auto needRestartMic = [&]() {
    if (nextCfg.haveMic != srcCfg.haveMic) return true;
    if (!nextCfg.haveMic) return false;
    return nextCfg.micEndpointId != srcCfg.micEndpointId ||
           nextCfg.micLabel != srcCfg.micLabel;
  };
  auto needRestartLoop = [&]() {
    if (nextCfg.haveLoopback != srcCfg.haveLoopback) return true;
    if (!nextCfg.haveLoopback) return false;
    return nextCfg.pid != srcCfg.pid;
  };

  if (needRestartMic()) {
    dlog("pt configure: restarting mic source (was=%d -> want=%d)",
         srcCfg.haveMic ? 1 : 0, nextCfg.haveMic ? 1 : 0);
    micAlive = false;
    if (micThread.joinable()) micThread.join();
    srcCfg.haveMic = nextCfg.haveMic;
    srcCfg.micEndpointId = nextCfg.micEndpointId;
    srcCfg.micLabel = nextCfg.micLabel;
    if (nextCfg.haveMic) {
      micAlive = true;
      micThread = std::thread([this] { mic_source_thread(); });
    }
  }

  if (needRestartLoop()) {
    dlog("pt configure: restarting loopback source (was=%d/pid=%lu -> want=%d/pid=%lu)",
         srcCfg.haveLoopback ? 1 : 0, srcCfg.pid,
         nextCfg.haveLoopback ? 1 : 0, nextCfg.pid);
    loopbackAlive = false;
    if (loopbackThread.joinable()) loopbackThread.join();
    srcCfg.haveLoopback = nextCfg.haveLoopback;
    srcCfg.pid = nextCfg.pid;
    if (nextCfg.haveLoopback) {
      loopbackAlive = true;
      loopbackThread = std::thread([this] { loopback_source_thread(); });
    }
  }

  dlog("pt configure: done, activeSinks=%zu mic=%s loopback=%s",
       activeSinkIds.size(),
       srcCfg.haveMic ? "active" : "off",
       srcCfg.haveLoopback ? (srcCfg.pid != 0 ? "pid" : "system") : "off");
  send_event_ready(warnings, activeSinkIds,
                   srcCfg.haveMic ? "active" : "off",
                   srcCfg.haveLoopback
                       ? (srcCfg.pid != 0 ? "pid" : "system")
                       : "off");
}

}  // namespace companion
