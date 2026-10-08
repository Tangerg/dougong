import { expect, it } from "vitest";
import { createHost, definePlugin, service } from "@dougongjs/core";
import { createPlatform, defineManifest, MemoryLoader } from "../src";

function descriptorOnly<T extends object>(value: T): T {
  return new Proxy(value, {
    get() {
      throw new Error("Declaration fields must come from their data descriptors");
    },
  });
}

it("captures Platform options before constructing its ports", async () => {
  const platform = createPlatform(
    descriptorOnly({
      installer: createHost(),
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map()),
    }),
  );

  expect(platform.apiVersion).toBe("1.0.0");
  expect(platform.status).toBe("active");
  await platform.dispose();
});

it.each(["manifest", "dependencies"] as const)(
  "validates captured %s fields rather than rereading external data",
  (boundary) => {
    const input = {
      name: "capture.manifest",
      version: "1.0.0",
      dependencies: { "capture.dependency": "^1.0.0" },
    };
    if (boundary === "dependencies") input.dependencies = descriptorOnly(input.dependencies);
    const manifest = defineManifest(boundary === "manifest" ? descriptorOnly(input) : input);

    expect(manifest.name).toBe("capture.manifest");
    expect(manifest.dependencies).toEqual({ "capture.dependency": "^1.0.0" });
  },
);

it("loads and activates the Artifact captured at admission", async () => {
  const value = service<number>("capture/artifact");
  const plugin = definePlugin({
    name: "capture.artifact",
    provides: { value },
    setup: () => ({ value: 7 }),
  });
  const host = createHost();
  const platform = createPlatform({
    installer: host,
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map([["selected", { default: plugin }]])),
  });
  const registration = await platform.register(
    descriptorOnly({
      manifest: { name: plugin.name, version: "1.0.0" },
      reference: "selected",
    }),
  );
  await registration.activate();
  await host.start();

  expect(host.get(value)).toBe(7);
  await platform.dispose();
  await host.stop();
});
