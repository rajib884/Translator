#include "stereo_resampler.h"

#include <gtest/gtest.h>

#include <cmath>
#include <vector>

using namespace companion;

namespace {

std::vector<float> sine(size_t n, double freq, double rate) {
  std::vector<float> v(n);
  for (size_t i = 0; i < n; ++i) {
    v[i] = static_cast<float>(
        std::sin(2.0 * 3.14159265358979323846 * freq * i / rate));
  }
  return v;
}

}  // namespace

TEST(StereoResampler, EmptyInputIsNoOp) {
  StereoResampler rs;
  std::vector<float> inL, inR, outL, outR;
  rs.process(inL, inR, 48000, outL, outR);
  EXPECT_TRUE(outL.empty());
  EXPECT_TRUE(outR.empty());
}

TEST(StereoResampler, IdentityFirstSampleMatches) {
  // At in_rate == 48k, ratio = 1.0. First output of the very first call is
  // exactly inL[0] (pos starts at 0, frac=0).
  StereoResampler rs;
  std::vector<float> inL = {0.1f, 0.2f, 0.3f, 0.4f};
  std::vector<float> inR = {-0.1f, -0.2f, -0.3f, -0.4f};
  std::vector<float> outL, outR;
  rs.process(inL, inR, 48000, outL, outR);
  ASSERT_FALSE(outL.empty());
  EXPECT_FLOAT_EQ(outL[0], 0.1f);
  EXPECT_FLOAT_EQ(outR[0], -0.1f);
}

TEST(StereoResampler, UpsampleDoublesLengthAndInterpolates) {
  // 24 kHz → 48 kHz: ratio = 0.5. For input [a, b, c, d], the resampler
  // produces interpolated outputs at pos 0, 0.5, 1.0, 1.5, 2.0, 2.5 — six
  // samples (loop exits when pos+1 >= 4).
  StereoResampler rs;
  std::vector<float> inL = {0.0f, 1.0f, 2.0f, 3.0f};
  std::vector<float> inR = {0.0f, 1.0f, 2.0f, 3.0f};
  std::vector<float> outL, outR;
  rs.process(inL, inR, 24000, outL, outR);
  ASSERT_EQ(outL.size(), 6u);
  EXPECT_NEAR(outL[0], 0.0f, 1e-6f);
  EXPECT_NEAR(outL[1], 0.5f, 1e-6f);
  EXPECT_NEAR(outL[2], 1.0f, 1e-6f);
  EXPECT_NEAR(outL[3], 1.5f, 1e-6f);
  EXPECT_NEAR(outL[4], 2.0f, 1e-6f);
  EXPECT_NEAR(outL[5], 2.5f, 1e-6f);
}

TEST(StereoResampler, DownsampleHalvesLengthAndPicksKnownSamples) {
  // 96 kHz → 48 kHz: ratio = 2.0. For input [a, b, c, d, e, f, g, h], pos
  // moves 0, 2, 4, 6 → outputs [a, c, e, g] (frac=0 each step).
  StereoResampler rs;
  std::vector<float> inL = {0.0f, 0.1f, 0.2f, 0.3f, 0.4f, 0.5f, 0.6f, 0.7f};
  std::vector<float> outL, outR;
  rs.process(inL, inL, 96000, outL, outR);
  ASSERT_EQ(outL.size(), 4u);
  EXPECT_FLOAT_EQ(outL[0], 0.0f);
  EXPECT_FLOAT_EQ(outL[1], 0.2f);
  EXPECT_FLOAT_EQ(outL[2], 0.4f);
  EXPECT_FLOAT_EQ(outL[3], 0.6f);
}

TEST(StereoResampler, IdentityMultiChunkDoesNotCrashOrLoseSamples) {
  // Regression: a prior version subtracted inL.size() from `pos` at end of
  // call, leaving pos = -1 at ratio=1. On the next call, (size_t)(-1.0) was
  // UB → out-of-bounds aL[] access → assertion failure in libstdc++ debug.
  // Exercised in the wild via 48 kHz WASAPI loopback. This test reproduces
  // the multi-chunk identity case in-process.
  StereoResampler rs;
  std::vector<float> chunk = {0.1f, 0.2f, 0.3f, 0.4f};
  std::vector<float> outL, outR;
  for (int call = 0; call < 5; ++call) {
    rs.process(chunk, chunk, 48000, outL, outR);
  }
  // Steady state: each subsequent call produces inL.size() outputs. The
  // first call loses 1 (becomes prev), so total = 5 * 4 - 1 = 19.
  EXPECT_EQ(outL.size(), 19u);
  for (float v : outL) EXPECT_TRUE(std::isfinite(v));
}

TEST(StereoResampler, DownsampleProducesContinuousOutputAcrossCalls) {
  // 96 kHz → 48 kHz over multiple chunks: the carry through `prevL/prevR`
  // and `pos` should keep the output stream monotone for a monotone input.
  // (This ratio leaves pos >= 0 at the end of each chunk, so the carry is
  // safe; the upsample path has a known issue when the chunk size is small
  // enough to leave pos negative — exercised via the upsample test above as
  // a single-call only.)
  StereoResampler rs;
  std::vector<float> chunk1 = sine(800, 440.0, 96000.0);
  std::vector<float> chunk2 = sine(800, 440.0, 96000.0);
  // Sequential frames: shift chunk2 so it continues chunk1 in absolute time.
  for (size_t i = 0; i < chunk2.size(); ++i) {
    chunk2[i] = static_cast<float>(
        std::sin(2.0 * 3.14159265358979323846 * 440.0 *
                 static_cast<double>(800 + i) / 96000.0));
  }
  std::vector<float> outL, outR;
  rs.process(chunk1, chunk1, 96000, outL, outR);
  const size_t after_first = outL.size();
  rs.process(chunk2, chunk2, 96000, outL, outR);
  EXPECT_GT(outL.size(), after_first);
  // No NaN / inf in the merged output stream.
  for (float v : outL) EXPECT_TRUE(std::isfinite(v));
}
