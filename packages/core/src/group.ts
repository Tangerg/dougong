// Two independent structures live in this file:
//
//   GroupConfigurationSession  the transaction shared by a `group()` callback and
//                              every nested `group()` inside it
//   GroupNode                  the ownership tree itself
//
// They are separate because a configuration transaction is short-lived and
// spans several nodes, while a node outlives every transaction that touched it.

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

type GroupNodeState =
  | { readonly phase: "attached"; readonly parent: GroupNode | undefined }
  | { readonly phase: "detached" };

/**
 * A Group is an ownership tree over installations, never a capability scope.
 * Service resolution and ExtensionPoint/Event visibility remain Host-wide.
 *
 * So a Plugin inside a Group sees exactly what it would see outside one: the
 * same providers, the same contributions. The only thing membership decides is
 * what gets removed together. Ids are paths (`/ui/panels`) because a position in
 * this tree is the whole meaning of a Group.
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

  contains(candidate: GroupNode) {
    if (candidate === this) return true;
    for (const child of this.#children.values()) {
      if (child.contains(candidate)) return true;
    }
    return false;
  }

  assertAttached() {
    if (this.#state.phase === "detached") {
      throw new TypeError(`Group '${this.id}' has been removed`);
    }
  }

  // Depth-first, and children are detached before this node unlinks itself from
  // its parent. A node that unlinked first would leave its subtree unreachable
  // but still attached, so those groups would report themselves as live with no
  // path back to the root.
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
