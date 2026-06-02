#include "audio_format.h"

#include <gtest/gtest.h>

#include <cstdint>

using namespace companion;

TEST(SampleToFloat, Int16PositiveMaxNearOne) {
  int16_t v = 32767;
  EXPECT_NEAR(sample_to_float(reinterpret_cast<const BYTE*>(&v), 16, false),
              32767.0f / 32768.0f, 1e-6f);
}

TEST(SampleToFloat, Int16NegativeMinIsMinusOne) {
  int16_t v = -32768;
  EXPECT_FLOAT_EQ(sample_to_float(reinterpret_cast<const BYTE*>(&v), 16, false),
                  -1.0f);
}

TEST(SampleToFloat, Int16ZeroIsZero) {
  int16_t v = 0;
  EXPECT_FLOAT_EQ(sample_to_float(reinterpret_cast<const BYTE*>(&v), 16, false),
                  0.0f);
}

TEST(SampleToFloat, Int24MaxPositive) {
  // 0x7FFFFF little-endian → max positive 24-bit
  uint8_t p[3] = {0xff, 0xff, 0x7f};
  EXPECT_NEAR(sample_to_float(p, 24, false), 8388607.0f / 8388608.0f, 1e-6f);
}

TEST(SampleToFloat, Int24MinNegativeWithSignExtension) {
  // 0x800000 → sign-extended to 0xFF800000 = -8388608
  uint8_t p[3] = {0x00, 0x00, 0x80};
  EXPECT_FLOAT_EQ(sample_to_float(p, 24, false), -1.0f);
}

TEST(SampleToFloat, Int24ZeroIsZero) {
  uint8_t p[3] = {0x00, 0x00, 0x00};
  EXPECT_FLOAT_EQ(sample_to_float(p, 24, false), 0.0f);
}

TEST(SampleToFloat, Int32NegativeMinIsMinusOne) {
  int32_t v = static_cast<int32_t>(0x80000000u);
  EXPECT_FLOAT_EQ(sample_to_float(reinterpret_cast<const BYTE*>(&v), 32, false),
                  -1.0f);
}

TEST(SampleToFloat, Float32IsPassthrough) {
  float f = 0.42f;
  EXPECT_FLOAT_EQ(sample_to_float(reinterpret_cast<const BYTE*>(&f), 32, true),
                  0.42f);
}

TEST(SampleToFloat, UnknownBitDepthReturnsZero) {
  uint8_t p[8] = {0};
  EXPECT_FLOAT_EQ(sample_to_float(p, 8, false), 0.0f);
}

TEST(IsFloatFormat, IeeeFloatTagDetected) {
  WAVEFORMATEX f = {};
  f.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  EXPECT_TRUE(is_float_format(&f));
}

TEST(IsFloatFormat, PcmTagNotFloat) {
  WAVEFORMATEX f = {};
  f.wFormatTag = WAVE_FORMAT_PCM;
  EXPECT_FALSE(is_float_format(&f));
}

TEST(IsFloatFormat, ExtensibleWithIeeeFloatSubFormatDetected) {
  WAVEFORMATEXTENSIBLE ext = {};
  ext.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  ext.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  ext.SubFormat = kKsDataFormatSubtypeIeeeFloat;
  EXPECT_TRUE(is_float_format(reinterpret_cast<WAVEFORMATEX*>(&ext)));
}

TEST(IsFloatFormat, ExtensibleWithPcmSubFormatNotFloat) {
  WAVEFORMATEXTENSIBLE ext = {};
  ext.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  ext.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  // Leave SubFormat zero — definitely not the IEEE_FLOAT GUID.
  EXPECT_FALSE(is_float_format(reinterpret_cast<WAVEFORMATEX*>(&ext)));
}
