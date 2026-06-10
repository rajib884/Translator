#pragma once

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>

namespace companion {

constexpr int kPtMixRate = 48000;
constexpr int kPtMixChans = 2;
constexpr size_t kPtRingFrames = 48000;  // 1 sec of slack absorbs source/sink drift

// Where a (re)synced source lands relative to the read head. Big enough that
// scheduler hiccups on the source thread don't immediately push the stream
// back behind the read head, small enough that the added passthrough latency
// stays unobtrusive.
constexpr uint64_t kPtRebaseLeadFrames = 4800;  // 100 ms

// Source slots for PtRing::mixFrom. A session has at most one of each.
constexpr int kPtSrcMic = 0;
constexpr int kPtSrcLoopback = 1;
constexpr int kPtMaxSources = 2;

// Per-sink mix bus. Sources mix-add stereo frames by frame position; sinks
// drain at their device's render cadence. Mixing imperfection under
// concurrent producers is tolerated — the typical case is one source, and
// "both" sessions accept some drift as a known limitation.
struct PtRing {
  std::mutex mu;
  std::vector<float> L;
  std::vector<float> R;
  uint64_t readFrame = 0;
  uint64_t writeFrame = 0;
  // Per-source mapping from the source's own monotonic frame counter into
  // this ring's frame domain. (Re)established by mixFrom whenever a source's
  // frames can't land usefully relative to the read head.
  struct SrcState {
    int64_t offset = 0;
    bool synced = false;
  };
  SrcState src[kPtMaxSources];
  PtRing() : L(kPtRingFrames, 0.0f), R(kPtRingFrames, 0.0f) {}

  // Mix-add n stereo frames from source `srcIdx` (kPtSrcMic / kPtSrcLoopback)
  // whose stream position is srcFrame in the source's own frame domain.
  // Rebases the source's offset when the chunk would land entirely behind
  // the read head (source started after the sink, stalled, or was restarted
  // with a fresh counter) or at/past the ring horizon (sink started fresh
  // while the source counter is already large). Without the rebase the gap
  // never closes — source and sink clocks both advance at ~48 kHz — and the
  // sink renders silence forever.
  void mixFrom(int srcIdx, uint64_t srcFrame, const float* inL, const float* inR, size_t n);

  // Raw mix-add of n stereo frames at absolute ring position startFrame.
  // Drops samples older than readFrame; caps anything beyond
  // readFrame + kPtRingFrames. Production code goes through mixFrom.
  void mixIn(uint64_t startFrame, const float* inL, const float* inR, size_t n);

  // Drain up to n stereo frames into outL/outR (always fills with zeros if
  // underrun). Returns the number of non-silent frames produced. Zeroes the
  // ring cells it consumes so the next mix starts fresh.
  size_t consume(float* outL, float* outR, size_t n);

 private:
  // Body of mixIn; requires mu to be held.
  void mix_at_locked(uint64_t startFrame, const float* inL, const float* inR, size_t n);
};

}  // namespace companion
