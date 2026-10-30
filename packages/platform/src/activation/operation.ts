import type { RegistrationRecord } from "../catalog/registration.js";
import { PlatformError } from "../errors.js";
import type { ActivationPlan } from "./plan.js";

export class ActivationOperation<Reference> {
  readonly #controller = new AbortController();
  readonly #external: AbortSignal | undefined;
  readonly #abort: () => void;
  readonly #completion = Promise.withResolvers<void>();
  readonly plan: ActivationPlan<Reference>;

  constructor(plan: ActivationPlan<Reference>, signal: AbortSignal | undefined) {
    this.plan = plan;
    this.#external = signal;
    this.#abort = () => this.#controller.abort(signal?.reason);
    signal?.throwIfAborted();
    signal?.addEventListener("abort", this.#abort, { once: true });
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
    this.#external?.removeEventListener("abort", this.#abort);
    this.#completion.resolve();
  }
}
