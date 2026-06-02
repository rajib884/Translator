#pragma once

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>

namespace companion {

constexpr int kPtMixRate = 48000;
constexpr int kPtMixChans = 2;
constexpr size_t kPtRingFrames = 48000;  // 1 sec of slack absorbs source/sink drift

// Per-sink mix bus. Sources mix-add stereo frames by absolute frame position;
// sinks drain at their device's render cadence. Mixing imperfection under
// concurrent producers is tolerated — the typical case is one source, and
// "both" sessions accept some drift as a known limitation.
struct PtRing {
  std::mutex mu;
  std::vector<float> L;
  std::vector<float> R;
  uint64_t readFrame = 0;
  uint64_t writeFrame = 0;
  PtRing() : L(kPtRingFrames, 0.0f), R(kPtRingFrames, 0.0f) {}

  // Mix-add n stereo frames starting at absolute startFrame. Drops samples
  // older than readFrame; caps anything beyond readFrame + kPtRingFrames.
  void mixIn(uint64_t startFrame, const float* inL, const float* inR, size_t n);

  // Drain up to n stereo frames into outL/outR (always fills with zeros if
  // underrun). Returns the number of non-silent frames produced. Zeroes the
  // ring cells it consumes so the next mix starts fresh.
  size_t consume(float* outL, float* outR, size_t n);
};

}  // namespace companion
