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
