import { createHost, definePlugin } from "dougong";
import {
  createPlatform,
  MemoryLoader,
  type Artifact,
  type Platform,
  type Registration,
} from "@dougongjs/platform";

const plugin = definePlugin({ name: "types", setup() {} });
const platform = createPlatform({
  id: "types",
  host: createHost(),
  apiVersion: "1.0.0",
  loader: new MemoryLoader(new Map([["module", { default: plugin }]])),
});

const artifact: Artifact<string> = platform.catalog.add({
  revision: "release-1",
  manifest: { name: plugin.name, version: "1.0.0" },
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
