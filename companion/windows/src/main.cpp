#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <avrt.h>
#include <bcrypt.h>
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

#include <propsys.h>

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwctype>
#include <deque>
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
// Realistic ceiling for a single web page across a handful of sessions plus
// some polling traffic. Past this we 503 new connections; the local-only
// audience makes this purely a fork-bomb guardrail, not a throughput knob.
constexpr int kMaxConnections = 32;
// MinGW's ksmedia.h declares KSDATAFORMAT_SUBTYPE_IEEE_FLOAT as an extern in
// some SDK versions, so keep local storage for the GUID we need at runtime.
const GUID kKsDataFormatSubtypeIeeeFloat = {
    0x00000003, 0x0000, 0x0010,
    {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

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
// useless — write to a file in %TEMP% and mirror to OutputDebugString so
// DebugView picks it up. Cheap enough that we sprinkle it freely on the
// process-loopback path; the log file handle is opened once via call_once
// and reused (the previous implementation opened/closed per call, which
// became measurable during the every-500ms silent-tick heartbeat).
void dlog(const char* fmt, ...) {
  static FILE* log_file = nullptr;
  static std::once_flag init_flag;
  static std::mutex log_mutex;
  std::call_once(init_flag, [] {
    char path[MAX_PATH];
    DWORD n = GetTempPathA(MAX_PATH, path);
    if (n == 0 || n >= MAX_PATH - 40) return;
    if (strcat_s(path + n, MAX_PATH - n, "live-translator-companion.log") != 0) return;
    // Opened "ab" so writes from a previous run are preserved and so we can
    // fflush each line for crash visibility without sweeping over prior text.
    fopen_s(&log_file, path, "ab");
  });

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

  if (log_file) {
    std::lock_guard<std::mutex> lock(log_mutex);
    fputs(line, log_file);
    fflush(log_file);
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
         starts_with(origin, "https://127.0.0.1") ||
         origin == "https://rajib884.github.io";
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
    return IsEqualGUID(ext->SubFormat, kKsDataFormatSubtypeIeeeFloat);
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
  explicit ActivationHandler(HANDLE event_handle) : event(event_handle) {}
  STDMETHODIMP_(ULONG) AddRef() override {
    return static_cast<ULONG>(refCount.fetch_add(1, std::memory_order_relaxed) + 1);
  }
  STDMETHODIMP_(ULONG) Release() override {
    const ULONG refs = static_cast<ULONG>(refCount.fetch_sub(1, std::memory_order_acq_rel) - 1);
    if (refs == 0) delete this;
    return refs;
  }
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
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation*) override {
    SetEvent(event);
    Release();
    return S_OK;
  }
 private:
  std::atomic<ULONG> refCount{1};
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

// ─── Endpoint enumeration (render + capture) ────────────────────────────────
// Used by /outputs to advertise render endpoints to the browser, and by the
// passthrough engine to resolve the user-picked mic label against the actual
// WASAPI capture endpoints (browser device IDs are origin-hashed and useless
// outside the browser, so we match by friendly name).

// PKEY_Device_FriendlyName from functiondiscoverykeys_devpkey.h. Inlined so
// the build doesn't pull that header (which is missing in some toolchains).
const PROPERTYKEY kDeviceFriendlyNameKey = {
    {0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 14};

struct EndpointInfo {
  std::wstring id;     // WASAPI device id ("{0.0.0.00000000}.{...guid...}")
  std::wstring name;   // friendly name
  bool isDefault = false;
};

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

// Open an IMMDevice* for a specific render/capture endpoint id. Caller must
// Release() the returned pointer. Returns nullptr on miss.
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

// Fuzzy match a label against capture-endpoint friendly names. We try exact
// match first, then case-insensitive containment in either direction. Returns
// AddRef'd IMMDevice* (caller must Release), or nullptr on miss. The "label"
// is what the browser saw from MediaDeviceInfo.label, which is usually the
// same string Windows reports as the endpoint friendly name.
std::wstring lower(std::wstring s) {
  for (auto& c : s) c = static_cast<wchar_t>(towlower(c));
  return s;
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

// ─── Per-session passthrough engine ─────────────────────────────────────────
// One PassthroughSession per WebSocket connection on /passthrough. Owns:
//   - 0..N output sinks (each a render endpoint + render thread + mix buffer)
//   - 0..1 mic source thread (WASAPI capture endpoint)
//   - 0..1 loopback source thread (system loopback or per-pid loopback)
//
// Sources push float-stereo samples at 48 kHz into every active sink's ring
// buffer (mix-by-frame-position with simple summation). Sinks drain at their
// device's render cadence and write to WASAPI. Mixing imperfection under
// concurrent producers is tolerated — the typical case is one source, and
// "both" sessions accept some drift as a known limitation.
constexpr int kPtMixRate = 48000;
constexpr int kPtMixChans = 2;
constexpr size_t kPtRingFrames = 48000;  // 1 sec of slack absorbs source/sink drift

struct PtRing {
  std::mutex mu;
  std::vector<float> L;
  std::vector<float> R;
  uint64_t readFrame = 0;
  uint64_t writeFrame = 0;
  PtRing() : L(kPtRingFrames, 0.0f), R(kPtRingFrames, 0.0f) {}

  // Mix-add n stereo frames starting at absolute startFrame. Drops samples
  // older than readFrame; caps anything beyond readFrame + kPtRingFrames.
  void mixIn(uint64_t startFrame, const float* inL, const float* inR, size_t n) {
    std::lock_guard<std::mutex> lock(mu);
    if (startFrame + n <= readFrame) return;            // entirely stale
    if (startFrame < readFrame) {
      const uint64_t skip = readFrame - startFrame;
      inL += skip; inR += skip;
      n -= static_cast<size_t>(skip);
      startFrame = readFrame;
    }
    const uint64_t maxFrame = readFrame + kPtRingFrames;
    if (startFrame >= maxFrame) return;
    if (startFrame + n > maxFrame) n = static_cast<size_t>(maxFrame - startFrame);
    for (size_t i = 0; i < n; ++i) {
      size_t idx = static_cast<size_t>((startFrame + i) % kPtRingFrames);
      L[idx] += inL[i];
      R[idx] += inR[i];
    }
    if (startFrame + n > writeFrame) writeFrame = startFrame + n;
  }

  // Drain up to n stereo frames into outL/outR (always fills with zeros if
  // underrun). Returns the number of non-silent frames produced. Zeroes the
  // ring cells it consumes so the next mix starts fresh.
  size_t consume(float* outL, float* outR, size_t n) {
    std::lock_guard<std::mutex> lock(mu);
    const uint64_t avail = (writeFrame > readFrame) ? (writeFrame - readFrame) : 0;
    const size_t take = static_cast<size_t>(std::min<uint64_t>(avail, n));
    for (size_t i = 0; i < take; ++i) {
      size_t idx = static_cast<size_t>((readFrame + i) % kPtRingFrames);
      float l = L[idx]; if (l > 1.0f) l = 1.0f; if (l < -1.0f) l = -1.0f;
      float r = R[idx]; if (r > 1.0f) r = 1.0f; if (r < -1.0f) r = -1.0f;
      outL[i] = l; outR[i] = r;
      L[idx] = 0.0f; R[idx] = 0.0f;
    }
    for (size_t i = take; i < n; ++i) { outL[i] = 0.0f; outR[i] = 0.0f; }
    readFrame += n;
    return take;
  }
};

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

class PassthroughSession {
 public:
  explicit PassthroughSession(SOCKET s) : sock(s) {
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

  // Stop and join every source/sink thread. Safe to call multiple times.
  void shutdown() {
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

  ~PassthroughSession() { shutdown(); }

  // ─── Public reconfigure entry point — called from WS handler thread.
  // payload is the raw JSON text frame. Diff against current state and
  // start/stop sources + sinks as needed.
  void configure(const std::string& payload);

  // Browser → companion: closes the socket cleanly.
  void close_socket() {
    if (sockAlive.exchange(false)) {
      ::shutdown(sock, SD_BOTH);
    }
  }

  // Drive a periodic level event (peak across all sinks). Called by the
  // session's WS handler thread between reads.
  void emit_level_if_due() {
    using clk = std::chrono::steady_clock;
    auto now = clk::now();
    if (now - lastLevelAt < std::chrono::milliseconds(80)) return;
    lastLevelAt = now;
    float p = peakLevel.exchange(0.0f);
    send_json("{\"event\":\"level\",\"peak\":" + format_float(p) + "}");
  }

  void send_event_ready(const std::vector<std::string>& warnings,
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

  bool socket_alive() const { return sockAlive.load(); }

 private:
  SOCKET sock;
  std::atomic<bool> sockAlive{true};
  std::atomic<bool> running{true};
  std::mutex sendMu;

  std::mutex sinksMu;
  std::vector<std::unique_ptr<PtSink>> sinks;

  std::thread micThread;
  std::thread loopbackThread;
  std::thread levelThread;
  std::atomic<bool> micAlive{false};
  std::atomic<bool> loopbackAlive{false};
  PtSourceConfig srcCfg;

  std::atomic<float> peakLevel{0.0f};
  std::chrono::steady_clock::time_point lastLevelAt = std::chrono::steady_clock::now();

  // Per-source frame counters. Start at 0 when the source thread launches;
  // each source treats time-since-launch as its absolute mix position. Mild
  // drift between sources is absorbed by the ring buffer.
  void mic_source_thread();
  void loopback_source_thread();
  void sink_render_thread(PtSink* sink);

  // Distribute n stereo frames into every active sink. startFrame is the
  // source's monotonic frame counter (each source has its own — close enough
  // for passthrough use).
  void distribute(uint64_t startFrame, const float* L, const float* R, size_t n) {
    std::lock_guard<std::mutex> lock(sinksMu);
    for (auto& s : sinks) {
      if (s->alive.load()) s->ring.mixIn(startFrame, L, R, n);
    }
  }

  void update_peak(float p) {
    float prev = peakLevel.load();
    while (p > prev && !peakLevel.compare_exchange_weak(prev, p)) {}
  }

  static std::string format_float(float f) {
    char b[32];
    snprintf(b, sizeof(b), "%.4f", f);
    return b;
  }

  bool send_json(const std::string& text) {
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

};

// Forward decls — these JSON parsers live further down with the PTT code,
// but PassthroughSession::configure() needs to call them. Keep them up here
// so the pre-existing parsers (used by the PTT section) don't move.
DWORD json_int(const std::string& s, const char* key, DWORD def);
bool json_bool(const std::string& s, const char* key);
bool json_action_is(const std::string& s, const char* value);

// Parse helpers for /passthrough configure payloads. The JSON is small and
// flat enough that bespoke parsers stay simpler than dragging in a library.
std::string json_string(const std::string& s, const char* key) {
  std::string needle = std::string("\"") + key + "\"";
  size_t p = s.find(needle);
  if (p == std::string::npos) return {};
  p += needle.size();
  while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == ':')) ++p;
  if (p >= s.size() || s[p] != '"') return {};
  ++p;
  std::string out;
  while (p < s.size() && s[p] != '"') {
    if (s[p] == '\\' && p + 1 < s.size()) {
      char esc = s[p + 1];
      switch (esc) {
        case '\\': out += '\\'; break;
        case '"':  out += '"';  break;
        case 'n':  out += '\n'; break;
        case 'r':  out += '\r'; break;
        case 't':  out += '\t'; break;
        case '/':  out += '/';  break;
        case 'u': {
          // Minimal \uXXXX handling for BMP chars; encode as UTF-8.
          if (p + 5 < s.size()) {
            unsigned cp = 0;
            sscanf_s(s.substr(p + 2, 4).c_str(), "%x", &cp);
            if (cp < 0x80) out += (char)cp;
            else if (cp < 0x800) {
              out += (char)(0xC0 | (cp >> 6));
              out += (char)(0x80 | (cp & 0x3F));
            } else {
              out += (char)(0xE0 | (cp >> 12));
              out += (char)(0x80 | ((cp >> 6) & 0x3F));
              out += (char)(0x80 | (cp & 0x3F));
            }
            p += 6; continue;
          }
          break;
        }
        default: out += esc; break;
      }
      p += 2;
    } else {
      out += s[p++];
    }
  }
  return out;
}

// Pull each string element from a JSON array under "key". Tolerates simple
// whitespace and the kind of escapes browsers actually emit.
std::vector<std::string> json_string_array(const std::string& s, const char* key) {
  std::vector<std::string> out;
  std::string needle = std::string("\"") + key + "\"";
  size_t p = s.find(needle);
  if (p == std::string::npos) return out;
  p += needle.size();
  while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == ':')) ++p;
  if (p >= s.size() || s[p] != '[') return out;
  ++p;
  while (p < s.size() && s[p] != ']') {
    while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == ',' || s[p] == '\n' || s[p] == '\r')) ++p;
    if (p >= s.size() || s[p] == ']') break;
    if (s[p] != '"') { ++p; continue; }
    ++p;
    std::string item;
    while (p < s.size() && s[p] != '"') {
      if (s[p] == '\\' && p + 1 < s.size()) { item += s[p + 1]; p += 2; }
      else item += s[p++];
    }
    if (p < s.size()) ++p;  // closing "
    out.push_back(std::move(item));
  }
  return out;
}

// ─── Source threads ─────────────────────────────────────────────────────────
// A small helper: linear resampler from in_rate to 48 kHz with state retained
// across calls so chunk boundaries don't introduce clicks. Mirrors the existing
// Resampler used for /audio uplink but stays per-call and produces stereo.
struct StereoResampler {
  double pos = 0.0;
  float prevL = 0.0f, prevR = 0.0f;
  bool has_prev = false;

  void process(const std::vector<float>& inL, const std::vector<float>& inR,
               int in_rate, std::vector<float>& outL, std::vector<float>& outR) {
    if (inL.empty()) return;
    std::vector<float> aL, aR;
    aL.reserve(inL.size() + 1);
    aR.reserve(inR.size() + 1);
    if (has_prev) { aL.push_back(prevL); aR.push_back(prevR); }
    aL.insert(aL.end(), inL.begin(), inL.end());
    aR.insert(aR.end(), inR.begin(), inR.end());
    const double ratio = static_cast<double>(in_rate) / kPtMixRate;
    while (pos + 1.0 < aL.size()) {
      const size_t i = (size_t)pos;
      const double frac = pos - i;
      outL.push_back(aL[i] + (float)((aL[i + 1] - aL[i]) * frac));
      outR.push_back(aR[i] + (float)((aR[i + 1] - aR[i]) * frac));
      pos += ratio;
    }
    pos -= static_cast<double>(inL.size());
    prevL = aL.back(); prevR = aR.back(); has_prev = true;
  }
};

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

void passthrough_session_loop(SOCKET sock) {
  PassthroughSession session(sock);

  for (;;) {
    uint8_t hdr[2];
    int rh = recv(sock, reinterpret_cast<char*>(hdr), 2, MSG_WAITALL);
    if (rh != 2) break;
    const bool fin = (hdr[0] & 0x80) != 0;
    const uint8_t op = hdr[0] & 0x0F;
    const bool masked = (hdr[1] & 0x80) != 0;
    uint64_t len = hdr[1] & 0x7F;
    if (len == 126) {
      uint8_t ext[2];
      if (recv(sock, reinterpret_cast<char*>(ext), 2, MSG_WAITALL) != 2) break;
      len = ((uint64_t)ext[0] << 8) | ext[1];
    } else if (len == 127) {
      uint8_t ext[8];
      if (recv(sock, reinterpret_cast<char*>(ext), 8, MSG_WAITALL) != 8) break;
      len = 0;
      for (int i = 0; i < 8; ++i) len = (len << 8) | ext[i];
    }
    if (len > (1u << 18)) break;  // 256 KB cap for configure payloads
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

    if (op == 0x8) break;                                     // close
    if (op == 0x9) {                                          // ping → pong
      uint8_t pong[4];
      size_t pong_len;
      pong[0] = 0x8A;
      if (payload.size() < 126) { pong[1] = (uint8_t)payload.size(); pong_len = 2; }
      else {
        pong[1] = 126;
        pong[2] = (uint8_t)((payload.size() >> 8) & 0xff);
        pong[3] = (uint8_t)(payload.size() & 0xff);
        pong_len = 4;
      }
      if (!send_all(sock, pong, pong_len)) break;
      if (!payload.empty() &&
          !send_all(sock, (const uint8_t*)payload.data(), payload.size())) break;
      continue;
    }
    if (op == 0xA) continue;                                  // pong → ignore
    if (op != 0x1 || !fin) continue;                          // not complete text

    if (json_action_is(payload, "configure")) {
      session.configure(payload);
    } else if (json_action_is(payload, "stop")) {
      break;
    }
    session.emit_level_if_due();
  }

  session.shutdown();
}

// ─── Push-to-talk hotkey ────────────────────────────────────────────────────
// Web clients open ws://127.0.0.1:52341/hotkey and send a JSON bind message
// like {"action":"bind","vkCode":32,"ctrl":true,"shift":false,"alt":false,"win":false}.
// A single global low-level keyboard hook fans key events to every open
// connection that has a matching binding, sending {"event":"down"} on press
// and {"event":"up"} on release. The hook fires regardless of which window
// has focus — that's the whole point of using the companion process.
//
// Exclusive capture (opt-in via `"exclusive":true` in the bind message): when
// set and the bound vkCode matches (with modifiers on DOWN), the hook returns
// non-zero so the event is dropped before any other app sees it. Only the
// bound *main* key is swallowed; modifier keys themselves (bare Ctrl/Shift/
// Alt/Win events) always pass through, so shortcuts like Ctrl+C keep working.
// Default is non-exclusive: clients observe the key without consuming it,
// matching pre-toggle behaviour. When all pages with bindings close, the
// connections are removed and the hook falls through normally, restoring
// default keyboard behaviour.
struct HotkeyBinding {
  DWORD vkCode = 0;
  bool ctrl = false, shift = false, alt = false, win = false;
  // When true, the hook swallows the bound key so other apps don't see it.
  // Off by default — opt-in from the web client per bind message.
  bool exclusive = false;
  std::atomic<bool> held{false};
};

struct HotkeyConnection {
  SOCKET sock = INVALID_SOCKET;
  std::mutex bindMutex;
  HotkeyBinding binding;
  std::atomic<bool> alive{true};
  std::mutex sendMutex;          // serialise writes (hook thread + pong sender)
  std::mutex outboxMutex;
  std::condition_variable outboxCv;
  std::deque<std::string> outbox;
};

std::mutex g_hotkey_mutex;
std::vector<std::shared_ptr<HotkeyConnection>> g_hotkey_connections;
std::atomic<bool> g_hook_started{false};
// Live connection count. Bumped before spawning the worker thread, decremented
// when handle_client returns (or when accept() rejects with 503).
std::atomic<int> g_connection_count{0};

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

void queue_hotkey_event(const std::shared_ptr<HotkeyConnection>& conn, const char* text) {
  if (!conn || !conn->alive.load()) return;
  {
    std::lock_guard<std::mutex> lock(conn->outboxMutex);
    if (!conn->alive.load()) return;
    if (conn->outbox.size() >= 16) conn->outbox.pop_front();
    conn->outbox.emplace_back(text);
  }
  conn->outboxCv.notify_one();
}

void hotkey_sender_loop(std::shared_ptr<HotkeyConnection> conn) {
  for (;;) {
    std::string msg;
    {
      std::unique_lock<std::mutex> lock(conn->outboxMutex);
      conn->outboxCv.wait(lock, [&] {
        return !conn->alive.load() || !conn->outbox.empty();
      });
      if (conn->outbox.empty()) {
        if (!conn->alive.load()) break;
        continue;
      }
      msg = std::move(conn->outbox.front());
      conn->outbox.pop_front();
    }
    if (!ws_send_text(*conn, msg)) {
      conn->alive = false;
      conn->outboxCv.notify_all();
      break;
    }
  }
}

LRESULT CALLBACK hotkey_hook_proc(int nCode, WPARAM wParam, LPARAM lParam) {
  bool suppress = false;
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
        bool wantCtrl, wantShift, wantAlt, wantWin, wantExclusive;
        {
          std::lock_guard<std::mutex> bl(conn->bindMutex);
          vk            = conn->binding.vkCode;
          wantCtrl      = conn->binding.ctrl;
          wantShift     = conn->binding.shift;
          wantAlt       = conn->binding.alt;
          wantWin       = conn->binding.win;
          wantExclusive = conn->binding.exclusive;
        }
        if (vk == 0) continue;

        DWORD hookVk = k->vkCode;
        if (hookVk == VK_LSHIFT || hookVk == VK_RSHIFT) hookVk = VK_SHIFT;
        else if (hookVk == VK_LCONTROL || hookVk == VK_RCONTROL) hookVk = VK_CONTROL;
        else if (hookVk == VK_LMENU || hookVk == VK_RMENU) hookVk = VK_MENU;

        if (hookVk != vk) continue;

        if (isDown) {
          // Modifier check only on press — the user may release modifiers
          // before the main key, and we still want a clean UP event.
          if (wantCtrl != ctrl || wantShift != shift ||
              wantAlt != alt   || wantWin != win) continue;
          if (!conn->binding.held.exchange(true)) {
            queue_hotkey_event(conn, R"({"event":"down"})");
          }
          // Swallow the key event so other apps never see it — but only when
          // the client opted into exclusive capture. Only the bound main key
          // is suppressed (Ctrl/Shift/Alt/Win pass through normally, because
          // the hook never matches them as the vk for a chord), so common
          // modifier-based shortcuts in other apps stay usable.
          if (wantExclusive) suppress = true;
        } else {
          if (conn->binding.held.exchange(false)) {
            queue_hotkey_event(conn, R"({"event":"up"})");
            // Pair the suppressed down with a suppressed up so the OS never
            // sees a dangling release. If we weren't tracking this press as
            // held (held was already false), the down wasn't ours either,
            // so leave the up alone. Same exclusive-only gating as down.
            if (wantExclusive) suppress = true;
          }
        }
      }
    }
  }
  // Returning non-zero from a low-level hook tells the OS to drop the event
  // before any other hook/app receives it. When no connection is bound (or
  // the page is closed and all connections were removed), we always fall
  // through to CallNextHookEx so the keyboard behaves normally.
  if (suppress) return 1;
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
  std::thread(hotkey_sender_loop, conn).detach();
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
      conn->binding.vkCode    = json_int(payload, "vkCode", 0);
      conn->binding.ctrl      = json_bool(payload, "ctrl");
      conn->binding.shift     = json_bool(payload, "shift");
      conn->binding.alt       = json_bool(payload, "alt");
      conn->binding.win       = json_bool(payload, "win");
      conn->binding.exclusive = json_bool(payload, "exclusive");
      conn->binding.held      = false;
    } else if (json_action_is(payload, "unbind")) {
      std::lock_guard<std::mutex> bl(conn->bindMutex);
      conn->binding.vkCode    = 0;
      conn->binding.exclusive = false;
      conn->binding.held      = false;
    }
  }

  conn->alive = false;
  conn->outboxCv.notify_all();
  std::lock_guard<std::mutex> lock(g_hotkey_mutex);
  g_hotkey_connections.erase(
      std::remove_if(g_hotkey_connections.begin(), g_hotkey_connections.end(),
                     [&](auto& c) { return c.get() == conn.get(); }),
      g_hotkey_connections.end());
}

// ─── HTTP / WebSocket router ────────────────────────────────────────────────

// Maximum total header bytes we'll accumulate before giving up. 64 KB covers
// every realistic browser request (extensions can add a lot of cookies +
// Sec-CH-* headers), while still being a hard ceiling against a slowloris-style
// peer dripping bytes forever.
constexpr size_t kMaxHeaderBytes = 64 * 1024;

void handle_client(SOCKET accepted) {
  SocketGuard client{accepted};
  // Drain bytes until we see the end-of-headers marker (or the cap, or the
  // peer disconnects). The previous single 8 KB recv would silently truncate
  // headers from clients that ship a lot of metadata.
  std::string req;
  req.reserve(4096);
  char chunk[4096];
  for (;;) {
    int n = recv(client.s, chunk, sizeof(chunk), 0);
    if (n <= 0) return;
    req.append(chunk, n);
    if (req.find("\r\n\r\n") != std::string::npos) break;
    if (req.size() > kMaxHeaderBytes) {
      send_text(client.s,
                "HTTP/1.1 431 Request Header Fields Too Large\r\n"
                "Content-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
  }
  const std::string target = request_target(req);
  const std::string path = path_only(target);
  const std::string origin = header_value(req, "Origin");

  const std::string cors =
      "Access-Control-Allow-Origin: " + (origin.empty() ? std::string("null") : origin) + "\r\n"
      "Access-Control-Allow-Methods: GET, OPTIONS\r\n"
      "Access-Control-Allow-Headers: Content-Type, X-Live-Translator\r\n"
      "Access-Control-Allow-Private-Network: true\r\n";

  if (!is_origin_allowed(origin)) {
    // Include the CORS header so the browser can read the 403 body and show
    // a clear "403 Forbidden" error instead of a misleading "CORS header missing".
    send_text(client.s, "HTTP/1.1 403 Forbidden\r\n" + cors + "Content-Length: 0\r\n\r\n");
    return;
  }

  if (starts_with(req, "OPTIONS ")) {
    send_text(client.s, "HTTP/1.1 204 No Content\r\n" + cors + "Content-Length: 0\r\n\r\n");
    return;
  }

  if (path == "/status") {
    const std::string body =
        "{\"status\":\"ok\",\"version\":\"0.4.0\","
        "\"audio\":\"pcm16-16000-mono\","
        "\"features\":[\"system-loopback\",\"process-loopback\",\"app-enumeration\",\"ptt-hotkey\",\"passthrough\"]}";
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

  if (path == "/outputs") {
    // Render endpoints the browser can route session passthrough audio to.
    // Sinks live on the companion side now, so the IDs returned here are
    // WASAPI endpoint ids — not the origin-hashed deviceIds the browser sees
    // in enumerateDevices() for the TTS playback section.
    auto eps = enumerate_endpoints(eRender);
    const std::string body = serialize_endpoints(eps, "outputs");
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

  if (path == "/passthrough") {
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
    passthrough_session_loop(client.s);
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

    // Reject when we're already at the cap. Sending 503 (instead of just
    // closing) gives the calling page a structured error to surface instead
    // of a confusing connection-refused.
    if (g_connection_count.load(std::memory_order_acquire) >= kMaxConnections) {
      dlog("connection refused: at cap (%d)", kMaxConnections);
      const std::string body = "Too many concurrent connections";
      const std::string resp =
          "HTTP/1.1 503 Service Unavailable\r\n"
          "Content-Type: text/plain\r\n"
          "Connection: close\r\n"
          "Content-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body;
      send(client, resp.c_str(), static_cast<int>(resp.size()), 0);
      closesocket(client);
      continue;
    }

    g_connection_count.fetch_add(1, std::memory_order_acq_rel);
    std::thread([client] {
      handle_client(client);
      g_connection_count.fetch_sub(1, std::memory_order_acq_rel);
    }).detach();
  }

  WSACleanup();
  return 0;
}
