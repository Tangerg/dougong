import type { ErrorSnapshot } from "../contracts/errors.js";

export type LifetimePhase = "active" | "sealed" | "disposing" | "disposed" | "quarantined";
export type ObligationKind = "cleanup" | "interrupt" | "publication" | "shutdown";

export interface UnresolvedObligation {
  readonly id: number;
  readonly kind: ObligationKind;
  readonly error: ErrorSnapshot;
}

export interface LifetimeSnapshot {
  readonly label: string;
  readonly phase: LifetimePhase;
  readonly cleanups: number;
  readonly interrupts: number;
  readonly tasks: number;
  readonly acquisitions: number;
  readonly publications: number;
  readonly foreground: number;
  readonly unresolved: ReadonlyArray<UnresolvedObligation>;
  readonly children: ReadonlyArray<LifetimeSnapshot>;
}
