// Generated from tooling/internal/abort-listener.web.mjs. Run pnpm generate:internal.
// Only the controller can abort this private dependent; other listeners can stop propagation on the source.
export function listenForAbort(signal, notify) {
  const dependent = AbortSignal.any([signal]);
  dependent.addEventListener("abort", notify);
  return () => dependent.removeEventListener("abort", notify);
}
