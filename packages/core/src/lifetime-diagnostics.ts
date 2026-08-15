import { SnapshotPublisher, type SnapshotView } from "./snapshot-view";

export type LifetimePhase = "active" | "disposing" | "disposed";

/** Immutable projection of one real Lifetime ownership node. */
export interface LifetimeSnapshot {
  readonly label: string;
  readonly phase: LifetimePhase;
  readonly cleanups: number;
  readonly tasks: number;
  readonly listeners: number;
  readonly contributions: number;
  readonly contributionViews: number;
  readonly subscriptions: number;
  readonly children: ReadonlyArray<LifetimeSnapshot>;
}

export type LifetimeResourceKind =
  "cleanups" | "tasks" | "listeners" | "contributions" | "contributionViews" | "subscriptions";

/** Internal state that mirrors a Lifetime without retaining any owned resource. */
export interface LifetimeDiagnosticNode {
  readonly label: string;
  readonly counts: Record<LifetimeResourceKind, number>;
  readonly children: Set<LifetimeDiagnosticNode>;
  phase: LifetimePhase;
}

/** Publishes immutable data snapshots for one root Lifetime ownership tree. */
export class LifetimeDiagnostics {
  readonly #source: SnapshotPublisher<LifetimeSnapshot>;

  readonly root: LifetimeDiagnosticNode;
  readonly view: SnapshotView<LifetimeSnapshot>;

  constructor(rootLabel: string, report: (error: unknown) => void) {
    this.root = createDiagnosticNode(rootLabel);
    this.#source = new SnapshotPublisher(() => snapshotNode(this.root), report);
    this.view = this.#source.view;
  }

  createNode(label: string) {
    return createDiagnosticNode(label);
  }

  attach(parent: LifetimeDiagnosticNode, child: LifetimeDiagnosticNode) {
    if (parent.children.has(child)) throw new Error("Lifetime diagnostic node is attached");
    parent.children.add(child);
    this.#source.invalidate();
  }

  detach(parent: LifetimeDiagnosticNode, child: LifetimeDiagnosticNode) {
    if (!parent.children.delete(child)) return;
    this.#source.invalidate();
  }

  change(node: LifetimeDiagnosticNode, kind: LifetimeResourceKind, delta: 1 | -1) {
    const next = node.counts[kind] + delta;
    if (next < 0) throw new Error(`Lifetime '${kind}' count cannot be negative`);
    node.counts[kind] = next;
    this.#source.invalidate();
  }

  beginDisposing(node: LifetimeDiagnosticNode) {
    if (node.phase !== "active") return;
    node.phase = "disposing";
    this.#source.invalidate();
  }

  finishRoot() {
    if (this.root.phase === "disposed") return;
    this.root.phase = "disposed";
    this.#source.invalidate();
    this.#source.dispose();
  }
}

function createDiagnosticNode(label: string): LifetimeDiagnosticNode {
  return {
    label,
    phase: "active",
    counts: {
      cleanups: 0,
      tasks: 0,
      listeners: 0,
      contributions: 0,
      contributionViews: 0,
      subscriptions: 0,
    },
    children: new Set(),
  };
}

function snapshotNode(node: LifetimeDiagnosticNode): LifetimeSnapshot {
  const children = Object.freeze([...node.children].map(snapshotNode));
  return Object.freeze({
    label: node.label,
    phase: node.phase,
    ...node.counts,
    children,
  });
}
