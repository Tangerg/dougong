import type { ChangeSet, Installer, Installation } from "@dougongjs/core";
import type { RegistrationCommitState, RegistrationRecord } from "./registration";
import type { PlatformChangeOperation } from "./platform-change-set";
import type { ErasedPlugin } from "./platform-api";

export interface StagedCoreChange<Reference> {
  readonly registrationStates: ReadonlyArray<{
    readonly operation: Extract<
      PlatformChangeOperation<Reference>,
      { kind: "register" | "update" }
    >;
    readonly state: RegistrationCommitState;
  }>;
  commit(): Promise<void>;
}

/** Compiles one validated Platform change into the canonical Core ChangeSet. */
export function stageCoreChange<Reference>(
  installer: Installer,
  operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
  loadedPlugins: ReadonlyMap<RegistrationRecord<Reference>, ErasedPlugin>,
): StagedCoreChange<Reference> {
  let change: ChangeSet | undefined;
  const requireChange = () => (change ??= installer.change());
  const registrationStates: Array<StagedCoreChange<Reference>["registrationStates"][number]> = [];

  for (const operation of operations) {
    if (operation.kind === "register") {
      const installation = operation.artifact.placeholder
        ? requireChange().install(operation.artifact.placeholder, operation.artifact.config)
        : undefined;
      registrationStates.push({
        operation,
        state: { phase: "registered", installation },
      });
      continue;
    }

    const current = operation.registration.installation;
    if (operation.kind === "remove") {
      if (current && current.status !== "removed") requireChange().remove(current);
      continue;
    }

    const plugin = loadedPlugins.get(operation.registration);
    if (plugin) {
      const installation = stageActivatedUpdate(
        requireChange,
        current,
        operation.artifact.config,
        plugin,
      );
      registrationStates.push({ operation, state: { phase: "activated", installation } });
    } else {
      const installation = stagePlaceholderUpdate(requireChange, current, operation.artifact);
      registrationStates.push({ operation, state: { phase: "registered", installation } });
    }
  }

  return Object.freeze({
    registrationStates: Object.freeze(registrationStates),
    commit: () => change?.commit() ?? Promise.resolve(),
  });
}

function stageActivatedUpdate(
  requireChange: () => ChangeSet,
  current: Installation | undefined,
  config: unknown,
  plugin: ErasedPlugin,
) {
  if (current) {
    requireChange().update(current, { plugin, config });
    return current;
  }
  return requireChange().install(plugin, config);
}

function stagePlaceholderUpdate<Reference>(
  requireChange: () => ChangeSet,
  current: Installation | undefined,
  artifact: Extract<PlatformChangeOperation<Reference>, { kind: "update" }>["artifact"],
) {
  if (current && artifact.placeholder) {
    requireChange().update(current, {
      plugin: artifact.placeholder,
      config: artifact.config,
    });
    return current;
  }
  if (current) {
    if (current.status !== "removed") requireChange().remove(current);
    return undefined;
  }
  return artifact.placeholder
    ? requireChange().install(artifact.placeholder, artifact.config)
    : undefined;
}
