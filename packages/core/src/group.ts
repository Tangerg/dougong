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
