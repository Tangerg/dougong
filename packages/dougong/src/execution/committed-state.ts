import type { InstallationRecord } from "../composition/installation.js";
import type { CompositionState } from "../composition/planner.js";
import type { Instance } from "./instance.js";

type Execution =
  | {
      readonly phase: "running";
      readonly instances: ReadonlyMap<InstallationRecord, Instance>;
    }
  | { readonly phase: "stopped"; readonly instances?: never }
  | { readonly phase: "quarantined"; readonly instances?: never };

// Only the Engine advances this record; unavailable states cannot retain an active execution map.
export type CommittedState = CompositionState & Execution;
export type NextCommittedState = Omit<CompositionState, "revision"> & Execution;
