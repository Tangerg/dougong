import { z } from "zod";
import { expectTypeOf } from "vitest";
import { createHost, definePlugin, type InitialInstallation } from "dougong";
import {
  createPlatform,
  defineManifest,
  MemoryLoader,
  type Artifact,
  type Authorizer,
  type ManifestInput,
  type Platform,
  type Registration,
} from "@dougongjs/platform";

const invalidPolicy: Authorizer = {
  // @ts-expect-error Denials must throw or reject so a false result cannot open admission.
  authorize: () => false,
};
void invalidPolicy;

const plugin = definePlugin({ name: "types", setup() {} });
const platform = createPlatform({
  id: "types",
  host: createHost(),
  apiVersion: "1.0.0",
  loader: new MemoryLoader(new Map([["module", { default: plugin }]])),
});

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

const registration: Promise<Registration<string>> = platform.select(artifact);
void registration;

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
  const selected = await owned.select(
    owned.catalog.add({
      revision: "r1",
      manifest: { name: "scope", version: "1.0.0" },
      reference: "module",
    }),
  );
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
