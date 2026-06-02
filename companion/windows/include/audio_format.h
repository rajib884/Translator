#pragma once

#include "common.h"

namespace companion {

// MinGW's ksmedia.h declares KSDATAFORMAT_SUBTYPE_IEEE_FLOAT as an extern in
// some SDK versions, so keep local storage for the GUID we need at runtime.
extern const GUID kKsDataFormatSubtypeIeeeFloat;

float sample_to_float(const BYTE* p, WORD bits, bool is_float);
bool is_float_format(const WAVEFORMATEX* fmt);

}  // namespace companion
