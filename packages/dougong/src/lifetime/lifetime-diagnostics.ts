import type { ErrorSnapshot } from "../contracts/recorded-failure.js";

export type LifetimePhase = "active" | "sealed" | "disposing" | "disposed" | "quarantined";
export type ObligationKind = "cleanup" | "interrupt" | "publication" | "shutdown";

export type UnresolvedObligation = {
  readonly error: ErrorSnapshot;
} & (
  | { readonly kind: Exclude<ObligationKind, "shutdown">; readonly id: number }
  | { readonly kind: "shutdown"; readonly id?: never }
);

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
