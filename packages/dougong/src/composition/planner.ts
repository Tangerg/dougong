import {
  DougongError,
  changeConflictCode,
  groupConflictCode,
  groupMissingCode,
  groupRemovedCode,
  installationRemovedCode,
} from "../contracts/errors.js";
import type { ContractRegistry } from "../contracts/contract-registry.js";
import { InstallationGraph } from "./installation-graph.js";
import { resolvePluginConfiguration, type ConfigurationValue } from "./configuration.js";
import type { ChangeOperation, NormalizedInstallationUpdate } from "./change-set.js";
import type { GroupNode } from "./group.js";
import {
  claimInstallationId,
  type InstallationDeclaration,
  type InstallationRecord,
} from "./installation.js";
import {
  describeImpact,
  describeOperations,
  type DirectImpactKind,
  type PlanReport,
  type PreparedTransition,
  type ResolvedConfigurations,
  type TransitionIntent,
} from "./plan.js";

export interface CompositionState {
  readonly phase: "stopped" | "running" | "quarantined";
  readonly revision: number;
  readonly groups: ReadonlyMap<string, GroupNode>;
  readonly graph: InstallationGraph;
  readonly configurations: ResolvedConfigurations;
}

type LifecycleIntent = Exclude<TransitionIntent, "change">;

const lifecycleImpact: Readonly<Record<LifecycleIntent, DirectImpactKind>> = Object.freeze({
  start: "started",
  stop: "stopped",
});

export async function compileTransition(
  current: CompositionState,
  operations: ReadonlyArray<ChangeOperation>,
  intent: TransitionIntent,
  contracts: ContractRegistry,
  validity?: AbortSignal,
): Promise<PreparedTransition> {
  const draft = new CompositionDraft(current);
  for (const operation of operations) draft.apply(operation);
  draft.cascadeGroupRemovals();
  draft.assertGroupsCommitted();
  const graph = InstallationGraph.build(draft.declarations);
  contracts.assertKinds(graph.contractKinds);
  const affected =
    intent === "change"
      ? current.graph.affectedByTransitionTo(graph, [...draft.direct.keys()])
      : new Set(graph.order);
  const configurations = await resolveConfigurations(current, draft, intent, validity);
  if (intent !== "change")
    for (const record of affected) draft.direct.set(record, lifecycleImpact[intent]);
  const report = describeTransition(current, operations, intent, graph, affected, draft.direct);
  return Object.freeze({ groups: draft.groups, graph, affected, configurations, report });
}

// Applies staged operations to a copy of the committed composition; nothing here touches the Host.
class CompositionDraft {
  readonly declarations: Map<InstallationRecord, InstallationDeclaration>;
  readonly groups: Map<string, GroupNode>;
  readonly direct = new Map<InstallationRecord, DirectImpactKind>();
  readonly #committed: CompositionState;
  readonly #ids: Set<string>;
  readonly #removedGroups = new Set<GroupNode>();

  constructor(committed: CompositionState) {
    this.#committed = committed;
    this.declarations = new Map(committed.graph.declarations);
    this.groups = new Map(committed.groups);
    this.#ids = new Set(committed.graph.byId.keys());
  }

  apply(operation: ChangeOperation) {
    switch (operation.kind) {
      case "group":
        return this.#createGroup(operation.group);
      case "removeGroup":
        return this.#removeGroup(operation.group);
      case "install":
        return this.#install(operation.installation, operation.declaration);
      case "update":
        return this.#update(operation.installation, operation.update);
      case "remove":
        return this.#remove(operation.installation);
    }
  }

  // Group expresses installation ownership, so its removal takes every owned Installation with it.
  cascadeGroupRemovals() {
    if (!this.#removedGroups.size) return;
    const children = Map.groupBy(this.groups.values(), (group) => group.parent);
    // The Set visits each overlapping ownership subtree once, including descendants added during traversal.
    for (const group of this.#removedGroups) {
      if (this.#committed.groups.get(group.id) !== group)
        throw new DougongError(
          changeConflictCode,
          "Group creation conflicts with ancestor removal: " + group.id,
        );
      this.groups.delete(group.id);
      for (const child of children.get(group) ?? []) this.#removedGroups.add(child);
    }
    for (const record of this.declarations.keys()) {
      if (!record.group || !this.#removedGroups.has(record.group)) continue;
      if (this.direct.has(record))
        throw new DougongError(
          changeConflictCode,
          "Installation change conflicts with Group removal: " + record.id,
        );
      this.declarations.delete(record);
      this.direct.set(record, "removed");
    }
  }

  #createGroup(group: GroupNode) {
    if (this.groups.has(group.id))
      throw new DougongError(groupConflictCode, "Group id is already installed: " + group.id);
    this.groups.set(group.id, group);
  }

  #removeGroup(group: GroupNode) {
    if (this.#committed.groups.get(group.id) !== group)
      throw new DougongError(groupRemovedCode, "Group is not committed: " + group.id);
    this.#removedGroups.add(group);
  }

  #install(record: InstallationRecord, declaration: InstallationDeclaration) {
    claimInstallationId(this.#ids, record.id);
    this.declarations.set(record, declaration);
    this.direct.set(record, "installed");
  }

  #update(record: InstallationRecord, update: NormalizedInstallationUpdate) {
    const previous = this.#declared(record);
    this.declarations.set(
      record,
      Object.freeze(
        update.kind === "replace"
          ? {
              plugin: update.plugin,
              configuration: Object.hasOwn(update, "configuration")
                ? update.configuration
                : previous.configuration,
              origin: update.origin,
            }
          : { ...previous, configuration: update.configuration },
      ),
    );
    this.direct.set(record, "updated");
  }

  #remove(record: InstallationRecord) {
    this.#declared(record);
    this.declarations.delete(record);
    this.direct.set(record, "removed");
  }

  #declared(record: InstallationRecord) {
    const declaration = this.declarations.get(record);
    if (!declaration)
      throw new DougongError(
        installationRemovedCode,
        "Installation is not committed: " + record.id,
      );
    return declaration;
  }

  // Every Group is created with an existing immutable parent. Membership of the direct edge suffices.
  assertGroupsCommitted() {
    for (const group of this.groups.values()) {
      const parent = group.parent;
      if (parent && this.groups.get(parent.id) !== parent)
        throw new DougongError(groupMissingCode, "Group parent is not committed: " + parent.id);
    }
    for (const record of this.declarations.keys()) {
      if (record.group && this.groups.get(record.group.id) !== record.group)
        throw new DougongError(
          groupMissingCode,
          "Installation Group is not committed: " + record.group.id,
        );
    }
  }
}

// Unchanged declarations reuse their validated output instead of consulting a validator again.
async function resolveConfigurations(
  current: CompositionState,
  draft: CompositionDraft,
  intent: TransitionIntent,
  validity: AbortSignal | undefined,
): Promise<ResolvedConfigurations> {
  const configurations = new Map<
    InstallationRecord,
    { readonly value: ConfigurationValue | undefined }
  >();
  for (const [record, declaration] of draft.declarations) {
    const cached =
      current.graph.declarations.get(record) === declaration
        ? current.configurations.get(record)
        : undefined;
    if (cached) configurations.set(record, cached);
    else if (intent === "start" || draft.direct.has(record)) {
      configurations.set(
        record,
        await resolvePluginConfiguration(
          declaration.plugin.configuration,
          declaration.configuration,
          record.id,
          validity,
        ),
      );
    }
  }
  return configurations;
}

function describeTransition(
  current: CompositionState,
  operations: ReadonlyArray<ChangeOperation>,
  intent: TransitionIntent,
  graph: InstallationGraph,
  affected: ReadonlySet<InstallationRecord>,
  direct: ReadonlyMap<InstallationRecord, DirectImpactKind>,
): PlanReport {
  const prepares = intent === "start" || (intent === "change" && current.phase !== "stopped");
  const ordered = (order: ReadonlyArray<InstallationRecord>) =>
    order.filter((record) => affected.has(record)).map((record) => record.id);
  return Object.freeze({
    baseStateRevision: current.revision,
    intent,
    operations: describeOperations(operations, current.graph, graph),
    bindings: Object.freeze({
      before: current.graph.bindings(),
      after: graph.bindings(),
    }),
    affectedInstallations: Object.freeze([...affected].map((record) => record.id)),
    reasons: describeImpact(current.graph, graph, affected, direct),
    stopOrder: Object.freeze(
      current.phase === "running" ? ordered(current.graph.order).reverse() : [],
    ),
    prepareOrder: Object.freeze(prepares ? ordered(graph.order) : []),
    execution: Object.freeze({
      atomicPublication: true as const,
      externalEffectsRollback: false as const,
    }),
  });
}
