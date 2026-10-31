import { onAbort } from "dougong/advanced";
import type { RegistrationRecord } from "../catalog/registration.js";
import { PlatformError } from "../errors.js";
import type { ActivationPlan } from "./plan.js";

export class ActivationOperation<Reference> {
  readonly #controller = new AbortController();
  readonly #detach: (() => void) | undefined;
  readonly #completion = Promise.withResolvers<void>();
  readonly plan: ActivationPlan<Reference>;

  constructor(plan: ActivationPlan<Reference>, signal: AbortSignal | undefined) {
    this.plan = plan;
    this.#detach = signal && onAbort(signal, (reason) => this.#controller.abort(reason));
    this.signal.throwIfAborted();
  }

  get signal() {
    return this.#controller.signal;
  }
  get settled() {
    return this.#completion.promise;
  }

  contains(registration: RegistrationRecord<Reference>, revision: number) {
    return [...this.plan.selections, ...this.plan.removals].some(
      (selection) => selection.registration === registration && selection.revision === revision,
    );
  }

  supersede(registration: RegistrationRecord<Reference>) {
    if (
      [...this.plan.selections, ...this.plan.removals].some(
        (selection) => selection.registration === registration,
      )
    ) {
      this.#controller.abort(
        new PlatformError(
          "SELECTION_SUPERSEDED",
          `Selection for '${registration.name}' changed during activation`,
        ),
      );
    }
  }

  cancel() {
    this.#controller.abort();
  }

  finish() {
    this.#detach?.();
    this.#completion.resolve();
  }
}
