import type { PluginChangeSet, PluginContainer, PluginHandle } from "@dougong/core";
import type { ManagedPluginCoreState, ManagedPluginRegistration } from "./managed-plugin";
import type { PlatformChangeOperation } from "./platform-change-set";
import type { AnyPluginDefinition } from "./platform-api";

export interface StagedCoreChange<Reference> {
  readonly artifactStates: ReadonlyArray<{
    readonly operation: Extract<
      PlatformChangeOperation<Reference>,
      { kind: "register" | "update" }
    >;
    readonly state: ManagedPluginCoreState;
  }>;
  commit(): Promise<void>;
}

/** Compiles one validated Platform change into the canonical Core ChangeSet. */
export function stageCoreChange<Reference>(
  container: PluginContainer,
  operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
  definitions: ReadonlyMap<ManagedPluginRegistration<Reference>, AnyPluginDefinition>,
): StagedCoreChange<Reference> {
  let change: PluginChangeSet | undefined;
  const requireChange = () => (change ??= container.change());
  const artifactStates: Array<StagedCoreChange<Reference>["artifactStates"][number]> = [];

  for (const operation of operations) {
    if (operation.kind === "register") {
      const handle = operation.artifact.placeholder
        ? requireChange().install(operation.artifact.placeholder, operation.artifact.config)
        : undefined;
      artifactStates.push({
        operation,
        state: { phase: "registered", coreHandle: handle },
      });
      continue;
    }

    const current = operation.registration.coreHandle;
    if (operation.kind === "remove") {
      if (current && current.status !== "removed") requireChange().remove(current);
      continue;
    }

    const definition = definitions.get(operation.registration);
    if (definition) {
      const coreHandle = stageActivatedUpdate(
        requireChange,
        current,
        operation.artifact.config,
        definition,
      );
      artifactStates.push({ operation, state: { phase: "activated", coreHandle } });
    } else {
      const coreHandle = stagePlaceholderUpdate(requireChange, current, operation.artifact);
      artifactStates.push({ operation, state: { phase: "registered", coreHandle } });
    }
  }

  return Object.freeze({
    artifactStates: Object.freeze(artifactStates),
    commit: () => change?.commit() ?? Promise.resolve(),
  });
}

function stageActivatedUpdate(
  requireChange: () => PluginChangeSet,
  current: PluginHandle | undefined,
  config: unknown,
  definition: AnyPluginDefinition,
) {
  if (current) {
    requireChange().update(current, { plugin: definition, config });
    return current;
  }
  return requireChange().install(definition, config);
}

function stagePlaceholderUpdate<Reference>(
  requireChange: () => PluginChangeSet,
  current: PluginHandle | undefined,
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
