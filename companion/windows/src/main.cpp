#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <avrt.h>
#include <bcrypt.h>
#include <initguid.h>
#include <ksmedia.h>
#include <psapi.h>

#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#else
// Process-loopback activation types were added in Windows 10 build 20348.
// Older SDKs don't ship the header — define the bits we need so the source
// still compiles. The runtime requirement is the same either way.
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
typedef enum AUDIOCLIENT_ACTIVATION_TYPE {
  AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
  AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AUDIOCLIENT_ACTIVATION_TYPE;
typedef enum PROCESS_LOOPBACK_MODE {
  PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
  PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} PROCESS_LOOPBACK_MODE;
typedef struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
  DWORD TargetProcessId;
  PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;
typedef struct AUDIOCLIENT_ACTIVATION_PARAMS {
  AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
  union {
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
  } DUMMYUNIONNAME;
} AUDIOCLIENT_ACTIVATION_PARAMS;
#endif

#include <atomic>
#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

namespace {

constexpr int kPort = 52341;
constexpr int kOutputRate = 16000;
constexpr int kMaxFrameSamples = 1600;
constexpr GUID kAudioSubtypeIeeeFloat =
    {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

struct SocketGuard {
  SOCKET s = INVALID_SOCKET;
  ~SocketGuard() { if (s != INVALID_SOCKET) closesocket(s); }
};

struct CoTaskMemDeleter {
  void operator()(void* p) const { CoTaskMemFree(p); }
};

template <typename T>
using CoTaskPtr = std::unique_ptr<T, CoTaskMemDeleter>;

std::string getenv_string(const char* name) {
  const char* value = std::getenv(name);
  return value ? std::string(value) : std::string();
}

// Diagnostic logging. The binary calls FreeConsole() at startup, so stdout is
// useless — write to a file in %TEMP% (or beside the exe if that fails) and
// also mirror to OutputDebugString so DebugView picks it up. Cheap enough that
// we sprinkle it freely on the process-loopback path.
void dlog(const char* fmt, ...) {
  static char path[MAX_PATH] = {};
  static std::atomic<bool> path_set{false};
  if (!path_set.load(std::memory_order_acquire)) {
    DWORD n = GetTempPathA(MAX_PATH, path);
    if (n > 0 && n < MAX_PATH - 40) {
      strcat_s(path + n, MAX_PATH - n, "live-translator-companion.log");
    } else {
      path[0] = '\0';
    }
    path_set.store(true, std::memory_order_release);
  }

  va_list args;
  va_start(args, fmt);
  char msg[512];
  vsnprintf(msg, sizeof(msg), fmt, args);
  va_end(args);

  SYSTEMTIME st;
  GetLocalTime(&st);
  char line[640];
  snprintf(line, sizeof(line), "[%02d:%02d:%02d.%03d] %s\r\n",
           st.wHour, st.wMinute, st.wSecond, st.wMilliseconds, msg);

  OutputDebugStringA(line);

  if (path[0]) {
    static std::mutex log_mutex;
    std::lock_guard<std::mutex> lock(log_mutex);
    FILE* f = nullptr;
    if (fopen_s(&f, path, "a") == 0 && f) {
      fputs(line, f);
      fclose(f);
    }
  }
}

bool starts_with(const std::string& s, const char* prefix) {
  return s.rfind(prefix, 0) == 0;
}

bool is_origin_allowed(const std::string& origin) {
  const std::string configured = getenv_string("LIVE_TRANSLATOR_ALLOWED_ORIGINS");
  if (!configured.empty()) {
    std::stringstream ss(configured);
    std::string item;
    while (std::getline(ss, item, ',')) {
      while (!item.empty() && item.front() == ' ') item.erase(item.begin());
      while (!item.empty() && item.back() == ' ') item.pop_back();
      if (origin == item) return true;
    }
    return false;
  }

  return origin.empty() ||
         origin == "null" ||
         starts_with(origin, "http://localhost") ||
         starts_with(origin, "https://localhost") ||
         starts_with(origin, "http://127.0.0.1") ||
         starts_with(origin, "https://127.0.0.1");
}

std::string header_value(const std::string& req, const std::string& name) {
  const std::string needle = "\r\n" + name + ":";
  size_t pos = req.find(needle);
  if (pos == std::string::npos) return {};
  pos += needle.size();
  while (pos < req.size() && req[pos] == ' ') ++pos;
  size_t end = req.find("\r\n", pos);
  if (end == std::string::npos) return {};
  return req.substr(pos, end - pos);
}

std::string request_target(const std::string& req) {
  size_t first = req.find(' ');
  if (first == std::string::npos) return "/";
  size_t second = req.find(' ', first + 1);
  if (second == std::string::npos) return "/";
  return req.substr(first + 1, second - first - 1);
}

std::string path_only(const std::string& target) {
  size_t q = target.find('?');
  return q == std::string::npos ? target : target.substr(0, q);
}

// Tiny query-string parser. Returns empty string when the key is absent.
// Doesn't bother with percent-decoding because the only value we ever read
// is a numeric process id.
std::string query_param(const std::string& target, const std::string& key) {
  size_t q = target.find('?');
  if (q == std::string::npos) return {};
  std::string query = target.substr(q + 1);
  size_t pos = 0;
  while (pos < query.size()) {
    size_t amp = query.find('&', pos);
    if (amp == std::string::npos) amp = query.size();
    size_t eq = query.find('=', pos);
    if (eq != std::string::npos && eq < amp) {
      if (query.compare(pos, eq - pos, key) == 0) {
        return query.substr(eq + 1, amp - eq - 1);
      }
    }
    pos = amp + 1;
  }
  return {};
}

std::string base64(const uint8_t* data, size_t len) {
  static constexpr char kTable[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  for (size_t i = 0; i < len; i += 3) {
    uint32_t v = data[i] << 16;
    if (i + 1 < len) v |= data[i + 1] << 8;
    if (i + 2 < len) v |= data[i + 2];
    out.push_back(kTable[(v >> 18) & 63]);
    out.push_back(kTable[(v >> 12) & 63]);
    out.push_back(i + 1 < len ? kTable[(v >> 6) & 63] : '=');
    out.push_back(i + 2 < len ? kTable[v & 63] : '=');
  }
  return out;
}

std::string websocket_accept(const std::string& key) {
  const std::string magic = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  uint8_t hash[20] = {};
  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE h = nullptr;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA1_ALGORITHM, nullptr, 0) != 0) return {};
  if (BCryptCreateHash(alg, &h, nullptr, 0, nullptr, 0, 0) != 0) {
    BCryptCloseAlgorithmProvider(alg, 0);
    return {};
  }
  NTSTATUS st = BCryptHashData(h,
      reinterpret_cast<PUCHAR>(const_cast<char*>(magic.data())),
      static_cast<ULONG>(magic.size()), 0);
  if (st == 0) st = BCryptFinishHash(h, hash, sizeof(hash), 0);
  BCryptDestroyHash(h);
  BCryptCloseAlgorithmProvider(alg, 0);
  if (st != 0) return {};
  return base64(hash, sizeof(hash));
}

bool send_all(SOCKET s, const uint8_t* data, size_t len) {
  while (len > 0) {
    int n = send(s, reinterpret_cast<const char*>(data),
                 static_cast<int>(std::min<size_t>(len, 16384)), 0);
    if (n <= 0) return false;
    data += n;
    len -= n;
  }
  return true;
}

bool send_text(SOCKET s, const std::string& text) {
  return send_all(s, reinterpret_cast<const uint8_t*>(text.data()), text.size());
}

bool send_ws_binary(SOCKET s, const uint8_t* data, size_t len) {
  uint8_t hdr[10] = {};
  size_t hdr_len = 0;
  hdr[0] = 0x82;
  if (len < 126) {
    hdr[1] = static_cast<uint8_t>(len);
    hdr_len = 2;
  } else if (len <= 0xffff) {
    hdr[1] = 126;
    hdr[2] = static_cast<uint8_t>((len >> 8) & 0xff);
    hdr[3] = static_cast<uint8_t>(len & 0xff);
    hdr_len = 4;
  } else {
    return false;
  }
  return send_all(s, hdr, hdr_len) && send_all(s, data, len);
}

std::string wide_to_utf8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()),
                              nullptr, 0, nullptr, nullptr);
  if (n <= 0) return {};
  std::string s(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()),
                      s.data(), n, nullptr, nullptr);
  return s;
}

std::string json_escape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 2);
  for (char c : s) {
    switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char hex[8];
          snprintf(hex, sizeof(hex), "\\u%04x", static_cast<unsigned char>(c));
          out += hex;
        } else {
          out += c;
        }
    }
  }
  return out;
}

std::wstring exe_basename(DWORD pid) {
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return {};
  WCHAR buf[MAX_PATH] = {};
  DWORD size = MAX_PATH;
  std::wstring name;
  if (QueryFullProcessImageNameW(h, 0, buf, &size)) {
    name.assign(buf, size);
    size_t slash = name.find_last_of(L"\\/");
    if (slash != std::wstring::npos) name = name.substr(slash + 1);
  }
  CloseHandle(h);
  return name;
}

struct Resampler {
  double pos = 0.0;
  float prev = 0.0f;
  bool has_prev = false;

  std::vector<int16_t> process(const std::vector<float>& mono, int in_rate) {
    std::vector<float> input;
    input.reserve(mono.size() + 1);
    if (has_prev) input.push_back(prev);
    input.insert(input.end(), mono.begin(), mono.end());
    if (input.empty()) return {};

    const double ratio = static_cast<double>(in_rate) / kOutputRate;
    std::vector<int16_t> out;
    while (pos + 1.0 < input.size()) {
      const size_t i = static_cast<size_t>(pos);
      const double frac = pos - i;
      float v = input[i] + static_cast<float>((input[i + 1] - input[i]) * frac);
      if (v > 1.0f) v = 1.0f;
      if (v < -1.0f) v = -1.0f;
      out.push_back(v < 0 ? static_cast<int16_t>(v * 32768.0f)
                          : static_cast<int16_t>(v * 32767.0f));
      pos += ratio;
    }
    pos -= static_cast<double>(mono.size());
    prev = input.back();
    has_prev = true;
    return out;
  }
};

float sample_to_float(const BYTE* p, WORD bits, bool is_float) {
  if (is_float && bits == 32) return *reinterpret_cast<const float*>(p);
  if (bits == 16) return *reinterpret_cast<const int16_t*>(p) / 32768.0f;
  if (bits == 24) {
    int32_t v = (p[0] | (p[1] << 8) | (p[2] << 16));
    if (v & 0x800000) v |= 0xff000000;
    return v / 8388608.0f;
  }
  if (bits == 32) return *reinterpret_cast<const int32_t*>(p) / 2147483648.0f;
  return 0.0f;
}

bool is_float_format(const WAVEFORMATEX* fmt) {
  if (fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) return true;
  if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
    auto ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(fmt);
    return IsEqualGUID(ext->SubFormat, kAudioSubtypeIeeeFloat);
  }
  return false;
}

// ─── System (default render device) loopback ────────────────────────────────
// Captures everything the user can hear. Used when /audio is opened without a
// pid= query parameter.
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

// ─── Process loopback ───────────────────────────────────────────────────────
// Uses ActivateAudioInterfaceAsync with a process-loopback activation blob.
// Requires Windows 10 build 20348 / Windows 11. The captured stream covers the
// target pid and its child processes, which matters for browsers and other
// multi-process apps. Format is requested as 16 kHz mono PCM16 directly, so
// no resampling is needed.
class ActivationHandler : public IActivateAudioInterfaceCompletionHandler {
 public:
  HANDLE event = nullptr;
  STDMETHODIMP_(ULONG) AddRef() override { return 1; }
  STDMETHODIMP_(ULONG) Release() override { return 1; }
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    // IAgileObject is REQUIRED here. ActivateAudioInterfaceAsync QIs for it
    // synchronously and rejects the call with E_ILLEGAL_METHOD_CALL (0x8000000e)
    // when it's not supported — the audio service needs to know it can
    // safely call our handler from its own MTA worker thread.
    if (riid == __uuidof(IUnknown) ||
        riid == __uuidof(IAgileObject) ||
        riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation*) override {
    SetEvent(event);
    return S_OK;
  }
};

struct ProcLoopFormat {
  const char* desc;
  WORD format_tag;
  WORD channels;
  DWORD rate;
  WORD bits;
};

void capture_process_loopback_to_websocket(SOCKET s, DWORD pid, std::atomic<bool>& alive) {
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

  ActivationHandler handler;
  handler.event = event;

  IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
  HRESULT hr = ActivateAudioInterfaceAsync(
      VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
      __uuidof(IAudioClient),
      &propvar,
      &handler,
      &asyncOp);
  dlog("process loopback pid=%lu: ActivateAudioInterfaceAsync hr=0x%08x", pid, hr);

  if (FAILED(hr) || !asyncOp) {
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
        if (!send_ws_binary(s, reinterpret_cast<const uint8_t*>(pending.data()), bytes)) {
          dlog("process loopback pid=%lu: send_ws_binary failed, closing", pid);
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

// ─── Audio app enumeration ──────────────────────────────────────────────────
// Walks the default render device's audio sessions, groups by exe name, and
// returns one entry per app. We pick the lowest pid we see for each exe — for
// multi-process apps (Chrome, Discord, …) PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
// captures from the chosen pid plus its descendants, so the root pid catches
// everything.
struct AppInfo {
  DWORD pid;
  std::string name;          // exe basename, UTF-8
  std::string displayName;   // session DisplayName or exe name, UTF-8
};

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

// ─── Push-to-talk hotkey ────────────────────────────────────────────────────
// Web clients open ws://127.0.0.1:52341/hotkey and send a JSON bind message
// like {"action":"bind","vkCode":32,"ctrl":true,"shift":false,"alt":false,"win":false}.
// A single global low-level keyboard hook fans key events to every open
// connection that has a matching binding, sending {"event":"down"} on press
// and {"event":"up"} on release. The hook fires regardless of which window
// has focus — that's the whole point of using the companion process.
struct HotkeyBinding {
  DWORD vkCode = 0;
  bool ctrl = false, shift = false, alt = false, win = false;
  std::atomic<bool> held{false};
};

struct HotkeyConnection {
  SOCKET sock = INVALID_SOCKET;
  std::mutex bindMutex;
  HotkeyBinding binding;
  std::atomic<bool> alive{true};
  std::mutex sendMutex;          // serialise writes (hook thread + pong sender)
};

std::mutex g_hotkey_mutex;
std::vector<std::shared_ptr<HotkeyConnection>> g_hotkey_connections;
std::atomic<bool> g_hook_started{false};

bool ws_send_text(HotkeyConnection& conn, const std::string& text) {
  uint8_t hdr[4];
  size_t hdr_len;
  hdr[0] = 0x81;                  // FIN + opcode=text
  const size_t len = text.size();
  if (len < 126) {
    hdr[1] = static_cast<uint8_t>(len);
    hdr_len = 2;
  } else if (len <= 0xFFFF) {
    hdr[1] = 126;
    hdr[2] = static_cast<uint8_t>((len >> 8) & 0xff);
    hdr[3] = static_cast<uint8_t>(len & 0xff);
    hdr_len = 4;
  } else {
    return false;
  }
  std::lock_guard<std::mutex> lock(conn.sendMutex);
  if (!conn.alive) return false;
  return send_all(conn.sock, hdr, hdr_len) &&
         send_all(conn.sock, reinterpret_cast<const uint8_t*>(text.data()), len);
}

LRESULT CALLBACK hotkey_hook_proc(int nCode, WPARAM wParam, LPARAM lParam) {
  if (nCode == HC_ACTION) {
    const KBDLLHOOKSTRUCT* k = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);
    const bool isDown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
    const bool isUp   = (wParam == WM_KEYUP   || wParam == WM_SYSKEYUP);
    if (isDown || isUp) {
      const bool ctrl  = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
      const bool shift = (GetAsyncKeyState(VK_SHIFT)   & 0x8000) != 0;
      const bool alt   = (GetAsyncKeyState(VK_MENU)    & 0x8000) != 0;
      const bool win   = ((GetAsyncKeyState(VK_LWIN) | GetAsyncKeyState(VK_RWIN)) & 0x8000) != 0;

      // Snapshot the list under the lock; iterate without it so a slow send()
      // never holds the global mutex (and never blocks /audio handshakes).
      std::vector<std::shared_ptr<HotkeyConnection>> snapshot;
      {
        std::lock_guard<std::mutex> lock(g_hotkey_mutex);
        snapshot = g_hotkey_connections;
      }
      for (auto& conn : snapshot) {
        if (!conn->alive.load()) continue;
        DWORD vk;
        bool wantCtrl, wantShift, wantAlt, wantWin;
        {
          std::lock_guard<std::mutex> bl(conn->bindMutex);
          vk        = conn->binding.vkCode;
          wantCtrl  = conn->binding.ctrl;
          wantShift = conn->binding.shift;
          wantAlt   = conn->binding.alt;
          wantWin   = conn->binding.win;
        }
        if (vk == 0 || k->vkCode != vk) continue;
        if (isDown) {
          // Modifier check only on press — the user may release modifiers
          // before the main key, and we still want a clean UP event.
          if (wantCtrl != ctrl || wantShift != shift ||
              wantAlt != alt   || wantWin != win) continue;
          if (!conn->binding.held.exchange(true)) {
            ws_send_text(*conn, R"({"event":"down"})");
          }
        } else {
          if (conn->binding.held.exchange(false)) {
            ws_send_text(*conn, R"({"event":"up"})");
          }
        }
      }
    }
  }
  return CallNextHookEx(nullptr, nCode, wParam, lParam);
}

void hotkey_hook_thread() {
  // The low-level hook needs a message pump on its installing thread.
  HHOOK hook = SetWindowsHookExW(WH_KEYBOARD_LL, hotkey_hook_proc,
                                 GetModuleHandleW(nullptr), 0);
  if (!hook) {
    dlog("SetWindowsHookExW(WH_KEYBOARD_LL) failed: %lu", GetLastError());
    return;
  }
  MSG msg;
  while (GetMessage(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessage(&msg);
  }
  UnhookWindowsHookEx(hook);
}

void ensure_hotkey_hook_thread() {
  bool expected = false;
  if (g_hook_started.compare_exchange_strong(expected, true)) {
    std::thread(hotkey_hook_thread).detach();
  }
}

// Tiny JSON-ish parsers — the wire protocol is flat (action / vkCode / bools)
// and fully under our control, so we avoid pulling in a JSON dependency.
DWORD json_int(const std::string& s, const char* key, DWORD def) {
  std::string needle = std::string("\"") + key + "\"";
  size_t p = s.find(needle);
  if (p == std::string::npos) return def;
  p += needle.size();
  while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == ':')) ++p;
  size_t end = p;
  while (end < s.size() && isdigit(static_cast<unsigned char>(s[end]))) ++end;
  if (end == p) return def;
  try { return static_cast<DWORD>(std::stoul(s.substr(p, end - p))); }
  catch (...) { return def; }
}

bool json_bool(const std::string& s, const char* key) {
  std::string needle = std::string("\"") + key + "\"";
  size_t p = s.find(needle);
  if (p == std::string::npos) return false;
  p += needle.size();
  while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == ':')) ++p;
  return p + 4 <= s.size() && s.compare(p, 4, "true") == 0;
}

bool json_action_is(const std::string& s, const char* value) {
  size_t p = s.find("\"action\"");
  if (p == std::string::npos) return false;
  p += 8;
  while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == ':')) ++p;
  if (p >= s.size() || s[p] != '"') return false;
  ++p;
  size_t end = s.find('"', p);
  if (end == std::string::npos) return false;
  const size_t want = std::strlen(value);
  return (end - p) == want && s.compare(p, want, value) == 0;
}

void hotkey_session_loop(SOCKET sock) {
  ensure_hotkey_hook_thread();

  auto conn = std::make_shared<HotkeyConnection>();
  conn->sock = sock;
  {
    std::lock_guard<std::mutex> lock(g_hotkey_mutex);
    g_hotkey_connections.push_back(conn);
  }

  // Inline WebSocket frame reader — keeps pong sends + binding mutex in
  // scope so they don't need separate plumbing.
  for (;;) {
    uint8_t hdr[2];
    if (recv(sock, reinterpret_cast<char*>(hdr), 2, MSG_WAITALL) != 2) break;
    const bool fin   = (hdr[0] & 0x80) != 0;
    const uint8_t op = hdr[0] & 0x0F;
    const bool masked = (hdr[1] & 0x80) != 0;
    uint64_t len = hdr[1] & 0x7F;
    if (len == 126) {
      uint8_t ext[2];
      if (recv(sock, reinterpret_cast<char*>(ext), 2, MSG_WAITALL) != 2) break;
      len = (static_cast<uint64_t>(ext[0]) << 8) | ext[1];
    } else if (len == 127) {
      uint8_t ext[8];
      if (recv(sock, reinterpret_cast<char*>(ext), 8, MSG_WAITALL) != 8) break;
      len = 0;
      for (int i = 0; i < 8; ++i) len = (len << 8) | ext[i];
    }
    if (len > (1u << 16)) break;        // safety cap (our messages are tiny)
    uint8_t mask[4] = {};
    if (masked && recv(sock, reinterpret_cast<char*>(mask), 4, MSG_WAITALL) != 4) break;
    std::string payload(static_cast<size_t>(len), '\0');
    size_t got = 0;
    bool ok = true;
    while (got < len) {
      int r = recv(sock, payload.data() + got, static_cast<int>(len - got), 0);
      if (r <= 0) { ok = false; break; }
      got += r;
    }
    if (!ok) break;
    if (masked) {
      for (size_t i = 0; i < payload.size(); ++i) payload[i] ^= mask[i & 3];
    }

    if (op == 0x8) break;                                       // close
    if (op == 0x9) {                                            // ping → pong
      uint8_t pong_hdr[4];
      size_t pong_hdr_len;
      pong_hdr[0] = 0x8A;
      if (payload.size() < 126) {
        pong_hdr[1] = static_cast<uint8_t>(payload.size());
        pong_hdr_len = 2;
      } else {
        pong_hdr[1] = 126;
        pong_hdr[2] = static_cast<uint8_t>((payload.size() >> 8) & 0xff);
        pong_hdr[3] = static_cast<uint8_t>(payload.size() & 0xff);
        pong_hdr_len = 4;
      }
      std::lock_guard<std::mutex> sl(conn->sendMutex);
      if (!send_all(sock, pong_hdr, pong_hdr_len)) break;
      if (!payload.empty() &&
          !send_all(sock, reinterpret_cast<const uint8_t*>(payload.data()), payload.size())) break;
      continue;
    }
    if (op == 0xA) continue;                                    // pong → ignore
    if (op != 0x1 || !fin) continue;                            // not a complete text frame

    if (json_action_is(payload, "bind")) {
      std::lock_guard<std::mutex> bl(conn->bindMutex);
      conn->binding.vkCode = json_int(payload, "vkCode", 0);
      conn->binding.ctrl   = json_bool(payload, "ctrl");
      conn->binding.shift  = json_bool(payload, "shift");
      conn->binding.alt    = json_bool(payload, "alt");
      conn->binding.win    = json_bool(payload, "win");
      conn->binding.held   = false;
    } else if (json_action_is(payload, "unbind")) {
      std::lock_guard<std::mutex> bl(conn->bindMutex);
      conn->binding.vkCode = 0;
      conn->binding.held = false;
    }
  }

  conn->alive = false;
  std::lock_guard<std::mutex> lock(g_hotkey_mutex);
  g_hotkey_connections.erase(
      std::remove_if(g_hotkey_connections.begin(), g_hotkey_connections.end(),
                     [&](auto& c) { return c.get() == conn.get(); }),
      g_hotkey_connections.end());
}

// ─── HTTP / WebSocket router ────────────────────────────────────────────────
void handle_client(SOCKET accepted) {
  SocketGuard client{accepted};
  char buf[8192] = {};
  int n = recv(client.s, buf, sizeof(buf) - 1, 0);
  if (n <= 0) return;
  std::string req(buf, n);
  const std::string target = request_target(req);
  const std::string path = path_only(target);
  const std::string origin = header_value(req, "Origin");

  const std::string cors =
      "Access-Control-Allow-Origin: " + (origin.empty() ? std::string("null") : origin) + "\r\n"
      "Access-Control-Allow-Methods: GET, OPTIONS\r\n"
      "Access-Control-Allow-Headers: Content-Type, X-Live-Translator\r\n"
      "Access-Control-Allow-Private-Network: true\r\n";

  if (!is_origin_allowed(origin)) {
    send_text(client.s, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    return;
  }

  if (starts_with(req, "OPTIONS ")) {
    send_text(client.s, "HTTP/1.1 204 No Content\r\n" + cors + "Content-Length: 0\r\n\r\n");
    return;
  }

  if (path == "/status") {
    const std::string body =
        "{\"status\":\"ok\",\"version\":\"0.3.0\","
        "\"audio\":\"pcm16-16000-mono\","
        "\"features\":[\"system-loopback\",\"process-loopback\",\"app-enumeration\",\"ptt-hotkey\"]}";
    send_text(client.s, "HTTP/1.1 200 OK\r\n" + cors +
                        "Content-Type: application/json\r\n"
                        "Cache-Control: no-store\r\n"
                        "Content-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body);
    return;
  }

  if (path == "/apps") {
    auto apps = enumerate_audio_apps();
    const std::string body = serialize_apps(apps);
    send_text(client.s, "HTTP/1.1 200 OK\r\n" + cors +
                        "Content-Type: application/json\r\n"
                        "Cache-Control: no-store\r\n"
                        "Content-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body);
    return;
  }

  if (path == "/audio") {
    const std::string key = header_value(req, "Sec-WebSocket-Key");
    const std::string accept = websocket_accept(key);
    if (key.empty() || accept.empty()) {
      send_text(client.s, "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    send_text(client.s,
              "HTTP/1.1 101 Switching Protocols\r\n"
              "Upgrade: websocket\r\n"
              "Connection: Upgrade\r\n"
              "Sec-WebSocket-Accept: " + accept + "\r\n\r\n");

    DWORD pid = 0;
    const std::string pid_str = query_param(target, "pid");
    if (!pid_str.empty()) {
      try { pid = static_cast<DWORD>(std::stoul(pid_str)); }
      catch (...) { pid = 0; }
    }

    std::atomic<bool> alive{true};
    std::thread capture([&] {
      if (pid != 0) capture_process_loopback_to_websocket(client.s, pid, alive);
      else          capture_system_loopback_to_websocket(client.s, alive);
    });
    while (alive) {
      char tmp[2] = {};
      int r = recv(client.s, tmp, sizeof(tmp), 0);
      if (r <= 0) alive = false;
    }
    if (capture.joinable()) capture.join();
    return;
  }

  if (path == "/hotkey") {
    const std::string key = header_value(req, "Sec-WebSocket-Key");
    const std::string accept = websocket_accept(key);
    if (key.empty() || accept.empty()) {
      send_text(client.s, "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    send_text(client.s,
              "HTTP/1.1 101 Switching Protocols\r\n"
              "Upgrade: websocket\r\n"
              "Connection: Upgrade\r\n"
              "Sec-WebSocket-Accept: " + accept + "\r\n\r\n");
    hotkey_session_loop(client.s);
    return;
  }

  send_text(client.s, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
}

}  // namespace

int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
  FreeConsole();
  WSADATA wsa = {};
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 1;

  SocketGuard server{socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)};
  if (server.s == INVALID_SOCKET) return 1;

  BOOL reuse = TRUE;
  setsockopt(server.s, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse), sizeof(reuse));

  sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(kPort);
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

  if (bind(server.s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) return 1;
  if (listen(server.s, SOMAXCONN) != 0) return 1;

  while (true) {
    SOCKET client = accept(server.s, nullptr, nullptr);
    if (client == INVALID_SOCKET) continue;
    std::thread(handle_client, client).detach();
  }

  WSACleanup();
  return 0;
}
