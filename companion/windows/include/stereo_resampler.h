#pragma once

#include <vector>

namespace companion {

// kPtMixRate is defined in passthrough_session.h; we hard-code it locally to
// avoid pulling that whole header into resampler users that only need the
// arithmetic. Passthrough mixes at 48 kHz.
constexpr int kStereoResampleOutRate = 48000;

// Linear resampler from in_rate to 48 kHz stereo. State retained across calls
// so chunk boundaries don't introduce clicks. Mirrors `Resampler` but emits
// stereo floats for the passthrough mix bus.
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
    const double ratio = static_cast<double>(in_rate) / kStereoResampleOutRate;
    while (pos + 1.0 < aL.size()) {
      const size_t i = (size_t)pos;
      const double frac = pos - i;
      outL.push_back(aL[i] + (float)((aL[i + 1] - aL[i]) * frac));
      outR.push_back(aR[i] + (float)((aR[i + 1] - aR[i]) * frac));
      pos += ratio;
    }
    // Carry `pos` over to the next call's coordinate space. The next call
    // prepends `prev` (= aL.back()), so its aL[0] aligns with this call's
    // aL[aL.size()-1]. Subtracting (aL.size()-1) lands the new pos in
    // [0, ratio), avoiding the negative-pos → size_t cast that produced a
    // huge index and out-of-bounds access at ratio<=1 (e.g. 48 kHz → 48 kHz
    // loopback). Previously this used inL.size(), off-by-one on the first
    // (has_prev=false) call.
    pos -= static_cast<double>(aL.size() - 1);
    prevL = aL.back(); prevR = aR.back(); has_prev = true;
  }
};

}  // namespace companion
