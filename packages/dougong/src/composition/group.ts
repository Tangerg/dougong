import { DougongError, groupCycleCode, groupMissingCode } from "../contracts/errors.js";
import type { Group } from "./declarations.js";

export class GroupNode {
  readonly facade: Group;
  constructor(
    readonly id: string,
    readonly parent: GroupNode | undefined,
  ) {
    this.facade = Object.freeze({ id, parentId: parent?.id }) as Group;
    Object.freeze(this);
  }
  get parentId() {
    return this.parent?.id;
  }
}

export function buildInitialGroups(
  parents: ReadonlyMap<string, string | undefined>,
  create: (id: string, parent: GroupNode | undefined) => GroupNode,
) {
  const groups = new Map<string, GroupNode>();
  for (const id of parents.keys()) {
    const chain = new Set<string>();
    let cursor: string | undefined = id;
    while (cursor !== undefined && !groups.has(cursor)) {
      if (!parents.has(cursor))
        throw new DougongError(groupMissingCode, "Initial Group is missing: " + cursor);
      if (chain.has(cursor))
        throw new DougongError(groupCycleCode, "Group ownership must be acyclic");
      chain.add(cursor);
      cursor = parents.get(cursor);
    }
    let parent = cursor === undefined ? undefined : groups.get(cursor);
    for (const child of [...chain].reverse()) {
      parent = create(child, parent);
      groups.set(child, parent);
    }
  }
  return groups;
}
