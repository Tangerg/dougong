import type { InstallationRecord } from "../composition/installation.js";
import { onAbort } from "../internal/abort.js";
import type { ExecutionScope } from "./retirements.js";

type CancellationSource =
  | { readonly phase: "request"; readonly controller: AbortController; readonly detach: () => void }
  | {
      readonly phase: "restoration";
      readonly controller: AbortController;
      readonly timer: ReturnType<typeof setTimeout> | undefined;
    }
  | { readonly phase: "closed" };

export class ExecutionTransition {
  readonly phase: "starting" | "changing" | "stopping";
  readonly affected: ReadonlySet<InstallationRecord>;
  readonly scopes: ExecutionScope[] = [];
  #cancellation: CancellationSource;

  constructor(
    phase: ExecutionTransition["phase"],
    affected: ReadonlySet<InstallationRecord>,
    caller?: AbortSignal,
  ) {
    this.phase = phase;
    this.affected = affected;
    const controller = new AbortController();
    const detach = caller ? onAbort(caller, (reason) => controller.abort(reason)) : () => {};
    this.#cancellation = { phase: "request", controller, detach };
  }

  get signal() {
    if (this.#cancellation.phase === "closed") throw new Error("Execution transition is closed");
    return this.#cancellation.controller.signal;
  }

  checkpoint() {
    this.signal.throwIfAborted();
  }

  // The Lifetime still owns setup's actual settlement; cancellation enters recovery, which must join it.
  waitFor<T>(preparation: Promise<T>): Promise<T> {
    const completion = Promise.withResolvers<T>();
    void preparation.then(completion.resolve, completion.reject);
    const detach = onAbort(this.signal, completion.reject);
    return completion.promise.finally(detach);
  }

  // Reconstructing the old execution must not inherit the request that already cancelled its replacement.
  beginRestoration(timeoutMilliseconds: number | undefined) {
    if (this.#cancellation.phase !== "request")
      throw new Error("Execution transition cannot begin restoration again");
    this.close();
    const controller = new AbortController();
    const timer =
      timeoutMilliseconds === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort(new DOMException("Restoration preparation timed out", "TimeoutError"));
          }, timeoutMilliseconds);
    this.#cancellation = { phase: "restoration", controller, timer };
  }

  // Commit closes cancellation before publishing callbacks can reenter the caller's controller.
  close() {
    const source = this.#cancellation;
    if (source.phase === "request") source.detach();
    else if (source.phase === "restoration") clearTimeout(source.timer);
    this.#cancellation = { phase: "closed" };
  }
}
