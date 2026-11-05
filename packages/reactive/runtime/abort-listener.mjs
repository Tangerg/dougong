// Generated from tooling/internal/abort-listener.mjs. Run pnpm generate:internal.
// The private dependent must take its state from the source's controller. A runtime whose
// AbortSignal.any reads the public, shadowable properties instead would create a dependent
// already aborted with a forged reason, which never reports the real cancellation.
export function assertAbortRuntime(any) {
  if (typeof any !== "function") {
    throw new Error("Unsupported JavaScript runtime: AbortSignal.any is required");
  }
  const source = new AbortController().signal;
  Object.defineProperty(source, "aborted", { value: true });
  if (Reflect.get(AbortSignal.prototype, "aborted", any.call(AbortSignal, [source]))) {
    throw new Error(
      "Unsupported JavaScript runtime: AbortSignal.any must read native signal state",
    );
  }
}

assertAbortRuntime(AbortSignal.any);

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
