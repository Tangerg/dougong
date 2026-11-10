import { DougongError, lifetimeDisposedCode } from "../contracts/errors.js";
import type { Logger } from "../contracts/logging.js";
import { disposeSymbol, type Disposable } from "../contracts/resource.js";
import { assertSynchronous } from "../internal/async-result.js";

// Plugins may pass logging functions around; the Instance alone revokes them when its Lifetime ends.
export class ScopedLogger implements Disposable {
  readonly handle: Logger = Object.freeze<Logger>({
    debug: (message, ...details) => this.#write("debug", message, details),
    info: (message, ...details) => this.#write("info", message, details),
    warn: (message, ...details) => this.#write("warn", message, details),
    error: (message, ...details) => this.#write("error", message, details),
  });
  #binding:
    | { readonly logger: Logger<unknown>; readonly metadata: Readonly<Record<string, unknown>> }
    | undefined;

  constructor(logger: Logger<unknown>, metadata: Readonly<Record<string, unknown>>) {
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
