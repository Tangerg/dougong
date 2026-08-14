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

/** One explicit transaction shared by every nested Group configure callback. */
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
  return new TypeError("Group configuration has been sealed");
}

type GroupNodeState =
  | { readonly phase: "attached"; readonly parent: GroupNode | undefined }
  | { readonly phase: "detached" };

/**
 * A Group is an ownership tree over installations, never a capability scope.
 * Service resolution and Extension/Event visibility remain application-wide.
 */
export class GroupNode {
  readonly #children = new Map<string, GroupNode>();
  #state: GroupNodeState;

  private constructor(
    readonly id: string,
    readonly name: string,
    parent: GroupNode | undefined,
  ) {
    this.#state = { phase: "attached", parent };
  }

  static root(name: string) {
    return new GroupNode("/", name, undefined);
  }

  get attached() {
    return this.#state.phase !== "detached";
  }

  get children(): ReadonlyArray<GroupNode> {
    return [...this.#children.values()];
  }

  get parent(): GroupNode | undefined {
    const state = this.#state;
    return state.phase === "detached" ? undefined : state.parent;
  }

  create(name: string) {
    this.assertAttached();
    validateGroupName(name);
    if (this.#children.has(name)) {
      throw new TypeError(`Group '${this.#childId(name)}' already exists`);
    }
    const child = new GroupNode(this.#childId(name), name, this);
    this.#children.set(name, child);
    return child;
  }

  containsId(candidateId: string) {
    return this.id === "/"
      ? candidateId.startsWith("/")
      : candidateId === this.id || candidateId.startsWith(`${this.id}/`);
  }

  assertAttached() {
    if (this.#state.phase === "detached") {
      throw new TypeError(`Group '${this.id}' has been removed`);
    }
  }

  detach() {
    const state = this.#state;
    if (state.phase === "detached") return;
    for (const child of this.#children.values()) child.detach();
    this.#children.clear();
    this.#state = { phase: "detached" };
    if (state.parent) state.parent.#children.delete(this.name);
  }

  walk() {
    const groups: GroupNode[] = [this];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      if (group) groups.push(...group.children);
    }
    return groups;
  }

  #childId(name: string) {
    return this.id === "/" ? `/${name}` : `${this.id}/${name}`;
  }
}

function validateGroupName(name: string) {
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError("Group name must be a non-empty string");
  }
  if (name !== name.trim()) {
    throw new TypeError("Group name cannot start or end with whitespace");
  }
  if (name.includes("/")) throw new TypeError("Group name cannot contain '/'");
}
