import type { Group } from "./declarations.js";

export class GroupNode {
  readonly facade: Group;
  constructor(
    readonly id: string,
    readonly parent: GroupNode | undefined,
  ) {
    this.facade = Object.freeze({ id, parentId: parent?.id }) as Group;
  }
  get parentId() {
    return this.parent?.id;
  }
}
