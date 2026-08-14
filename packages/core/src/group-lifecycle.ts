import { DougongError, normalizeFailure } from "./errors";
import type { GroupNode } from "./group";
import type { InstallationStatus } from "./plugin-installation";

/**
 * Owns the readiness barrier for one structural Group node. A failed mutation
 * cannot poison an established Group because transactions expose only the
 * restored committed state.
 */
export class GroupLifecycle {
  #established: boolean;
  #pending = false;
  #failure: Error | undefined;
  #barrier: Promise<void> | undefined;
  #notifyChanged: (() => void) | undefined;

  constructor(
    readonly node: GroupNode,
    established: boolean,
    notifyChanged: () => void,
  ) {
    this.#established = established;
    this.#notifyChanged = notifyChanged;
  }

  status(contents: InstallationStatus): InstallationStatus {
    if (!this.node.attached) return "removed";
    if (this.#pending) return contents === "stopping" ? "stopping" : "pending";
    if (this.#failure) return "failed";
    return this.#established ? contents : "pending";
  }

  async ready(readyContents: () => Promise<void>) {
    this.node.assertAttached();
    await this.#barrier;
    this.node.assertAttached();
    if (this.#failure) throw this.#failure;
    await readyContents();
  }

  track(operation: Promise<void>) {
    this.node.assertAttached();
    const preserveCommittedState = this.#established;
    this.#pending = true;
    this.#failure = undefined;

    let barrier: Promise<void>;
    barrier = operation.then(
      () => {
        if (this.#barrier !== barrier) return;
        this.#established = true;
        this.#pending = false;
        this.#notifyChanged?.();
      },
      (error) => {
        const failure = normalizeFailure(
          error,
          "GROUP_UNAVAILABLE",
          `Group '${this.node.id}' operation failed with a non-Error value`,
        );
        if (this.#barrier === barrier) {
          this.#pending = false;
          this.#failure = preserveCommittedState ? undefined : failure;
          this.#notifyChanged?.();
        }
        if (!preserveCommittedState) throw failure;
      },
    );
    this.#barrier = barrier;
    this.#notifyChanged?.();
    void barrier.catch(() => undefined);
  }

  release() {
    this.#pending = false;
    this.#failure = undefined;
    this.#barrier = undefined;
    this.#notifyChanged = undefined;
  }
}

export function groupRemovedError(group: GroupNode) {
  return new DougongError("GROUP_REMOVED", `Group '${group.id}' has been removed`);
}
