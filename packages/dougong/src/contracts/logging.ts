import { DougongError, lifetimeDisposedCode } from "./errors.js";
import { assertSynchronous } from "../internal/async-result.js";
import { disposeSymbol, type Disposable } from "./resource.js";
export interface Logger {
  readonly debug: (message: unknown, ...details: unknown[]) => void;
  readonly info: (message: unknown, ...details: unknown[]) => void;
  readonly warn: (message: unknown, ...details: unknown[]) => void;
  readonly error: (message: unknown, ...details: unknown[]) => void;
}

export function captureLogger(value: unknown): Logger {
  if (!value || (typeof value !== "object" && typeof value !== "function"))
    throw new TypeError("Logger must implement debug/info/warn/error");
  const capture = (level: keyof Logger): Logger[typeof level] => {
    const method = (value as Partial<Logger>)[level];
    if (typeof method !== "function")
      throw new TypeError("Logger must implement debug/info/warn/error");
    return (...messageArguments) => Reflect.apply(method, value, messageArguments);
  };
  return Object.freeze({
    debug: capture("debug"),
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
  });
}

export function isLogger(value: unknown): value is Logger {
  try {
    captureLogger(value);
    return true;
  } catch {
    return false;
  }
}

export class ScopedLogger implements Disposable {
  readonly handle: Logger = Object.freeze<Logger>({
    debug: (message, ...details) => this.#write("debug", message, details),
    info: (message, ...details) => this.#write("info", message, details),
    warn: (message, ...details) => this.#write("warn", message, details),
    error: (message, ...details) => this.#write("error", message, details),
  });
  #binding:
    { readonly logger: Logger; readonly metadata: Readonly<Record<string, unknown>> } | undefined;

  constructor(logger: Logger, metadata: Readonly<Record<string, unknown>>) {
    this.#binding = { logger, metadata };
  }

  [disposeSymbol]() {
    this.#binding = undefined;
  }

  #write(level: keyof Logger, message: unknown, details: ReadonlyArray<unknown>) {
    const binding = this.#binding;
    if (!binding) throw new DougongError(lifetimeDisposedCode, "Logger scope has ended");
    assertSynchronous(
      binding.logger[level](message, binding.metadata, ...details),
      "Logger methods must be synchronous",
    );
  }
}
