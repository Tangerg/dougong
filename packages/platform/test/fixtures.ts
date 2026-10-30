import { createHost, definePlugin, service, type AnyPlugin } from "dougong";
import {
  createPlatform,
  MemoryLoader,
  type ArtifactInput,
  type ManifestInput,
  type Platform,
} from "../src";

export const VALUE = service<{ value: number }>("platform-test/value");

export function valuePlugin(name: string, value: number) {
  return definePlugin({ name, provides: { value: VALUE }, setup: () => ({ value: { value } }) });
}

export function emptyPlugin(name: string) {
  return definePlugin({ name, setup() {} });
}

export function fixture(modules: ReadonlyMap<string, AnyPlugin> = new Map()) {
  const host = createHost();
  const platform = createPlatform({
    id: "test",
    host,
    apiVersion: "1.0.0",
    loader: new MemoryLoader(
      new Map([...modules].map(([reference, plugin]) => [reference, { default: plugin }])),
    ),
  });
  return { host, platform };
}

export function add<Reference>(
  platform: Platform<Reference>,
  name: string,
  reference: Reference,
  version = "1.0.0",
  options: Partial<ArtifactInput<Reference>> = {},
) {
  return platform.catalog.add({
    revision: version,
    manifest: { name, version },
    reference,
    ...options,
  });
}

export async function select<Reference>(
  platform: Platform<Reference>,
  name: string,
  reference: Reference,
  manifest: Partial<ManifestInput> = {},
) {
  return platform.select(
    add(platform, name, reference, manifest.version ?? "1.0.0", {
      manifest: { name, version: "1.0.0", ...manifest },
    }),
  );
}

export function deferred<T = void>() {
  return Promise.withResolvers<T>();
}

export function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
