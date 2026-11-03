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
import type { ChangeOperation } from "./change-set.js";
import type { GroupNode } from "./group.js";
import {
  claimInstallationId,
  type InstallationDeclaration,
  type InstallationRecord,
} from "./installation.js";
import {
  describeBindings,
  describeImpact,
  describeDeclaration,
  type ImpactReason,
  type PreparedTransition,
  type TransitionIntent,
} from "./plan.js";

export interface CompositionState {
  readonly phase: "stopped" | "running" | "quarantined";
  readonly revision: number;
  readonly groups: ReadonlyMap<string, GroupNode>;
  readonly graph: InstallationGraph;
  readonly configurations: ReadonlyMap<
    InstallationRecord,
    { readonly value: ConfigurationValue | undefined }
  >;
}

export async function compileTransition(
  current: CompositionState,
  operations: ReadonlyArray<ChangeOperation>,
  intent: TransitionIntent,
  contracts: ContractRegistry,
  validity?: AbortSignal,
): Promise<PreparedTransition> {
  const declarations = new Map(current.graph.declarations);
  const groups = new Map(current.groups);
  const ids = new Set(current.graph.byId.keys());
  const direct = new Map<InstallationRecord, ImpactReason["kind"]>();
  const removedGroups = new Set<GroupNode>();

  for (const operation of operations) {
    if (operation.kind === "group") {
      if (groups.has(operation.group.id))
        throw new DougongError(
          groupConflictCode,
          "Group id is already installed: " + operation.group.id,
        );
      groups.set(operation.group.id, operation.group);
      continue;
    }
    if (operation.kind === "remove-group") {
      if (current.groups.get(operation.group.id) !== operation.group)
        throw new DougongError(groupRemovedCode, "Group is not committed: " + operation.group.id);
      removedGroups.add(operation.group);
      continue;
    }
    const record = operation.installation;
    if (operation.kind === "install") {
      claimInstallationId(ids, record.id);
      declarations.set(record, operation.declaration);
      direct.set(record, "installed");
    } else {
      const previous = declarations.get(record);
      if (!previous)
        throw new DougongError(
          installationRemovedCode,
          "Installation is not committed: " + record.id,
        );
      if (operation.kind === "remove") {
        declarations.delete(record);
        direct.set(record, "removed");
      } else {
        const replacement = operation.update;
        const changedPlugin = Object.hasOwn(replacement, "plugin");
        declarations.set(
          record,
          Object.freeze({
            plugin: replacement.plugin ?? previous.plugin,
            configuration: Object.hasOwn(replacement, "configuration")
              ? replacement.configuration
              : previous.configuration,
            origin: changedPlugin ? replacement.origin : previous.origin,
          }),
        );
        direct.set(record, "updated");
      }
    }
  }

  if (removedGroups.size) {
    const children = Map.groupBy(groups.values(), (group) => group.parent);
    // The Set visits each overlapping ownership subtree once, including descendants added during traversal.
    for (const group of removedGroups) {
      if (current.groups.get(group.id) !== group)
        throw new DougongError(
          changeConflictCode,
          "Group creation conflicts with ancestor removal: " + group.id,
        );
      groups.delete(group.id);
      for (const child of children.get(group) ?? []) removedGroups.add(child);
    }
    for (const record of declarations.keys()) {
      if (!record.group || !removedGroups.has(record.group)) continue;
      if (direct.has(record))
        throw new DougongError(
          changeConflictCode,
          "Installation change conflicts with Group removal: " + record.id,
        );
      declarations.delete(record);
      direct.set(record, "removed");
    }
  }
  assertGroups(groups, declarations);
  const graph = InstallationGraph.build(declarations);
  contracts.assertKinds(graph.contractKinds);
  const affected =
    intent === "change"
      ? current.graph.affectedByTransitionTo(graph, [...direct.keys()])
      : new Set(graph.order);
  const configurations = new Map<
    InstallationRecord,
    { readonly value: ConfigurationValue | undefined }
  >();
  for (const [record, declaration] of declarations) {
    const cached =
      current.graph.declarations.get(record) === declaration
        ? current.configurations.get(record)
        : undefined;
    if (cached) configurations.set(record, cached);
    else if (intent === "start" || direct.has(record)) {
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
  if (intent !== "change") for (const record of affected) direct.set(record, intent);
  const prepareOrder = Object.freeze(
    intent === "stop" || (intent === "change" && current.phase === "stopped")
      ? []
      : graph.order.filter((record) => affected.has(record)).map((record) => record.id),
  );
  const report = Object.freeze({
    baseStateRevision: current.revision,
    intent,
    operations: Object.freeze(
      operations.map((operation) =>
        "installation" in operation
          ? Object.freeze({
              kind: operation.kind,
              id: operation.installation.id,
              before: describeDeclaration(current.graph.declarations.get(operation.installation)),
              after: describeDeclaration(declarations.get(operation.installation)),
            })
          : Object.freeze({
              kind: operation.kind,
              id: operation.group.id,
              parentId: operation.group.parentId,
            }),
      ),
    ),
    bindings: Object.freeze({
      before: describeBindings(current.graph),
      after: describeBindings(graph),
    }),
    affectedInstallations: Object.freeze([...affected].map((record) => record.id)),
    reasons: describeImpact(current.graph, graph, affected, direct),
    stopOrder: Object.freeze(
      current.phase !== "running"
        ? []
        : current.graph.order
            .filter((record) => affected.has(record))
            .reverse()
            .map((record) => record.id),
    ),
    prepareOrder,
    publishOrder: prepareOrder,
    execution: Object.freeze({
      atomicPublication: true as const,
      externalEffectsRollback: false as const,
    }),
  });
  return Object.freeze({
    groups,
    graph,
    affected,
    configurations,
    report,
  });
}

function assertGroups(
  groups: ReadonlyMap<string, GroupNode>,
  declarations: ReadonlyMap<InstallationRecord, InstallationDeclaration>,
) {
  for (const group of groups.values()) {
    // Every Group is created with an existing immutable parent. Membership of the direct edge suffices.
    const parent = group.parent;
    if (parent && groups.get(parent.id) !== parent)
      throw new DougongError(groupMissingCode, "Group parent is not committed: " + parent.id);
  }
  for (const record of declarations.keys()) {
    if (record.group && groups.get(record.group.id) !== record.group)
      throw new DougongError(
        groupMissingCode,
        "Installation Group is not committed: " + record.group.id,
      );
  }
}
