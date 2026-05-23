#pragma once

#include "constants.h"

#include <algorithm>
#include <cstdint>
#include <vector>

namespace companion {

// Linear resampler from in_rate to kOutputRate (16k mono int16). State carries
// across calls so chunk boundaries don't introduce clicks.
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

}  // namespace companion
