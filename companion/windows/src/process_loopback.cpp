#include "process_loopback.h"

#include "activation_handler.h"
#include "audio_format.h"
#include "constants.h"
#include "logging.h"
#include "resampler.h"
#include "ws_util.h"

#include <cstdint>
#include <vector>

namespace companion {
namespace {

struct ProcLoopFormat {
  const char* desc;
  WORD format_tag;
  WORD channels;
  DWORD rate;
  WORD bits;
};

}  // namespace

void capture_process_loopback(DWORD pid,
                              std::atomic<bool>& alive,
                              const ProcessLoopbackFrameSink& on_frame) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  dlog("process loopback pid=%lu: starting", pid);

  HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!event) {
    dlog("process loopback pid=%lu: CreateEvent (activation) failed", pid);
    alive = false; CoUninitialize(); return;
  }

  AUDIOCLIENT_ACTIVATION_PARAMS activation = {};
  activation.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  // Default MSVC builds expand DUMMYUNIONNAME to nothing, so the inner union is
  // anonymous and we access its members directly.
  activation.ProcessLoopbackParams.TargetProcessId = pid;
  activation.ProcessLoopbackParams.ProcessLoopbackMode =
      PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT propvar = {};
  propvar.vt = VT_BLOB;
  propvar.blob.cbSize = sizeof(activation);
  propvar.blob.pBlobData = reinterpret_cast<BYTE*>(&activation);

  ActivationHandler* handler = new ActivationHandler(event);

  IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
  HRESULT hr = ActivateAudioInterfaceAsync(
      VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
      __uuidof(IAudioClient),
      &propvar,
      handler,
      &asyncOp);
  dlog("process loopback pid=%lu: ActivateAudioInterfaceAsync hr=0x%08x", pid, hr);

  if (FAILED(hr) || !asyncOp) {
    handler->Release();
    alive = false;
    CloseHandle(event);
    CoUninitialize();
    return;
  }

  WaitForSingleObject(event, INFINITE);
  CloseHandle(event);

  HRESULT activate_hr = S_OK;
  IUnknown* unk = nullptr;
  asyncOp->GetActivateResult(&activate_hr, &unk);
  asyncOp->Release();
  dlog("process loopback pid=%lu: GetActivateResult hr=0x%08x", pid, activate_hr);

  if (FAILED(activate_hr) || !unk) {
    if (unk) unk->Release();
    alive = false;
    CoUninitialize();
    return;
  }

  IAudioClient* client = nullptr;
  unk->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(&client));
  unk->Release();
  if (!client) {
    dlog("process loopback pid=%lu: QueryInterface(IAudioClient) failed", pid);
    alive = false; CoUninitialize(); return;
  }

  // The process-loopback virtual device is picky about formats and the exact
  // accepted set varies by Windows build. Probe a list in preference order
  // using IsFormatSupported, then Initialize with the first one that S_OK'd.
  // We downmix to mono and resample to our 16 kHz wire rate ourselves, so any
  // standard 16/32-bit stereo/mono format here works downstream.
  const ProcLoopFormat candidates[] = {
    {"stereo PCM16 48k",  WAVE_FORMAT_PCM,        2, 48000, 16},
    {"stereo PCM16 44.1k",WAVE_FORMAT_PCM,        2, 44100, 16},
    {"stereo float 48k",  WAVE_FORMAT_IEEE_FLOAT, 2, 48000, 32},
    {"stereo float 44.1k",WAVE_FORMAT_IEEE_FLOAT, 2, 44100, 32},
    {"mono PCM16 48k",    WAVE_FORMAT_PCM,        1, 48000, 16},
    {"mono PCM16 44.1k",  WAVE_FORMAT_PCM,        1, 44100, 16},
    {"mono float 48k",    WAVE_FORMAT_IEEE_FLOAT, 1, 48000, 32},
  };

  WAVEFORMATEX chosen = {};
  bool have_format = false;
  for (const auto& c : candidates) {
    WAVEFORMATEX wfx = {};
    wfx.wFormatTag = c.format_tag;
    wfx.nChannels = c.channels;
    wfx.nSamplesPerSec = c.rate;
    wfx.wBitsPerSample = c.bits;
    wfx.nBlockAlign = (c.channels * c.bits) / 8;
    wfx.nAvgBytesPerSec = c.rate * wfx.nBlockAlign;

    WAVEFORMATEX* match = nullptr;
    HRESULT supp_hr = client->IsFormatSupported(AUDCLNT_SHAREMODE_SHARED, &wfx, &match);
    dlog("process loopback pid=%lu: IsFormatSupported(%s) hr=0x%08x", pid, c.desc, supp_hr);
    if (match) CoTaskMemFree(match);
    if (supp_hr == S_OK) {
      chosen = wfx;
      have_format = true;
      dlog("process loopback pid=%lu: chose %s", pid, c.desc);
      break;
    }
  }

  if (!have_format) {
    // Fall back to stereo PCM16 48k anyway — IsFormatSupported isn't
    // guaranteed to be honest for virtual devices; Initialize sometimes
    // succeeds on formats it refuses to acknowledge.
    dlog("process loopback pid=%lu: no IsFormatSupported S_OK; trying stereo PCM16 48k blind", pid);
    chosen.wFormatTag     = WAVE_FORMAT_PCM;
    chosen.nChannels      = 2;
    chosen.nSamplesPerSec = 48000;
    chosen.wBitsPerSample = 16;
    chosen.nBlockAlign    = 4;
    chosen.nAvgBytesPerSec= 192000;
  }

  // Process loopback requires the event-callback model — polling silently
  // never sees packets ready, even when the target app is producing sound.
  HANDLE buffer_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!buffer_event) {
    dlog("process loopback pid=%lu: CreateEvent (buffer) failed", pid);
    alive = false; client->Release(); CoUninitialize(); return;
  }

  // 200 ms buffer — process loopback can starve briefly when the target app
  // has no active audio, so we keep some slack.
  REFERENCE_TIME buffer_duration = 2000000;
  hr = client->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
      buffer_duration, 0, &chosen, nullptr);
  dlog("process loopback pid=%lu: Initialize(%dch %uHz %d-bit %s) hr=0x%08x",
       pid, chosen.nChannels, chosen.nSamplesPerSec, chosen.wBitsPerSample,
       chosen.wFormatTag == WAVE_FORMAT_PCM ? "PCM" : "float", hr);

  if (SUCCEEDED(hr)) {
    hr = client->SetEventHandle(buffer_event);
    dlog("process loopback pid=%lu: SetEventHandle hr=0x%08x", pid, hr);
  }

  IAudioCaptureClient* capture = nullptr;
  HANDLE task = nullptr;
  DWORD task_index = 0;
  if (SUCCEEDED(hr)) hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
  if (SUCCEEDED(hr)) task = AvSetMmThreadCharacteristicsW(L"Audio", &task_index);
  if (SUCCEEDED(hr)) {
    hr = client->Start();
    dlog("process loopback pid=%lu: Start hr=0x%08x", pid, hr);
  }

  if (FAILED(hr)) {
    dlog("process loopback pid=%lu: bailing out before capture loop", pid);
    alive = false;
    if (capture) capture->Release();
    if (task) AvRevertMmThreadCharacteristics(task);
    if (client) client->Release();
    CloseHandle(buffer_event);
    CoUninitialize();
    return;
  }

  const bool is_float = (chosen.wFormatTag == WAVE_FORMAT_IEEE_FLOAT);
  const WORD channels = chosen.nChannels;
  const WORD bits = chosen.wBitsPerSample;
  const int in_rate = static_cast<int>(chosen.nSamplesPerSec);
  const WORD bytes_per_sample = bits / 8;
  const WORD frame_bytes = channels * bytes_per_sample;

  Resampler resampler;
  std::vector<int16_t> pending;
  std::vector<float> mono;
  uint64_t total_frames = 0;
  uint64_t total_sent = 0;
  int silent_ticks = 0;

  while (alive && SUCCEEDED(hr)) {
    DWORD wait = WaitForSingleObject(buffer_event, 500);
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) {
      dlog("process loopback pid=%lu: wait failed (0x%lx)", pid, wait);
      break;
    }
    if (wait == WAIT_TIMEOUT) {
      // No audio for 500ms — that's fine, just keep looping. Periodically
      // surface this so the user knows the app might be silent.
      if (++silent_ticks % 20 == 0) {
        dlog("process loopback pid=%lu: %d s without audio (frames=%llu sent=%llu)",
             pid, silent_ticks / 2, (unsigned long long)total_frames, (unsigned long long)total_sent);
      }
      continue;
    }
    silent_ticks = 0;

    // Drain every packet currently ready.
    while (alive) {
      UINT32 packet = 0;
      hr = capture->GetNextPacketSize(&packet);
      if (FAILED(hr)) { dlog("process loopback pid=%lu: GetNextPacketSize hr=0x%08x", pid, hr); break; }
      if (packet == 0) break;

      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) { dlog("process loopback pid=%lu: GetBuffer hr=0x%08x", pid, hr); break; }

      mono.assign(frames, 0.0f);
      if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
        for (UINT32 i = 0; i < frames; ++i) {
          const BYTE* frame = data + i * frame_bytes;
          float sum = 0.0f;
          for (WORD ch = 0; ch < channels; ++ch) {
            sum += sample_to_float(frame + ch * bytes_per_sample, bits, is_float);
          }
          mono[i] = sum / static_cast<float>(channels);
        }
      }
      total_frames += frames;
      capture->ReleaseBuffer(frames);

      std::vector<int16_t> out = resampler.process(mono, in_rate);
      pending.insert(pending.end(), out.begin(), out.end());
      while (pending.size() >= kMaxFrameSamples) {
        const size_t bytes = kMaxFrameSamples * sizeof(int16_t);
        if (!on_frame(reinterpret_cast<const uint8_t*>(pending.data()), bytes)) {
          dlog("process loopback pid=%lu: frame sink failed, closing", pid);
          alive = false;
          break;
        }
        total_sent += kMaxFrameSamples;
        pending.erase(pending.begin(), pending.begin() + kMaxFrameSamples);
      }
    }
  }

  dlog("process loopback pid=%lu: exit (captured %llu frames, sent %llu samples)",
       pid, (unsigned long long)total_frames, (unsigned long long)total_sent);
  if (client) { client->Stop(); client->Release(); }
  if (task) AvRevertMmThreadCharacteristics(task);
  if (capture) capture->Release();
  CloseHandle(buffer_event);
  CoUninitialize();
}

void capture_process_loopback_to_websocket(SOCKET s, DWORD pid, std::atomic<bool>& alive) {
  capture_process_loopback(pid, alive, [s](const uint8_t* data, size_t bytes) {
    return send_ws_binary(s, data, bytes);
  });
}

}  // namespace companion
