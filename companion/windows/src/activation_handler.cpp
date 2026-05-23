#include "activation_handler.h"

namespace companion {

STDMETHODIMP_(ULONG) ActivationHandler::AddRef() {
  return static_cast<ULONG>(refCount.fetch_add(1, std::memory_order_relaxed) + 1);
}

STDMETHODIMP_(ULONG) ActivationHandler::Release() {
  const ULONG refs = static_cast<ULONG>(refCount.fetch_sub(1, std::memory_order_acq_rel) - 1);
  if (refs == 0) delete this;
  return refs;
}

STDMETHODIMP ActivationHandler::QueryInterface(REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  // IAgileObject is REQUIRED here. ActivateAudioInterfaceAsync QIs for it
  // synchronously and rejects the call with E_ILLEGAL_METHOD_CALL (0x8000000e)
  // when it's not supported — the audio service needs to know it can
  // safely call our handler from its own MTA worker thread.
  if (riid == __uuidof(IUnknown) ||
      riid == __uuidof(IAgileObject) ||
      riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
    *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    AddRef();
    return S_OK;
  }
  *ppv = nullptr;
  return E_NOINTERFACE;
}

STDMETHODIMP ActivationHandler::ActivateCompleted(IActivateAudioInterfaceAsyncOperation*) {
  SetEvent(event);
  Release();
  return S_OK;
}

}  // namespace companion
