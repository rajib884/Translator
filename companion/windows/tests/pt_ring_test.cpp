#include "pt_ring.h"

#include <gtest/gtest.h>

#include <vector>

using namespace companion;

namespace {

std::vector<float> ramp(size_t n, float start, float step) {
  std::vector<float> v(n);
  for (size_t i = 0; i < n; ++i) v[i] = start + step * static_cast<float>(i);
  return v;
}

}  // namespace

TEST(PtRing, WriteThenDrainReturnsSameSamples) {
  PtRing r;
  auto L = ramp(64, 0.01f, 0.001f);
  auto R = ramp(64, 0.02f, 0.001f);
  r.mixIn(0, L.data(), R.data(), L.size());

  std::vector<float> oL(64), oR(64);
  EXPECT_EQ(r.consume(oL.data(), oR.data(), 64), 64u);
  for (size_t i = 0; i < 64; ++i) {
    EXPECT_FLOAT_EQ(oL[i], L[i]);
    EXPECT_FLOAT_EQ(oR[i], R[i]);
  }
}

TEST(PtRing, TwoSourcesSumIntoTheSameSink) {
  PtRing r;
  std::vector<float> aL(32, 0.10f), aR(32, 0.20f);
  std::vector<float> bL(32, 0.05f), bR(32, -0.05f);
  r.mixIn(0, aL.data(), aR.data(), 32);
  r.mixIn(0, bL.data(), bR.data(), 32);

  std::vector<float> oL(32), oR(32);
  EXPECT_EQ(r.consume(oL.data(), oR.data(), 32), 32u);
  for (size_t i = 0; i < 32; ++i) {
    EXPECT_NEAR(oL[i], 0.15f, 1e-6);
    EXPECT_NEAR(oR[i], 0.15f, 1e-6);
  }
}

TEST(PtRing, ConsumeClampsOutOfRangeMixedValues) {
  PtRing r;
  std::vector<float> hot(8, 2.0f);
  std::vector<float> cold(8, -3.0f);
  r.mixIn(0, hot.data(), cold.data(), 8);

  std::vector<float> oL(8), oR(8);
  r.consume(oL.data(), oR.data(), 8);
  for (size_t i = 0; i < 8; ++i) {
    EXPECT_FLOAT_EQ(oL[i], 1.0f);
    EXPECT_FLOAT_EQ(oR[i], -1.0f);
  }
}

TEST(PtRing, ConsumeUnderrunPadsWithSilenceAndAdvancesReadFrame) {
  PtRing r;
  std::vector<float> v(8, 0.5f);
  r.mixIn(0, v.data(), v.data(), 8);

  std::vector<float> oL(16), oR(16);
  size_t taken = r.consume(oL.data(), oR.data(), 16);
  EXPECT_EQ(taken, 8u);
  for (size_t i = 0; i < 8; ++i) {
    EXPECT_FLOAT_EQ(oL[i], 0.5f);
    EXPECT_FLOAT_EQ(oR[i], 0.5f);
  }
  for (size_t i = 8; i < 16; ++i) {
    EXPECT_FLOAT_EQ(oL[i], 0.0f);
    EXPECT_FLOAT_EQ(oR[i], 0.0f);
  }

  // readFrame should have advanced by the full n (=16), not just taken.
  // The next mixIn at frame 12 has 4 stale frames trimmed off the front.
  std::vector<float> later = ramp(8, 0.10f, 0.01f);
  r.mixIn(12, later.data(), later.data(), 8);
  taken = r.consume(oL.data(), oR.data(), 4);
  EXPECT_EQ(taken, 4u);
  for (size_t i = 0; i < 4; ++i) {
    EXPECT_FLOAT_EQ(oL[i], later[4 + i]);
    EXPECT_FLOAT_EQ(oR[i], later[4 + i]);
  }
}

TEST(PtRing, MixEntirelyBeforeReadFrameIsDropped) {
  PtRing r;
  std::vector<float> v(8, 0.5f);
  r.mixIn(0, v.data(), v.data(), 8);

  std::vector<float> oL(8), oR(8);
  r.consume(oL.data(), oR.data(), 8);  // readFrame now == 8.

  // Entire mix is stale: startFrame=0, n=4 → startFrame+n=4 <= readFrame=8.
  std::vector<float> hot(4, 0.9f);
  r.mixIn(0, hot.data(), hot.data(), 4);

  // consume should yield silence because writeFrame did not advance past 8.
  std::vector<float> oL2(4), oR2(4);
  size_t taken = r.consume(oL2.data(), oR2.data(), 4);
  EXPECT_EQ(taken, 0u);
  for (size_t i = 0; i < 4; ++i) EXPECT_FLOAT_EQ(oL2[i], 0.0f);
}

TEST(PtRing, MixCapsAtRingHorizon) {
  PtRing r;
  // Write far past readFrame + kPtRingFrames: only the head that fits in the
  // [readFrame, readFrame+kPtRingFrames) window is accepted.
  const uint64_t startFrame = kPtRingFrames + 1000;
  std::vector<float> v(8, 0.5f);
  r.mixIn(startFrame, v.data(), v.data(), v.size());

  // writeFrame was not advanced (startFrame >= readFrame + kPtRingFrames),
  // so consume yields silence.
  std::vector<float> oL(8), oR(8);
  EXPECT_EQ(r.consume(oL.data(), oR.data(), 8), 0u);
}

TEST(PtRing, WrapsAroundModuloBoundary) {
  PtRing r;
  // Walk readFrame near the wrap boundary by consuming a block of silence,
  // then write across the boundary. Each consume(n) advances readFrame by n
  // regardless of avail.
  std::vector<float> sink(1024);
  uint64_t advanced = 0;
  while (advanced + 1024 < kPtRingFrames - 16) {
    r.consume(sink.data(), sink.data(), 1024);
    advanced += 1024;
  }
  // Now readFrame is ~kPtRingFrames - 16 - epsilon. Write 32 frames straddling
  // the modulo boundary.
  std::vector<float> v = ramp(32, 0.10f, 0.01f);
  r.mixIn(advanced, v.data(), v.data(), v.size());

  std::vector<float> oL(32), oR(32);
  EXPECT_EQ(r.consume(oL.data(), oR.data(), 32), 32u);
  for (size_t i = 0; i < 32; ++i) {
    EXPECT_FLOAT_EQ(oL[i], v[i]);
    EXPECT_FLOAT_EQ(oR[i], v[i]);
  }
}

// ─── mixFrom: per-source offset + rebase ────────────────────────────────────

namespace {

// Drain `frames` from the ring in chunks, discarding the output. Advances
// readFrame by exactly `frames` regardless of available data.
void drain(PtRing& r, uint64_t frames) {
  std::vector<float> sink(1024);
  while (frames > 0) {
    size_t step = static_cast<size_t>(std::min<uint64_t>(1024, frames));
    r.consume(sink.data(), sink.data(), step);
    frames -= step;
  }
}

}  // namespace

TEST(PtRing, MixFromFirstChunkLandsAtRebaseLead) {
  PtRing r;
  std::vector<float> v(8, 0.5f);
  r.mixFrom(kPtSrcMic, 0, v.data(), v.data(), 8);

  // The synced stream starts kPtRebaseLeadFrames ahead of the read head:
  // silence until then, then the data.
  std::vector<float> oL(kPtRebaseLeadFrames), oR(kPtRebaseLeadFrames);
  r.consume(oL.data(), oR.data(), kPtRebaseLeadFrames);
  for (size_t i = 0; i < kPtRebaseLeadFrames; ++i) ASSERT_FLOAT_EQ(oL[i], 0.0f);
  std::vector<float> dL(8), dR(8);
  EXPECT_EQ(r.consume(dL.data(), dR.data(), 8), 8u);
  for (size_t i = 0; i < 8; ++i) EXPECT_FLOAT_EQ(dL[i], 0.5f);
}

TEST(PtRing, MixFromRebasesSourceThatStartedAfterSink) {
  // Sink consumed for a while before the source's first chunk (source device
  // init lost the race). The legacy mixIn dropped frame-0 chunks forever;
  // mixFrom must rebase them to land just ahead of the read head.
  PtRing r;
  drain(r, 10000);

  std::vector<float> v(8, 0.5f);
  r.mixFrom(kPtSrcMic, 0, v.data(), v.data(), 8);

  drain(r, kPtRebaseLeadFrames);
  std::vector<float> dL(8), dR(8);
  EXPECT_EQ(r.consume(dL.data(), dR.data(), 8), 8u);
  for (size_t i = 0; i < 8; ++i) EXPECT_FLOAT_EQ(dL[i], 0.5f);
}

TEST(PtRing, MixFromRebasesCounterFarAheadOfFreshRing) {
  // A sink added mid-session sees a source counter that is already hours
  // large — far past the fresh ring's horizon. mixFrom rebases it down.
  PtRing r;
  const uint64_t huge = 48000ull * 3600;
  std::vector<float> v(8, 0.25f);
  r.mixFrom(kPtSrcLoopback, huge, v.data(), v.data(), 8);

  drain(r, kPtRebaseLeadFrames);
  std::vector<float> dL(8), dR(8);
  EXPECT_EQ(r.consume(dL.data(), dR.data(), 8), 8u);
  for (size_t i = 0; i < 8; ++i) EXPECT_FLOAT_EQ(dL[i], 0.25f);
}

TEST(PtRing, MixFromRebasesAfterSourceStall) {
  // Source feeds, stalls while the sink keeps consuming (readFrame advances
  // past the stream), then resumes with its old counter. The resumed audio
  // must come back instead of being permanently stale-dropped.
  PtRing r;
  std::vector<float> v(64, 0.5f);
  r.mixFrom(kPtSrcMic, 0, v.data(), v.data(), 64);
  drain(r, kPtRebaseLeadFrames + 64);  // play out everything written so far

  drain(r, 48000);  // 1 s stall: sink consumes silence, source produces nothing

  std::vector<float> resumed(8, 0.75f);
  r.mixFrom(kPtSrcMic, 64, resumed.data(), resumed.data(), 8);  // counter resumes at 64

  drain(r, kPtRebaseLeadFrames);
  std::vector<float> dL(8), dR(8);
  EXPECT_EQ(r.consume(dL.data(), dR.data(), 8), 8u);
  for (size_t i = 0; i < 8; ++i) EXPECT_FLOAT_EQ(dL[i], 0.75f);
}

TEST(PtRing, MixFromContiguousChunksStayContiguousAfterSync) {
  // After the initial sync, consecutive chunks land back-to-back — the
  // rebase only fires on dislocation, not per chunk.
  PtRing r;
  auto a = ramp(8, 0.10f, 0.01f);
  auto b = ramp(8, 0.50f, 0.01f);
  r.mixFrom(kPtSrcMic, 0, a.data(), a.data(), 8);
  r.mixFrom(kPtSrcMic, 8, b.data(), b.data(), 8);

  drain(r, kPtRebaseLeadFrames);
  std::vector<float> dL(16), dR(16);
  EXPECT_EQ(r.consume(dL.data(), dR.data(), 16), 16u);
  for (size_t i = 0; i < 8; ++i) EXPECT_FLOAT_EQ(dL[i], a[i]);
  for (size_t i = 0; i < 8; ++i) EXPECT_FLOAT_EQ(dL[8 + i], b[i]);
}

TEST(PtRing, MixFromTwoSourcesKeepIndependentOffsets) {
  // Mic counter starts at 0, loopback counter is already huge — both must
  // sync to "now" and mix together.
  PtRing r;
  std::vector<float> mic(8, 0.10f);
  std::vector<float> loop(8, 0.25f);
  r.mixFrom(kPtSrcMic, 0, mic.data(), mic.data(), 8);
  r.mixFrom(kPtSrcLoopback, 48000ull * 7200, loop.data(), loop.data(), 8);

  drain(r, kPtRebaseLeadFrames);
  std::vector<float> dL(8), dR(8);
  EXPECT_EQ(r.consume(dL.data(), dR.data(), 8), 8u);
  for (size_t i = 0; i < 8; ++i) EXPECT_NEAR(dL[i], 0.35f, 1e-6);
}

TEST(PtRing, ConsumedCellsZeroBeforeNextMix) {
  // Verifies the invariant that consume() zeroes the cells it drains so a
  // later mix-add through the same modulo position doesn't double-count.
  PtRing r;
  std::vector<float> first(8, 0.5f);
  r.mixIn(0, first.data(), first.data(), 8);
  std::vector<float> out(8);
  r.consume(out.data(), out.data(), 8);

  // Advance readFrame to kPtRingFrames so the next mix at frame kPtRingFrames
  // lands on the same physical cells we just consumed.
  std::vector<float> drain(1024);
  uint64_t advanced = 8;
  while (advanced < kPtRingFrames) {
    size_t step = std::min<size_t>(1024, kPtRingFrames - advanced);
    r.consume(drain.data(), drain.data(), step);
    advanced += step;
  }

  std::vector<float> fresh(8, 0.3f);
  r.mixIn(kPtRingFrames, fresh.data(), fresh.data(), 8);
  std::vector<float> oL(8), oR(8);
  EXPECT_EQ(r.consume(oL.data(), oR.data(), 8), 8u);
  for (size_t i = 0; i < 8; ++i) {
    // If the cells had not been zeroed, this would read 0.5+0.3 = 0.8.
    EXPECT_NEAR(oL[i], 0.3f, 1e-6);
    EXPECT_NEAR(oR[i], 0.3f, 1e-6);
  }
}
