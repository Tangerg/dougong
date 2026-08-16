/** One admitted activation tree; dependencies reuse their root permit. */
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
