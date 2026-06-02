#pragma once

#include "common.h"

#include <atomic>

namespace companion {

// Completion handler for ActivateAudioInterfaceAsync. The audio service QIs
// for IAgileObject synchronously and rejects the call with
// E_ILLEGAL_METHOD_CALL (0x8000000e) when it's not supported, so we advertise
// it explicitly.
class ActivationHandler : public IActivateAudioInterfaceCompletionHandler {
 public:
  HANDLE event = nullptr;
  explicit ActivationHandler(HANDLE event_handle) : event(event_handle) {}
  STDMETHODIMP_(ULONG) AddRef() override;
  STDMETHODIMP_(ULONG) Release() override;
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override;
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation*) override;

 private:
  std::atomic<ULONG> refCount{1};
};

}  // namespace companion
