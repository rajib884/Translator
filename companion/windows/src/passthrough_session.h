#pragma once

#include "common.h"
#include "pt_types.h"

#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace companion {

// One PassthroughSession per WebSocket connection on /passthrough. Owns:
//   - 0..N output sinks (each a render endpoint + render thread + mix buffer)
//   - 0..1 mic source thread (WASAPI capture endpoint)
//   - 0..1 loopback source thread (system loopback or per-pid loopback)
//
// Sources push float-stereo samples at 48 kHz into every active sink's ring
// buffer (mix-by-frame-position with simple summation). Sinks drain at their
// device's render cadence and write to WASAPI.
class PassthroughSession {
 public:
  explicit PassthroughSession(SOCKET s);
  ~PassthroughSession() { shutdown(); }

  // Stop and join every source/sink thread. Safe to call multiple times.
  void shutdown();

  // ─── Public reconfigure entry point — called from WS handler thread.
  // payload is the raw JSON text frame. Diff against current state and
  // start/stop sources + sinks as needed.
  void configure(const std::string& payload);

  // Browser → companion: closes the socket cleanly.
  void close_socket();

  // Drive a periodic level event (peak across all sinks). Called by the
  // session's WS handler thread between reads.
  void emit_level_if_due();

  void send_event_ready(const std::vector<std::string>& warnings,
                        const std::vector<std::string>& activeSinks,
                        const std::string& micState,
                        const std::string& loopbackState);

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
  void distribute(uint64_t startFrame, const float* L, const float* R, size_t n);

  void update_peak(float p);

  static std::string format_float(float f);

  bool send_json(const std::string& text);
};

}  // namespace companion
