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
  if (!running.exchange(false)) return;  // already shut down
  micAlive = false;
  loopbackAlive = false;
  std::vector<std::unique_ptr<PtSink>> drained;
  {
    std::lock_guard<std::mutex> lock(sinksMu);
    for (auto& s : sinks) s->alive = false;
    drained = std::move(sinks);
    sinks.clear();
  }
  if (micThread.joinable()) micThread.join();
  if (loopbackThread.joinable()) loopbackThread.join();
  for (auto& s : drained) { if (s->thread.joinable()) s->thread.join(); }
  if (levelThread.joinable()) levelThread.join();
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
  if (!sockAlive.load()) return false;
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
  } else return false;
  if (!send_all(sock, hdr, hdr_len) ||
      !send_all(sock, reinterpret_cast<const uint8_t*>(text.data()), len)) {
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
  }
  if (!device && !srcCfg.micLabel.empty()) {
    device = find_capture_endpoint_by_label(srcCfg.micLabel);
  }
  if (!device) {
    // Final fallback: default capture endpoint so the user still gets *some*
    // mic in the cable when the label match fails (browser sometimes hands us
    // an empty label until permission is granted).
    IMMDeviceEnumerator* en = nullptr;
    if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                   __uuidof(IMMDeviceEnumerator), (void**)&en)) && en) {
      en->GetDefaultAudioEndpoint(eCapture, eCommunications, &device);
      en->Release();
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
  if (SUCCEEDED(hr)) hr = client->GetMixFormat(&raw_format);
  CoTaskPtr<WAVEFORMATEX> format(raw_format);
  if (SUCCEEDED(hr)) {
    event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!event) hr = E_OUTOFMEMORY;
  }
  if (SUCCEEDED(hr)) {
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                            2000000, 0, format.get(), nullptr);
  }
  if (SUCCEEDED(hr)) hr = client->SetEventHandle(event);
  if (SUCCEEDED(hr)) hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
  if (SUCCEEDED(hr)) task = AvSetMmThreadCharacteristicsW(L"Audio", &taskIdx);
  if (SUCCEEDED(hr)) hr = client->Start();
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
  StereoResampler resampler;
  uint64_t frame = 0;
  std::vector<float> inL, inR, outL, outR;

  while (micAlive.load() && running.load()) {
    DWORD wait = WaitForSingleObject(event, 200);
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) break;
    while (true) {
      UINT32 packet = 0;
      hr = capture->GetNextPacketSize(&packet);
      if (FAILED(hr) || packet == 0) break;
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) break;

      inL.assign(frames, 0.0f);
      inR.assign(frames, 0.0f);
      if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
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
        distribute(frame, outL.data(), outR.data(), outL.size());
        frame += outL.size();
      }
    }
  }

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
    HANDLE actEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!actEvent) { loopbackAlive = false; CoUninitialize(); return; }

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
    if (FAILED(activate_hr) || !unk) {
      if (unk) unk->Release();
      loopbackAlive = false;
      CoUninitialize();
      return;
    }
    unk->QueryInterface(__uuidof(IAudioClient), (void**)&client);
    unk->Release();
    if (!client) { loopbackAlive = false; CoUninitialize(); return; }

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
  } else {
    // System loopback on the default render endpoint.
    IMMDeviceEnumerator* enumerator = nullptr;
    IMMDevice* device = nullptr;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                          __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    if (SUCCEEDED(hr)) hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    if (SUCCEEDED(hr)) hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client);
    if (SUCCEEDED(hr)) hr = client->GetMixFormat(&raw_format);
    if (device) device->Release();
    if (enumerator) enumerator->Release();
    if (FAILED(hr)) {
      if (client) client->Release();
      loopbackAlive = false;
      CoUninitialize();
      return;
    }
    format_owner.reset(raw_format);
  }

  event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  DWORD flagsInit = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flagsInit,
                          2000000, 0, raw_format, nullptr);
  if (SUCCEEDED(hr)) hr = client->SetEventHandle(event);
  if (SUCCEEDED(hr)) hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
  if (SUCCEEDED(hr)) task = AvSetMmThreadCharacteristicsW(L"Audio", &taskIdx);
  if (SUCCEEDED(hr)) hr = client->Start();
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
  StereoResampler resampler;
  uint64_t frame = 0;
  std::vector<float> inL, inR, outL, outR;

  while (loopbackAlive.load() && running.load()) {
    DWORD wait = WaitForSingleObject(event, 200);
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) break;
    while (true) {
      UINT32 packet = 0;
      hr = capture->GetNextPacketSize(&packet);
      if (FAILED(hr) || packet == 0) break;
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) break;

      inL.assign(frames, 0.0f);
      inR.assign(frames, 0.0f);
      if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
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
        distribute(frame, outL.data(), outR.data(), outL.size());
        frame += outL.size();
      }
    }
  }

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
  if (SUCCEEDED(hr)) hr = client->GetMixFormat(&raw_format);
  CoTaskPtr<WAVEFORMATEX> format(raw_format);
  if (SUCCEEDED(hr)) {
    event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!event) hr = E_OUTOFMEMORY;
  }
  // 100 ms buffer is a comfortable trade-off — small enough to keep latency
  // reasonable for a passthrough, large enough that GC pauses on the source
  // side don't underrun.
  if (SUCCEEDED(hr)) {
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                            1000000, 0, format.get(), nullptr);
  }
  if (SUCCEEDED(hr)) hr = client->SetEventHandle(event);
  if (SUCCEEDED(hr)) hr = client->GetService(__uuidof(IAudioRenderClient), (void**)&render);
  UINT32 bufferFrames = 0;
  if (SUCCEEDED(hr)) hr = client->GetBufferSize(&bufferFrames);
  if (SUCCEEDED(hr)) task = AvSetMmThreadCharacteristicsW(L"Audio", &taskIdx);

  // Pre-fill the buffer with silence so the device-side clock starts cleanly.
  if (SUCCEEDED(hr) && bufferFrames > 0) {
    BYTE* buf = nullptr;
    if (SUCCEEDED(render->GetBuffer(bufferFrames, &buf)) && buf) {
      memset(buf, 0, bufferFrames * format->nBlockAlign);
      render->ReleaseBuffer(bufferFrames, AUDCLNT_BUFFERFLAGS_SILENT);
    }
  }
  if (SUCCEEDED(hr)) hr = client->Start();
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

  // Resample mix-rate (48k stereo float) → out_rate, applied per pull. For
  // the common case (out_rate == 48k) this loop is a 1:1 pass-through.
  double rsPos = 0.0;
  float rsPrevL = 0.0f, rsPrevR = 0.0f;
  bool rsHavePrev = false;

  std::vector<float> mixL, mixR;
  mixL.reserve(4096);
  mixR.reserve(4096);

  while (sink->alive.load() && running.load()) {
    DWORD wait = WaitForSingleObject(event, 200);
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) break;

    UINT32 padding = 0;
    if (FAILED(client->GetCurrentPadding(&padding))) break;
    UINT32 free = bufferFrames > padding ? bufferFrames - padding : 0;
    if (free == 0) continue;

    BYTE* buf = nullptr;
    if (FAILED(render->GetBuffer(free, &buf)) || !buf) break;

    // Pull enough mix-rate frames to produce `free` output frames after
    // resample. ratio = mix / out: e.g. 48000/48000 = 1.0; 48000/44100 ≈ 1.088.
    const double ratio = static_cast<double>(kPtMixRate) / static_cast<double>(out_rate);
    size_t needMix = static_cast<size_t>(std::ceil(free * ratio)) + 2;
    mixL.assign(needMix, 0.0f);
    mixR.assign(needMix, 0.0f);
    sink->ring.consume(mixL.data(), mixR.data(), needMix);

    // Resample mix → out_rate. Linear, with state retained per render call.
    std::vector<float> srcL, srcR;
    srcL.reserve(needMix + 1); srcR.reserve(needMix + 1);
    if (rsHavePrev) { srcL.push_back(rsPrevL); srcR.push_back(rsPrevR); }
    srcL.insert(srcL.end(), mixL.begin(), mixL.end());
    srcR.insert(srcR.end(), mixR.begin(), mixR.end());

    UINT32 written = 0;
    for (UINT32 i = 0; i < free; ++i) {
      if (rsPos + 1.0 >= srcL.size()) break;
      const size_t idx = (size_t)rsPos;
      const double frac = rsPos - idx;
      float L = srcL[idx] + (float)((srcL[idx + 1] - srcL[idx]) * frac);
      float R = srcR[idx] + (float)((srcR[idx + 1] - srcR[idx]) * frac);

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

    rsPos -= static_cast<double>(mixL.size());
    if (!srcL.empty()) { rsPrevL = srcL.back(); rsPrevR = srcR.back(); rsHavePrev = true; }

    render->ReleaseBuffer(written, written == 0 ? AUDCLNT_BUFFERFLAGS_SILENT : 0);
  }

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
    loopbackAlive = false;
    if (loopbackThread.joinable()) loopbackThread.join();
    srcCfg.haveLoopback = nextCfg.haveLoopback;
    srcCfg.pid = nextCfg.pid;
    if (nextCfg.haveLoopback) {
      loopbackAlive = true;
      loopbackThread = std::thread([this] { loopback_source_thread(); });
    }
  }

  send_event_ready(warnings, activeSinkIds,
                   srcCfg.haveMic ? "active" : "off",
                   srcCfg.haveLoopback
                       ? (srcCfg.pid != 0 ? "pid" : "system")
                       : "off");
}

}  // namespace companion
