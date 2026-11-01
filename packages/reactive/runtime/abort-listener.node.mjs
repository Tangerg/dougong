// Generated from tooling/internal/abort-listener.node.mjs. Run pnpm generate:internal.
import { addAbortListener } from "node:events";

export function listenForAbort(signal, notify) {
  // Node supplies stop-resistant listener options to this private registration signal.
  // The caller's genuine EventTarget owns the actual listener and its native GC bookkeeping.
  const registration = new AbortController().signal;
  let detach;
  registration.addEventListener = (type, listener, options) => {
    detach = () => EventTarget.prototype.removeEventListener.call(signal, type, listener);
    try {
      // Only native cancellation may consume the listener. Synthetic abort events can arrive first.
      EventTarget.prototype.addEventListener.call(signal, type, listener, {
        ...options,
        once: false,
      });
    } catch (error) {
      // A native listener hook may throw before or after insertion.
      detach();
      throw error;
    }
  };
  addAbortListener(registration, notify);
  if (!detach) throw new Error("Node did not attach the protected abort listener");
  return detach;
}
