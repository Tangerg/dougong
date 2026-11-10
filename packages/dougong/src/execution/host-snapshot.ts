import { requiredContract } from "../contracts/contracts.js";
import type { RecordedFailure } from "../contracts/recorded-failure.js";
import type { InstallationRecord } from "../composition/installation.js";
import type { HostSnapshot, HostStatus, InstallationSnapshot } from "../inspection/diagnostics.js";
import type { CommittedState } from "./committed-state.js";
import type { Instance } from "./instance.js";

// Everything a snapshot may read. The Engine owns each fact; this module only projects them.
export interface ExecutionFacts {
  readonly name: string;
  readonly status: HostStatus;
  readonly state: CommittedState;
  readonly changing: ReadonlySet<InstallationRecord> | undefined;
  readonly unresolved: ReadonlyArray<Instance>;
  readonly failure: RecordedFailure | undefined;
}

type InstallationExecution =
  | { readonly status: "running" | "changing"; readonly instance: Instance }
  | { readonly status: "stopped" | "changing" | "quarantined"; readonly instance: undefined };

export function installationExecution(
  record: InstallationRecord,
  state: CommittedState,
  changing: ReadonlySet<InstallationRecord> | undefined,
): InstallationExecution {
  const instance = state.instances.get(record);
  const isChanging = changing?.has(record) ?? false;
  if (instance) return { status: isChanging ? "changing" : "running", instance };
  if (state.phase === "quarantined") return { status: "quarantined", instance: undefined };
  return { status: isChanging ? "changing" : "stopped", instance: undefined };
}

export function projectHostSnapshot(facts: ExecutionFacts): HostSnapshot {
  const { state } = facts;
  const installations: InstallationSnapshot[] = [...state.graph.declarations].map(
    ([record, declaration]) => {
      const execution = installationExecution(record, state, facts.changing);
      const description = {
        id: record.id,
        groupId: record.groupId,
        pluginName: declaration.plugin.name,
        origin: declaration.origin,
        requires: Object.freeze(
          Object.values(declaration.plugin.requires).map((token) => requiredContract(token).id),
        ),
        provides: Object.freeze(
          Object.values(declaration.plugin.provides).map((token) => token.id),
        ),
      };
      return Object.freeze(
        execution.instance
          ? {
              ...description,
              status: execution.status,
              generation: execution.instance.generation,
              lifetime: execution.instance.lifetime.snapshot(),
            }
          : {
              ...description,
              status: execution.status,
              generation: undefined,
              lifetime: undefined,
            },
      );
    },
  );
  const members = Map.groupBy(installations, (installation) => installation.groupId);
  return Object.freeze({
    name: facts.name,
    status: facts.status,
    stateRevision: state.revision,
    installations: Object.freeze(installations),
    groups: Object.freeze(
      [...state.groups.values()].map((group) =>
        Object.freeze({
          id: group.id,
          parentId: group.parentId,
          installations: Object.freeze(
            (members.get(group.id) ?? []).map((installation) => installation.id),
          ),
        }),
      ),
    ),
    bindings: state.graph.bindings(),
    unresolved: Object.freeze(
      facts.unresolved.map((instance) =>
        Object.freeze({
          installation: instance.installation.id,
          generation: instance.generation,
          lifetime: instance.lifetime.snapshot(),
        }),
      ),
    ),
    error: facts.failure?.snapshot,
  });
}
