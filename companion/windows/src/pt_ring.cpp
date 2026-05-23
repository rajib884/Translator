#include "pt_ring.h"

#include <algorithm>

namespace companion {

void PtRing::mixIn(uint64_t startFrame, const float* inL, const float* inR, size_t n) {
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

size_t PtRing::consume(float* outL, float* outR, size_t n) {
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

}  // namespace companion
