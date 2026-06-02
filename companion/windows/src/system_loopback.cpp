#include "system_loopback.h"

#include "audio_format.h"
#include "constants.h"
#include "resampler.h"
#include "socket_guard.h"
#include "ws_util.h"

#include <algorithm>
#include <cstdint>
#include <vector>

namespace companion {

void capture_system_loopback_to_websocket(SOCKET s, std::atomic<bool>& alive) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);

  IMMDeviceEnumerator* enumerator = nullptr;
  IMMDevice* device = nullptr;
  IAudioClient* client = nullptr;
  IAudioCaptureClient* capture = nullptr;
  WAVEFORMATEX* raw_format = nullptr;
  HANDLE task = nullptr;
  DWORD task_index = 0;

  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
  if (SUCCEEDED(hr)) hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  if (SUCCEEDED(hr)) hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client);
  if (SUCCEEDED(hr)) hr = client->GetMixFormat(&raw_format);
  CoTaskPtr<WAVEFORMATEX> format(raw_format);

  REFERENCE_TIME buffer_duration = 10000000;
  if (SUCCEEDED(hr)) {
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_LOOPBACK,
                            buffer_duration, 0, format.get(), nullptr);
  }
  if (SUCCEEDED(hr)) hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
  if (SUCCEEDED(hr)) task = AvSetMmThreadCharacteristicsW(L"Audio", &task_index);
  if (SUCCEEDED(hr)) hr = client->Start();

  const WORD channels = format ? format->nChannels : 2;
  const WORD bits = format ? format->wBitsPerSample : 32;
  const WORD block_align = format ? format->nBlockAlign : 8;
  const int in_rate = format ? static_cast<int>(format->nSamplesPerSec) : 48000;
  const bool float_fmt = format ? is_float_format(format.get()) : true;
  Resampler resampler;
  std::vector<int16_t> pending;

  while (alive && SUCCEEDED(hr)) {
    UINT32 packet = 0;
    hr = capture->GetNextPacketSize(&packet);
    if (FAILED(hr)) break;
    if (packet == 0) {
      Sleep(5);
      continue;
    }

    BYTE* data = nullptr;
    UINT32 frames = 0;
    DWORD flags = 0;
    hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
    if (FAILED(hr)) break;

    std::vector<float> mono(frames);
    if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
      std::fill(mono.begin(), mono.end(), 0.0f);
    } else {
      for (UINT32 i = 0; i < frames; ++i) {
        float sum = 0.0f;
        const BYTE* frame = data + i * block_align;
        for (WORD ch = 0; ch < channels; ++ch) {
          sum += sample_to_float(frame + ch * (bits / 8), bits, float_fmt);
        }
        mono[i] = sum / std::max<WORD>(channels, 1);
      }
    }

    std::vector<int16_t> out = resampler.process(mono, in_rate);
    pending.insert(pending.end(), out.begin(), out.end());
    while (pending.size() >= kMaxFrameSamples) {
      const size_t bytes = kMaxFrameSamples * sizeof(int16_t);
      if (!send_ws_binary(s, reinterpret_cast<const uint8_t*>(pending.data()), bytes)) {
        alive = false;
        break;
      }
      pending.erase(pending.begin(), pending.begin() + kMaxFrameSamples);
    }
    capture->ReleaseBuffer(frames);
  }

  if (client) client->Stop();
  if (task) AvRevertMmThreadCharacteristics(task);
  if (capture) capture->Release();
  if (client) client->Release();
  if (device) device->Release();
  if (enumerator) enumerator->Release();
  CoUninitialize();
}

}  // namespace companion
