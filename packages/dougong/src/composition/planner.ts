import { DougongError } from "../contracts/errors.js";
import type { ContractRegistry } from "../contracts/contract-registry.js";
import { InstallationGraph } from "./installation-graph.js";
import { resolvePluginConfig, type ConfigValue } from "./configuration.js";
import type { ChangeOperation } from "./change-set.js";
import type { GroupNode } from "./group.js";
import type { InstallationDeclaration, InstallationRecord } from "./installation.js";
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
  readonly configs: ReadonlyMap<InstallationRecord, { readonly value: ConfigValue | undefined }>;
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
  const changed = new Set<InstallationRecord>();
  const direct = new Map<InstallationRecord, ImpactReason["kind"]>();
  const installedIds = new Set([...current.graph.declarations.keys()].map((record) => record.id));

  for (const operation of operations) {
    if (operation.kind === "group") {
      if (groups.has(operation.group.id))
        throw new DougongError(
          "GROUP_CONFLICT",
          "Group id is already installed: " + operation.group.id,
        );
      groups.set(operation.group.id, operation.group);
      continue;
    }
    if (operation.kind === "remove-group") continue;
    const record = operation.installation;
    if (operation.kind === "install") {
      if (installedIds.has(record.id))
        throw new DougongError(
          "INSTALLATION_CONFLICT",
          "Installation id is already installed: " + record.id,
        );
      installedIds.add(record.id);
      declarations.set(record, operation.declaration);
      direct.set(record, "installed");
    } else {
      const previous = declarations.get(record);
      if (!previous)
        throw new DougongError(
          "INSTALLATION_REMOVED",
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
            config: Object.hasOwn(replacement, "config") ? replacement.config : previous.config,
            origin: changedPlugin ? replacement.origin : previous.origin,
          }),
        );
        direct.set(record, "updated");
      }
    }
    changed.add(record);
  }

  for (const operation of operations) {
    if (operation.kind !== "remove-group") continue;
    if (current.groups.get(operation.group.id) !== operation.group) {
      throw new DougongError("GROUP_REMOVED", "Group is not committed: " + operation.group.id);
    }
    const removed = new Set([operation.group.id]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const group of groups.values()) {
        if (group.parentId && removed.has(group.parentId) && !removed.has(group.id)) {
          removed.add(group.id);
          expanded = true;
        }
      }
    }
    for (const [record] of declarations) {
      if (record.groupId === undefined || !removed.has(record.groupId)) continue;
      if (direct.has(record))
        throw new DougongError(
          "CHANGE_CONFLICT",
          "Installation change conflicts with Group removal: " + record.id,
        );
      declarations.delete(record);
      changed.add(record);
      direct.set(record, "removed");
    }
    for (const id of removed) {
      if (!current.groups.has(id))
        throw new DougongError(
          "CHANGE_CONFLICT",
          "Group creation conflicts with ancestor removal: " + id,
        );
      groups.delete(id);
    }
  }
  assertGroups(groups, declarations);
  const graph = InstallationGraph.build(declarations);
  contracts.assertKinds(graph.contractKinds);
  const affected =
    intent === "change"
      ? current.graph.affectedByTransitionTo(graph, changed)
      : new Set(graph.order);
  if (intent !== "change") for (const record of affected) direct.set(record, intent);
  const configs = new Map<InstallationRecord, { readonly value: ConfigValue | undefined }>();
  for (const [record, declaration] of declarations) {
    const cached =
      current.graph.declarations.get(record) === declaration
        ? current.configs.get(record)
        : undefined;
    if (cached) configs.set(record, cached);
    else if (intent === "start" || changed.has(record)) {
      configs.set(
        record,
        await resolvePluginConfig(
          declaration.plugin.config,
          declaration.config,
          record.id,
          validity,
        ),
      );
    }
  }
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
    configs,
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
      throw new DougongError("GROUP_MISSING", "Group parent is not committed: " + parent.id);
  }
  for (const record of declarations.keys()) {
    if (record.group && groups.get(record.group.id) !== record.group)
      throw new DougongError(
        "GROUP_MISSING",
        "Installation Group is not committed: " + record.group.id,
      );
  }
}
