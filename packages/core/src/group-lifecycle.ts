import { DougongError, normalizeFailure } from "./errors";
import type { GroupNode } from "./group";
import type { InstallationStatus } from "./installation";

/**
 * Owns the readiness barrier for one structural Group node. A failed mutation
 * cannot poison an established Group because transactions expose only the
 * restored committed state.
 */
export class GroupLifecycle {
  #state: GroupLifecycleState;
  #notifyChanged: (() => void) | undefined;

  constructor(
    readonly node: GroupNode,
    initialState: "new" | "established",
    notifyChanged: () => void,
  ) {
    this.#state = { phase: initialState };
    this.#notifyChanged = notifyChanged;
  }

  status(contents: InstallationStatus): InstallationStatus {
    if (!this.node.attached) return "removed";
    const state = this.#state;
    if (state.phase === "pending") return contents === "stopping" ? "stopping" : "pending";
    if (state.phase === "failed") return "failed";
    return state.phase === "established" ? contents : "pending";
  }

  async ready(readyContents: () => Promise<void>) {
    this.node.assertAttached();
    const state = this.#state;
    if (state.phase === "pending") await state.barrier;
    this.node.assertAttached();
    const settled = this.#state;
    if (settled.phase === "failed") throw settled.error;
    await readyContents();
  }

  track(operation: Promise<void>) {
    this.node.assertAttached();
    const current = this.#state;
    const preserveCommittedState =
      current.phase === "established" ||
      (current.phase === "pending" && current.baseline === "established");
    const attempt = {};

    const barrier = operation.then(
      () => {
        if (!this.#isCurrent(attempt)) return;
        this.#state = { phase: "established" };
        this.#notifyChanged?.();
      },
      (error) => {
        const failure = normalizeFailure(
          error,
          "GROUP_UNAVAILABLE",
          `Group '${this.node.id}' operation failed with a non-Error value`,
        );
        if (this.#isCurrent(attempt)) {
          this.#state = preserveCommittedState
            ? { phase: "established" }
            : { phase: "failed", error: failure };
          this.#notifyChanged?.();
        }
        if (!preserveCommittedState) throw failure;
      },
    );
    this.#state = {
      phase: "pending",
      attempt,
      barrier,
      baseline: preserveCommittedState ? "established" : "new",
    };
    this.#notifyChanged?.();
    // ready() owns this barrier's failure; mark the internal observer branch handled.
    void barrier.catch(() => undefined);
  }

  release() {
    this.#state = { phase: "released" };
    this.#notifyChanged = undefined;
  }

  #isCurrent(attempt: object) {
    const state = this.#state;
    return state.phase === "pending" && state.attempt === attempt;
  }
}

type GroupLifecycleState =
  | { readonly phase: "new" | "established" }
  | {
      readonly phase: "pending";
      readonly attempt: object;
      readonly barrier: Promise<void>;
      readonly baseline: "new" | "established";
    }
  | { readonly phase: "failed"; readonly error: Error }
  | { readonly phase: "released" };

export function groupRemovedError(group: GroupNode) {
  return new DougongError("GROUP_REMOVED", `Group '${group.id}' has been removed`);
}
