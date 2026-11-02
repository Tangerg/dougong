// A separate closure prevents the dependent from retaining the source through its registration.
function weakAbortListener(reference) {
  return () => reference.deref()?.();
}

export function listenForAbort(signal, notify) {
  const dependent = AbortSignal.any([signal]);
  const listener = weakAbortListener(new WeakRef(notify));
  let registration = { signal, notify, dependent, listener };
  function detach() {
    if (!registration) return;
    const attached = registration;
    registration = undefined;
    EventTarget.prototype.removeEventListener.call(attached.signal, "abort", attached.notify);
    attached.dependent.removeEventListener("abort", attached.listener);
  }
  try {
    // Source listeners preserve native composite lifetimes; the private dependent bypasses stopped events.
    EventTarget.prototype.addEventListener.call(signal, "abort", notify);
    dependent.addEventListener("abort", listener);
  } catch (error) {
    detach();
    throw error;
  }
  return detach;
}
