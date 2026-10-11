// Generated from scripts/internal/disposal-runtime.ts. Run pnpm generate:internal.
export function assertPromiseRuntime(
  withResolvers: unknown,
): asserts withResolvers is typeof Promise.withResolvers {
  if (typeof withResolvers !== "function") {
    throw new Error("Unsupported JavaScript runtime: Promise.withResolvers is required");
  }
}

export function resolveDisposalSymbol(
  native: symbol | undefined,
  name: "Symbol.dispose" | "Symbol.asyncDispose",
) {
  return native ?? Symbol.for(name);
}

assertPromiseRuntime(Promise.withResolvers);

export const disposeSymbol: typeof Symbol.dispose = resolveDisposalSymbol(
  Symbol.dispose,
  "Symbol.dispose",
) as typeof Symbol.dispose;
export const asyncDisposeSymbol: typeof Symbol.asyncDispose = resolveDisposalSymbol(
  Symbol.asyncDispose,
  "Symbol.asyncDispose",
) as typeof Symbol.asyncDispose;
