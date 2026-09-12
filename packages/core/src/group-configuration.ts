type GroupConfigurationState<Draft> =
  | {
      readonly phase: "open";
      readonly draft: Draft;
      readonly discard: (draft: Draft, error: unknown) => void;
      readonly normalize: (error: unknown) => Error;
    }
  | {
      readonly phase: "failed";
      readonly draft: Draft;
      readonly discard: (draft: Draft, error: unknown) => void;
      readonly error: Error;
    }
  | { readonly phase: "sealed" };

/**
 * One explicit transaction shared by every nested Group configure callback.
 *
 * Nested `group()` calls join the outer session instead of opening their own, so
 * a whole tree of groups declared in one statement commits once. A failure
 * anywhere in that tree fails the session, which is why `fail()` records the
 * first error and later calls return it unchanged: the cause of a collapsed tree
 * is the first thing that went wrong, not the last.
 */
export class GroupConfigurationSession<Draft> {
  #state: GroupConfigurationState<Draft>;

  constructor(
    draft: Draft,
    discard: (draft: Draft, error: unknown) => void,
    normalize: (error: unknown) => Error,
  ) {
    this.#state = { phase: "open", draft, discard, normalize };
  }

  get failure() {
    return this.#state.phase === "failed" ? this.#state.error : undefined;
  }

  requireDraft() {
    const state = this.#state;
    if (state.phase === "failed") throw state.error;
    if (state.phase === "sealed") throw groupConfigurationSealedError();
    return state.draft;
  }

  assertOpen() {
    void this.requireDraft();
  }

  fail(error: unknown) {
    const state = this.#state;
    if (state.phase === "failed") return state.error;
    if (state.phase === "sealed") throw groupConfigurationSealedError();
    const failure = state.normalize(error);
    this.#state = {
      phase: "failed",
      draft: state.draft,
      discard: state.discard,
      error: failure,
    };
    return failure;
  }

  seal() {
    const state = this.#state;
    if (state.phase === "failed") throw state.error;
    if (state.phase === "sealed") throw groupConfigurationSealedError();
    this.#state = { phase: "sealed" };
    return state.draft;
  }

  discard(error: unknown) {
    const state = this.#state;
    if (state.phase === "sealed") return;
    const failure = state.phase === "failed" ? state.error : state.normalize(error);
    this.#state = { phase: "sealed" };
    state.discard(state.draft, failure);
  }
}

function groupConfigurationSealedError() {
  return new Error("Group configuration has been sealed");
}
