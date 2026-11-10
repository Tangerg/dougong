import { onAbort } from "dougong/advanced";
import type { RegistrationRecord } from "../catalog/registration.js";
import { PlatformError, selectionSupersededCode } from "../errors.js";
import type { ActivationPlan } from "./plan.js";

export class ActivationOperation<Reference> {
  readonly signal: AbortSignal;
  readonly #controller: AbortController;
  #phase: "preparing" | "executing" | "settled" = "preparing";
  #detachCaller: (() => void) | undefined;
  readonly #completion = Promise.withResolvers<void>();
  readonly plan: ActivationPlan<Reference>;
  readonly #roles = new Map<
    RegistrationRecord<Reference>,
    { readonly revision: number; readonly status: "activating" | "removing" }
  >();

  constructor(plan: ActivationPlan<Reference>, signal: AbortSignal | undefined) {
    const controller = new AbortController();
    this.#controller = controller;
    this.signal = controller.signal;
    this.plan = plan;
    for (const { registration, revision } of plan.selections)
      this.#roles.set(registration, { revision, status: "activating" });
    for (const { registration, revision } of plan.removals)
      this.#roles.set(registration, { revision, status: "removing" });
    if (signal) this.#detachCaller = onAbort(signal, (reason) => controller.abort(reason));
    this.signal.throwIfAborted();
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
    this.checkpoint();
    this.#phase = "executing";
  }

  statusFor(registration: RegistrationRecord<Reference>, revision: number) {
    const role = this.#roles.get(registration);
    return role?.revision === revision ? role.status : undefined;
  }

  supersede(registration: RegistrationRecord<Reference>) {
    if (this.#phase === "preparing" && this.#roles.has(registration)) {
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
