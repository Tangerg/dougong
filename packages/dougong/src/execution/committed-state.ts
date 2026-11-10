import type { InstallationRecord } from "../composition/installation.js";
import type { CompositionState } from "../composition/planner.js";
import type { Instance } from "./instance.js";

// Only the Engine advances this record, and every advance is a new revision.
export interface CommittedState extends CompositionState {
  readonly instances: ReadonlyMap<InstallationRecord, Instance>;
}
