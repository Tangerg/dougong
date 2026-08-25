import type { AnyPlugin, ChangeSet, Installer, Installation } from "@dougongjs/core";
import type { RegistrationCommitState, RegistrationRecord } from "./registration";
import type { PlatformChangeOperation } from "./platform-change-set";

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

// The seam between the two layers. Everything Platform decided arrives here as
// operations and becomes exactly one Core ChangeSet — which is what makes a
// Platform change atomic without Platform owning a transaction of its own.
//
// The ChangeSet is created lazily, so a change that touches nothing installable
// (registering artifacts with no placeholder) never opens a Core transaction.
//
// `registrationStates` is returned rather than applied: Platform state must move
// only after the Core commit succeeds, so this stages the intent and the caller
// commits it afterwards.

/** Compiles one validated Platform change into the canonical Core ChangeSet. */
export function stageCoreChange<Reference>(
  installer: Pick<Installer, "change">,
  operations: ReadonlyArray<PlatformChangeOperation<Reference>>,
  loadedPlugins: ReadonlyMap<RegistrationRecord<Reference>, AnyPlugin>,
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
  plugin: AnyPlugin,
) {
  if (current) {
    requireChange().update(current, { plugin, config });
    return current;
  }
  return requireChange().install(plugin, config);
}

// Updating a Registration that is not activated, where the new Artifact may or
// may not carry a placeholder. Four cases, and the third is the interesting one:
// dropping the placeholder from an inactive Registration removes the Installation
// entirely, because there is nothing left for it to hold.
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
