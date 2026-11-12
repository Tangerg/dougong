import { onAbort } from "dougong/advanced";
import type { RegistrationRecord } from "../catalog/registration.js";
import { PlatformError, selectionSupersededCode } from "../errors.js";
import type { ActivationPlan } from "./plan.js";

export class ActivationOperation<Reference> {
  readonly signal: AbortSignal;
  readonly #controller: AbortController;
  #phase: "admitting" | "preparing" | "executing" | "settled" = "admitting";
  #detachCaller: (() => void) | undefined;
  readonly #completion = Promise.withResolvers<void>();
  readonly plan: ActivationPlan<Reference>;
  readonly #roles = new Map<
    RegistrationRecord<Reference>,
    { readonly revision: number; readonly status: "activating" | "removing" }
  >();

  constructor(plan: ActivationPlan<Reference>) {
    const controller = new AbortController();
    this.#controller = controller;
    this.signal = controller.signal;
    this.plan = plan;
    for (const { registration, revision } of plan.selections)
      this.#roles.set(registration, { revision, status: "activating" });
    for (const { registration, revision } of plan.removals)
      this.#roles.set(registration, { revision, status: "removing" });
  }

  admit(signal: AbortSignal | undefined) {
    if (this.#phase !== "admitting")
      throw new Error("Activation operation has already left admission");
    this.checkpoint();
    if (signal) this.#detachCaller = onAbort(signal, (reason) => this.#controller.abort(reason));
    this.checkpoint();
    this.#phase = "preparing";
  }

  get handedOff() {
    return this.#phase === "executing";
  }
  get settled() {
    return this.#completion.promise;
  }

  checkpoint() {
    this.signal.throwIfAborted();
  }

  handoff() {
    if (this.#phase !== "preparing") throw new Error("Activation operation is not preparing");
    this.checkpoint();
    this.#phase = "executing";
  }

  statusFor(registration: RegistrationRecord<Reference>, revision: number) {
    const role = this.#roles.get(registration);
    return role?.revision === revision ? role.status : undefined;
  }

  supersede(registration: RegistrationRecord<Reference>) {
    if (
      (this.#phase === "admitting" || this.#phase === "preparing") &&
      this.#roles.has(registration)
    ) {
      this.#controller.abort(
        new PlatformError(
          selectionSupersededCode,
          `Selection for '${registration.name}' changed during activation`,
        ),
      );
    }
  }

  cancel() {
    if (this.#phase !== "settled") this.#controller.abort();
  }

  finish() {
    this.#phase = "settled";
    this.#detachCaller?.();
    this.#detachCaller = undefined;
    this.#completion.resolve();
  }
}
