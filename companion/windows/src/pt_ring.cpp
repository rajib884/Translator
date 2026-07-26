#include "pt_ring.h"

#include <algorithm>

namespace companion {

void PtRing::mixFrom(int srcIdx, uint64_t srcFrame, const float* inL, const float* inR, size_t n) {
  if (srcIdx < 0 || srcIdx >= kPtMaxSources || n == 0) return;
  std::lock_guard<std::mutex> lock(mu);
  SrcState& st = src[srcIdx];
  const int64_t read = static_cast<int64_t>(readFrame);
  int64_t eff = static_cast<int64_t>(srcFrame) + st.offset;
  if (!st.synced || eff + static_cast<int64_t>(n) <= read ||
      eff >= read + static_cast<int64_t>(kPtRingFrames)) {
    eff = read + static_cast<int64_t>(kPtRebaseLeadFrames);
    st.offset = eff - static_cast<int64_t>(srcFrame);
    st.synced = true;
  }
  mix_at_locked(static_cast<uint64_t>(eff), inL, inR, n);
}

void PtRing::mixIn(uint64_t startFrame, const float* inL, const float* inR, size_t n) {
  std::lock_guard<std::mutex> lock(mu);
  mix_at_locked(startFrame, inL, inR, n);
}

void PtRing::mix_at_locked(uint64_t startFrame, const float* inL, const float* inR, size_t n) {
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
