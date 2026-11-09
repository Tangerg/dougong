import { z } from "zod";
import { expectTypeOf } from "vitest";
import {
  createHost,
  definePlugin,
  type InitialInstallation,
  type InstallationSnapshot,
  type Logger,
  type RecordedFailure,
} from "dougong";
import {
  createPlatform,
  defineManifest,
  ImportLoader,
  MemoryLoader,
  type ActivationBlocker,
  type Artifact,
  type ArtifactOrigin,
  type Authorizer,
  type ManifestInput,
  type Platform,
  type PlatformOptions,
  type Registration,
  type RegistrationSnapshot,
} from "@dougongjs/platform";

const invalidPolicy: Authorizer = {
  // @ts-expect-error Denials must throw or reject so a false result cannot open admission.
  authorize: () => false,
};
void invalidPolicy;

expectTypeOf<ActivationBlocker["code"]>().toEqualTypeOf<
  | "REGISTRATION_DEPENDENCY_MISSING"
  | "REGISTRATION_DEPENDENCY_INCOMPATIBLE"
  | "REGISTRATION_DEPENDENCY_INACTIVE"
  | "REGISTRATION_CYCLE"
>();
// @ts-expect-error Module loading is deferred beyond the metadata preview.
const loadingBlocker: ActivationBlocker["code"] = "MODULE_LOAD_FAILED";
// @ts-expect-error Module validation is deferred beyond the metadata preview.
const validationBlocker: ActivationBlocker["code"] = "MODULE_INVALID";
// @ts-expect-error Permission admission is deferred beyond the metadata preview.
const permissionBlocker: ActivationBlocker["code"] = "PERMISSION_DENIED";
// @ts-expect-error Command admission failures are not delivery dependency blockers.
const busyBlocker: ActivationBlocker["code"] = "PLATFORM_BUSY";
void [loadingBlocker, validationBlocker, permissionBlocker, busyBlocker];

const plugin = definePlugin({ name: "types", setup() {} });
const platform = createPlatform({
  id: "types",
  host: createHost(),
  apiVersion: "1.0.0",
  loader: new MemoryLoader(new Map([["module", { default: plugin }]])),
  logger: {
    debug() {},
    info: () => 1,
    warn() {},
    async error() {},
  },
});
expectTypeOf<NonNullable<PlatformOptions<unknown>["logger"]>>().toEqualTypeOf<Logger<unknown>>();

const declaration = {
  name: plugin.name,
  version: "1.0.0",
  activation: ["startup"],
  permissions: ["read"],
} as const;
const manifest: ManifestInput = defineManifest(declaration);

const artifact: Artifact<string> = platform.catalog.add({
  revision: "release-1",
  manifest,
  reference: "module",
});

const registrations: Promise<readonly [Registration<string>]> = platform.select([artifact]);
void registrations;
expectTypeOf(platform.select([])).toEqualTypeOf<Promise<readonly []>>();
const artifacts: ReadonlyArray<Artifact<string>> = [artifact];
expectTypeOf(platform.select(artifacts)).toEqualTypeOf<
  Promise<ReadonlyArray<Registration<string>>>
>();

// @ts-expect-error Selection accepts one complete batch, including singleton requests.
platform.select(artifact);

const fabricatedArtifact = {
  revision: "fabricated",
  manifest: defineManifest({ name: "fabricated", version: "1.0.0" }),
  reference: "module",
  configuration: undefined,
};
// @ts-expect-error Only Catalog-issued identities are Artifact handles.
platform.select([fabricatedArtifact]);

const fabricatedRegistration = {
  id: "fabricated",
  name: artifact.manifest.name,
  selectedArtifact: artifact,
  selectionRevision: 1,
  activeOrigin: undefined,
  installation: undefined,
  status: "selected",
  error: undefined,
} as const;
// @ts-expect-error Only Platform-issued identities are Registration handles.
platform.activate([fabricatedRegistration]);

const importLoader = new ImportLoader();
const importReference = new URL("data:text/javascript,export default 42");
importLoader.load(importReference.href, new AbortController().signal);
// @ts-expect-error Import references must capture their string value before deferred loading.
importLoader.load(importReference, new AbortController().signal);
const importPlatform = createPlatform({
  id: "import-types",
  host: createHost(),
  apiVersion: "1.0.0",
  loader: importLoader,
});
const importArtifact = importPlatform.catalog.add({
  revision: "import-release-1",
  manifest,
  reference: importReference.href,
});
expectTypeOf(importArtifact).toEqualTypeOf<Artifact<string>>();
importPlatform.catalog.add({
  revision: "import-release-2",
  manifest,
  // @ts-expect-error Catalog must not infer a mutable URL reference from ImportLoader.
  reference: importReference,
});

// @ts-expect-error A string Loader cannot accept arbitrary reference values.
const unsafePlatform: Platform<unknown> = platform;
void unsafePlatform;

platform.catalog.add({
  revision: "bad",
  manifest: { name: "types", version: "1.0.0" },
  // @ts-expect-error Catalog references must match the selected Loader.
  reference: 42,
});

// @ts-expect-error Artifact revisions are immutable and required.
platform.catalog.add({ manifest: { name: "types", version: "1.0.0" }, reference: "module" });

// @ts-expect-error Selection is distinct from activation; ambiguous updates no longer exist.
platform.register(artifact);

// @ts-expect-error The standard asynchronous release protocol is the only disposal entry.
platform.dispose();

async function usePlatform() {
  await using owned = createPlatform({
    id: "scope",
    host: createHost(),
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map<string, unknown>()),
  });
  const [selected] = await owned.select([
    owned.catalog.add({
      revision: "r1",
      manifest: { name: "scope", version: "1.0.0" },
      reference: "module",
    }),
  ]);
  owned.preview([selected], { remove: [] });
  await owned.activate([selected], { signal: new AbortController().signal, remove: [] });
}

void usePlatform;

const defaultSchema = z.number().default(42);
const optionalSchema = z.string().optional();
const transformSchema = z.string().transform(Number);
const defaulted = definePlugin({
  name: "initial.defaulted",
  configuration: defaultSchema,
  setup(_context, value) {
    expectTypeOf(value).toEqualTypeOf<z.output<typeof defaultSchema>>();
  },
});
const optional = definePlugin({
  name: "initial.optional",
  configuration: optionalSchema,
  setup(_context, value) {
    expectTypeOf(value).toEqualTypeOf<string | undefined>();
  },
});
const transformed = definePlugin({
  name: "initial.transformed",
  configuration: transformSchema,
  setup(_context, value) {
    expectTypeOf(value).toEqualTypeOf<number>();
  },
});

expectTypeOf<InitialInstallation<typeof defaulted>["configuration"]>().toEqualTypeOf<
  z.input<typeof defaultSchema>
>();
expectTypeOf<InitialInstallation<typeof transformed>["configuration"]>().toEqualTypeOf<
  z.input<typeof transformSchema>
>();
createHost({
  installations: [
    { id: "defaulted", plugin: defaulted },
    { id: "explicit-default", plugin: defaulted, configuration: undefined },
    { id: "configured", plugin: defaulted, configuration: 7 },
    { id: "optional", plugin: optional },
    { id: "text", plugin: optional, configuration: "text" },
    { id: "transformed", plugin: transformed, configuration: "42" },
  ],
});
// @ts-expect-error A default permits omission without accepting a different input type.
createHost({ installations: [{ id: "wrong-default", plugin: defaulted, configuration: "42" }] });
// @ts-expect-error Transform output cannot substitute for the declared input.
createHost({ installations: [{ id: "wrong-transform", plugin: transformed, configuration: 42 }] });
// @ts-expect-error Transform input is still required without a default or optional input.
createHost({ installations: [{ id: "missing-transform", plugin: transformed }] });

const change = createHost().change();
change.install(defaulted, { id: "defaulted" });
change.install(optional, { id: "optional" });
change.install(transformed, { id: "transformed", configuration: "42" });
// @ts-expect-error Both installation paths use the same input constraint.
change.install(defaulted, { id: "wrong-default", configuration: "42" });

function inspectRegistrationSnapshot(
  snapshot: RegistrationSnapshot,
  failure: RecordedFailure,
  registration: Registration<string>,
) {
  expectTypeOf(snapshot.execution).toEqualTypeOf<InstallationSnapshot["status"] | undefined>();
  if (snapshot.status === "installed") {
    expectTypeOf(snapshot.error).toEqualTypeOf<undefined>();
    expectTypeOf(snapshot.activeOrigin).toEqualTypeOf<ArtifactOrigin>();
    expectTypeOf(snapshot.execution).toEqualTypeOf<
      Exclude<InstallationSnapshot["status"], "quarantined">
    >();
  } else if (snapshot.status === "failed") {
    expectTypeOf(snapshot.error).toEqualTypeOf<RecordedFailure>();
  } else if (snapshot.status === "selected") {
    expectTypeOf(snapshot.error).toEqualTypeOf<undefined>();
  } else if (snapshot.status === "quarantined") {
    expectTypeOf(snapshot.execution).toEqualTypeOf<"quarantined">();
    expectTypeOf(snapshot.activeOrigin).toEqualTypeOf<ArtifactOrigin | undefined>();
    expectTypeOf(snapshot.error).toEqualTypeOf<RecordedFailure | undefined>();
  } else {
    expectTypeOf(snapshot.error).toEqualTypeOf<RecordedFailure | undefined>();
  }
  if (snapshot.execution === "quarantined") {
    expectTypeOf(snapshot.status).toEqualTypeOf<"quarantined">();
  }
  if (snapshot.execution === undefined) {
    expectTypeOf(snapshot.activeOrigin).toEqualTypeOf<undefined>();
  }
  if (registration.status === "failed") {
    expectTypeOf(registration.error).toEqualTypeOf<RecordedFailure | undefined>();
  }
  for (const status of ["activating", "removing"] as const) {
    const retained: RegistrationSnapshot = {
      ...snapshot,
      status,
      execution: "running",
      error: failure,
    };
    const clear: RegistrationSnapshot = {
      ...snapshot,
      status,
      execution: "running",
      error: undefined,
    };
    void [retained, clear];
  }
  const activeOrigin: ArtifactOrigin = {
    kind: "artifact",
    platformId: "types",
    revision: artifact.revision,
    manifest: artifact.manifest,
  };
  const installed = {
    ...snapshot,
    activeOrigin,
    status: "installed",
    error: undefined,
  } as const;
  for (const execution of ["stopped", "running", "changing"] as const) {
    const healthy: RegistrationSnapshot = { ...installed, execution };
    void healthy;
  }
  const failed: RegistrationSnapshot = {
    ...snapshot,
    activeOrigin,
    status: "failed",
    execution: "running",
    error: failure,
  };
  const selected: RegistrationSnapshot = {
    ...snapshot,
    activeOrigin,
    status: "selected",
    execution: "running",
    error: undefined,
  };
  const quarantined: RegistrationSnapshot = {
    ...snapshot,
    activeOrigin,
    status: "quarantined",
    execution: "quarantined",
    error: failure,
  };
  const quarantineWithoutOrigin: RegistrationSnapshot = {
    ...quarantined,
    activeOrigin: undefined,
    error: undefined,
  };
  const executionWithoutOrigin: RegistrationSnapshot = { ...selected, activeOrigin: undefined };
  const uncommitted: RegistrationSnapshot = {
    ...selected,
    activeOrigin: undefined,
    execution: undefined,
  };
  void [
    failed,
    selected,
    quarantined,
    quarantineWithoutOrigin,
    executionWithoutOrigin,
    uncommitted,
  ];

  // @ts-expect-error Failed snapshots always carry the recorded failure.
  const missingError: RegistrationSnapshot = { ...failed, error: undefined };
  // @ts-expect-error Healthy selections cannot retain an activation failure.
  const selectedError: RegistrationSnapshot = { ...selected, error: failure };
  // @ts-expect-error An installed selection has no unresolved activation failure.
  const installedError: RegistrationSnapshot = {
    ...installed,
    execution: "running",
    error: failure,
  };
  // @ts-expect-error A matching installed selection always has committed origin data.
  const missingOrigin: RegistrationSnapshot = {
    ...installed,
    execution: "running",
    activeOrigin: undefined,
  };
  // @ts-expect-error A matching installed selection always has committed execution state.
  const missingExecution: RegistrationSnapshot = { ...installed, execution: undefined };
  // @ts-expect-error Quarantined execution has its own Registration status.
  const quarantinedInstallation: RegistrationSnapshot = { ...installed, execution: "quarantined" };
  // @ts-expect-error Quarantined execution cannot retain selected status.
  const quarantinedSelection: RegistrationSnapshot = { ...selected, execution: "quarantined" };
  // @ts-expect-error Quarantined execution takes precedence over a recorded activation failure.
  const quarantinedFailure: RegistrationSnapshot = { ...failed, execution: "quarantined" };
  // @ts-expect-error Quarantined execution takes precedence over an activation operation.
  const quarantinedActivation: RegistrationSnapshot = { ...quarantined, status: "activating" };
  // @ts-expect-error Quarantined execution takes precedence over a removal operation.
  const quarantinedRemoval: RegistrationSnapshot = { ...quarantined, status: "removing" };
  // @ts-expect-error Quarantined status requires a quarantined Core execution.
  const runningQuarantine: RegistrationSnapshot = { ...quarantined, execution: "running" };
  // @ts-expect-error An absent Core execution cannot be quarantined.
  const uncommittedQuarantine: RegistrationSnapshot = {
    ...quarantined,
    activeOrigin: undefined,
    execution: undefined,
  };
  // @ts-expect-error An absent Core installation cannot supply a committed Artifact origin.
  const originWithoutExecution: RegistrationSnapshot = { ...selected, execution: undefined };
  // @ts-expect-error Removed identities are absent from the current registration snapshot.
  const removed: RegistrationSnapshot = { ...snapshot, status: "removed" };
  // @ts-expect-error A pending identity is not committed execution.
  const pendingExecution: RegistrationSnapshot = { ...snapshot, execution: "pending" };
  // @ts-expect-error A removed identity is not committed execution.
  const removedExecution: RegistrationSnapshot = { ...snapshot, execution: "removed" };
  void [
    missingError,
    selectedError,
    installedError,
    missingOrigin,
    missingExecution,
    quarantinedInstallation,
    quarantinedSelection,
    quarantinedFailure,
    quarantinedActivation,
    quarantinedRemoval,
    runningQuarantine,
    uncommittedQuarantine,
    originWithoutExecution,
    removed,
    pendingExecution,
    removedExecution,
  ];
}
void inspectRegistrationSnapshot;
