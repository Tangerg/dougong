type GroupNodeState =
  | { readonly phase: "attached"; readonly parent: GroupNode | undefined }
  | { readonly phase: "detached" };

// Groups define ownership only; changing placement must not change Contract visibility.
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
    for (let node: GroupNode | undefined = candidate; node; node = node.parent) {
      if (node === this) return true;
    }
    return false;
  }

  assertAttached() {
    if (this.#state.phase === "detached") {
      throw new TypeError(`Group '${this.id}' has been removed`);
    }
  }

  // Detach descendants first so no live subtree becomes unreachable from its owner.
  detach() {
    const state = this.#state;
    if (state.phase === "detached") return [];
    const detached: GroupNode[] = [];
    for (const child of this.#children.values()) detached.push(...child.detach());
    this.#children.clear();
    this.#state = { phase: "detached" };
    if (state.parent) state.parent.#children.delete(this.name);
    detached.push(this);
    return detached;
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
