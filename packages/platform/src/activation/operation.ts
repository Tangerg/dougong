import { onAbort } from "dougong/advanced";
import type { RegistrationRecord } from "../catalog/registration.js";
import { PlatformError } from "../errors.js";
import type { ActivationPlan } from "./plan.js";

export class ActivationOperation<Reference> {
  readonly #controller = new AbortController();
  #caller: { readonly signal: AbortSignal; readonly detach: () => void } | undefined;
  readonly #completion = Promise.withResolvers<void>();
  readonly plan: ActivationPlan<Reference>;
  readonly #roles = new Map<
    RegistrationRecord<Reference>,
    { readonly revision: number; readonly status: "activating" | "removing" }
  >();

  constructor(plan: ActivationPlan<Reference>, signal: AbortSignal | undefined) {
    this.plan = plan;
    for (const { registration, revision } of plan.selections)
      this.#roles.set(registration, { revision, status: "activating" });
    for (const { registration, revision } of plan.removals)
      this.#roles.set(registration, { revision, status: "removing" });
    if (signal)
      this.#caller = {
        signal,
        detach: onAbort(signal, (reason) => this.#controller.abort(reason)),
      };
    this.signal.throwIfAborted();
  }

  get signal() {
    return this.#controller.signal;
  }
  get settled() {
    return this.#completion.promise;
  }

  // Same-realm code can suppress delivery of an abort event, but not the caller signal's native state.
  synchronizeCancellation() {
    if (!this.#caller || this.signal.aborted) return;
    try {
      AbortSignal.prototype.throwIfAborted.call(this.#caller.signal);
    } catch (reason) {
      this.#controller.abort(reason);
    }
  }

  checkpoint() {
    this.synchronizeCancellation();
    this.signal.throwIfAborted();
  }

  handoff() {
    this.checkpoint();
    this.#detachCaller();
  }

  #detachCaller() {
    this.#caller?.detach();
    this.#caller = undefined;
  }

  statusFor(registration: RegistrationRecord<Reference>, revision: number) {
    const role = this.#roles.get(registration);
    return role?.revision === revision ? role.status : undefined;
  }

  supersede(registration: RegistrationRecord<Reference>) {
    if (this.#roles.has(registration)) {
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
    this.#detachCaller();
    this.#completion.resolve();
  }
}
