import { listenForAbort } from "#abort-listener";

// Event dispatch and shadow properties are public; the native signal state belongs to the controller.
export function isAborted(signal: AbortSignal): boolean {
  return Reflect.get(AbortSignal.prototype, "aborted", signal) as boolean;
}

export function abortReason(signal: AbortSignal): unknown {
  return Reflect.get(AbortSignal.prototype, "reason", signal);
}

export function onAbort(signal: AbortSignal, callback: (reason: unknown) => void): () => void {
  if (typeof callback !== "function") throw new TypeError("Abort listener must be a function");
  if (isAborted(signal)) {
    callback(abortReason(signal));
    return () => {};
  }

  let binding: { signal: AbortSignal; callback: (reason: unknown) => void } | undefined = {
    signal,
    callback,
  };
  let remove: (() => void) | undefined;
  function detach() {
    binding = undefined;
    remove?.();
    remove = undefined;
  }
  function notify() {
    if (!binding || !isAborted(binding.signal)) return;
    const { signal, callback } = binding;
    const reason = abortReason(signal);
    detach();
    callback(reason);
  }
  remove = listenForAbort(signal, notify);
  // A runtime registration hook may have delivered genuine cancellation before returning its disposer.
  if (binding) notify();
  else detach();
  return detach;
}
