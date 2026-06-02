#pragma once

namespace companion {

constexpr int kPort = 52341;
constexpr int kOutputRate = 16000;
constexpr int kMaxFrameSamples = 1600;
// Realistic ceiling for a single web page across a handful of sessions plus
// some polling traffic. Past this we 503 new connections; the local-only
// audience makes this purely a fork-bomb guardrail, not a throughput knob.
constexpr int kMaxConnections = 32;

}  // namespace companion
