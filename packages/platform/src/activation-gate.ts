// Mutual exclusion between two things that both want to change the graph:
// lazy activation, which starts whenever an event fires, and a structural change,
// which needs the graph to hold still long enough to validate and commit.
//
// A change closes the gate and waits for outstanding permits. New activations are
// refused with REGISTRATION_BUSY while it is closed — refused, not queued, because
// an activation that waits for an unrelated change is indistinguishable to the
// caller from one that hung.

/**
 * One admitted activation tree; dependencies reuse their root permit.
 *
 * Per-tree rather than per-Registration, so activating a dependency cannot
 * deadlock against the root that is waiting for it. That is why
 * `activateAsDependency` takes a permit instead of asking for its own.
 */
export class ActivationPermit {
  #release: ((permit: ActivationPermit) => void) | undefined;

  constructor(release: (permit: ActivationPermit) => void) {
    this.#release = release;
  }

  release() {
    const release = this.#release;
    this.#release = undefined;
    release?.(this);
  }
}

type ActivationGateState =
  | { readonly phase: "open" }
  | {
      readonly phase: "closed";
      readonly resolve: () => void;
    };

/** Prevents new activation trees while a structural change reaches commit. */
export class ActivationGate {
  readonly #permits = new Set<ActivationPermit>();
  #state: ActivationGateState = { phase: "open" };

  enter() {
    if (this.#state.phase === "closed") return undefined;
    const permit = new ActivationPermit((current) => this.#release(current));
    this.#permits.add(permit);
    return permit;
  }

  close() {
    if (this.#state.phase === "closed") {
      throw new Error("Activation gate is already closed");
    }
    const completion = Promise.withResolvers<void>();
    this.#state = {
      phase: "closed",
      resolve: completion.resolve,
    };
    if (!this.#permits.size) completion.resolve();
    return completion.promise;
  }

  open() {
    const state = this.#state;
    if (state.phase === "open") throw new Error("Activation gate is already open");
    if (this.#permits.size) throw new Error("Activation gate still has active permits");
    this.#state = { phase: "open" };
  }

  #release(permit: ActivationPermit) {
    this.#permits.delete(permit);
    const state = this.#state;
    if (state.phase === "closed" && !this.#permits.size) state.resolve();
  }
}
