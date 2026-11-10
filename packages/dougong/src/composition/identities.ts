import { DougongError, groupForeignCode, installationForeignCode } from "../contracts/errors.js";
import type { ChangePort } from "./change-set.js";
import { GroupNode } from "./group.js";
import { InstallationRecord } from "./installation.js";

// Public handles are inert facades; only the Host that created one can map it back to its record.
export class HostIdentities implements ChangePort {
  readonly #installations = new WeakMap<object, InstallationRecord>();
  readonly #groups = new WeakMap<object, GroupNode>();

  createInstallation(id: string, group: GroupNode | undefined) {
    const record = new InstallationRecord(id, group);
    this.#installations.set(record.facade, record);
    return record;
  }

  resolveInstallation(handle: object) {
    const record = this.#installations.get(handle);
    if (!record)
      throw new DougongError(installationForeignCode, "Installation belongs to another Host");
    return record;
  }

  createGroup(id: string, parent: GroupNode | undefined) {
    const group = new GroupNode(id, parent);
    this.#groups.set(group.facade, group);
    return group;
  }

  resolveGroup(handle: object) {
    const group = this.#groups.get(handle);
    if (!group) throw new DougongError(groupForeignCode, "Group belongs to another Host");
    return group;
  }
}
