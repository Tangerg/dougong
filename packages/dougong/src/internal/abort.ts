// An abort event can be dispatched by any signal holder; only the controller can change native state.
export function isAborted(signal: AbortSignal): boolean {
  return Reflect.get(AbortSignal.prototype, "aborted", signal) as boolean;
}

export function abortReason(signal: AbortSignal): unknown {
  return Reflect.get(AbortSignal.prototype, "reason", signal);
}

export function onAbort(signal: AbortSignal, callback: (reason: unknown) => void): () => void {
  if (typeof callback !== "function") throw new TypeError("Abort listener must be a function");
  // The native getter also rejects non-signals before a TypeError could be mistaken for a reason.
  const alreadyAborted = isAborted(signal);
  let binding: { signal: AbortSignal; callback: (reason: unknown) => void } | undefined = {
    signal,
    callback,
  };
  function detach() {
    if (!binding) return;
    EventTarget.prototype.removeEventListener.call(binding.signal, "abort", notify);
    binding = undefined;
  }
  function notify() {
    if (!binding) return;
    const { signal, callback } = binding;
    if (!isAborted(signal)) return;
    const reason = abortReason(signal);
    detach();
    callback(reason);
  }
  if (alreadyAborted) notify();
  else EventTarget.prototype.addEventListener.call(signal, "abort", notify);
  return detach;
}
