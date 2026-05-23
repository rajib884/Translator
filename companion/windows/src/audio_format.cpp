#include "audio_format.h"

#include <cstdint>

namespace companion {

const GUID kKsDataFormatSubtypeIeeeFloat = {
    0x00000003, 0x0000, 0x0010,
    {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

float sample_to_float(const BYTE* p, WORD bits, bool is_float) {
  if (is_float && bits == 32) return *reinterpret_cast<const float*>(p);
  if (bits == 16) return *reinterpret_cast<const int16_t*>(p) / 32768.0f;
  if (bits == 24) {
    int32_t v = (p[0] | (p[1] << 8) | (p[2] << 16));
    if (v & 0x800000) v |= 0xff000000;
    return v / 8388608.0f;
  }
  if (bits == 32) return *reinterpret_cast<const int32_t*>(p) / 2147483648.0f;
  return 0.0f;
}

bool is_float_format(const WAVEFORMATEX* fmt) {
  if (fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) return true;
  if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
    auto ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(fmt);
    return IsEqualGUID(ext->SubFormat, kKsDataFormatSubtypeIeeeFloat);
  }
  return false;
}

}  // namespace companion
