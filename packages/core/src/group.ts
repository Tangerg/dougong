/**
 * A Group is an ownership tree over installations, never a capability scope.
 * Service resolution and Extension/Event visibility remain application-wide.
 */
export class GroupNode {
  readonly #children = new Map<string, GroupNode>();
  #attached = true;
  #error: unknown;

  private constructor(
    readonly id: string,
    readonly name: string,
    readonly parent: GroupNode | undefined,
  ) {}

  static root(name: string) {
    return new GroupNode("/", name, undefined);
  }

  get attached() {
    return this.#attached;
  }

  get children(): ReadonlyArray<GroupNode> {
    return [...this.#children.values()];
  }

  get error() {
    return this.#error;
  }

  fail(error: unknown) {
    this.#error = error;
  }

  recover() {
    this.#error = undefined;
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
    let current: GroupNode | undefined = candidate;
    while (current) {
      if (current === this) return true;
      current = current.parent;
    }
    return false;
  }

  assertAttached() {
    if (!this.#attached) throw new TypeError(`Group '${this.id}' has been removed`);
  }

  detach() {
    if (!this.#attached) return;
    for (const child of this.#children.values()) child.detach();
    this.#children.clear();
    this.#attached = false;
    if (this.parent) this.parent.#children.delete(this.name);
  }

  walk() {
    const groups: GroupNode[] = [this];
    for (let index = 0; index < groups.length; index++) {
      groups.push(...groups[index]!.children);
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
