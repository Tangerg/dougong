import { expect, it } from "vitest";
import { createHost, definePlugin, optional, service, type OptionalService } from "../src";

function descriptorOnly<T extends object>(value: T): T {
  return new Proxy(value, {
    get() {
      throw new Error("Declaration fields must come from their data descriptors");
    },
  });
}

it("captures Host option data without rereading the input", () => {
  const host = createHost(descriptorOnly({ name: "capture.host" }));
  expect(host.name).toBe("capture.host");
  expect(host.diagnostics.get().name).toBe("capture.host");
});

it.each(["plugin", "requires", "provides", "optional"] as const)(
  "uses captured %s declaration data throughout activation",
  async (boundary) => {
    const input = service<number>("capture/input");
    const output = service<number>("capture/output");
    const requirement = { ...optional(input) } as OptionalService<number>;
    const declaration = {
      name: "capture.consumer",
      requires: { input: boundary === "optional" ? descriptorOnly(requirement) : requirement },
      provides: { output },
      setup({ input }: { readonly input: number | undefined }) {
        return { output: input ?? 0 };
      },
    };
    if (boundary === "requires") declaration.requires = descriptorOnly(declaration.requires);
    if (boundary === "provides") declaration.provides = descriptorOnly(declaration.provides);
    const plugin = definePlugin(boundary === "plugin" ? descriptorOnly(declaration) : declaration);
    const host = createHost();
    host.install(
      definePlugin({ name: "capture.provider", provides: { input }, setup: () => ({ input: 7 }) }),
    );
    host.install(plugin);

    await host.start();
    expect(host.get(output)).toBe(7);
    await host.stop();
  },
);

it("captures Installation updates before staging their config", async () => {
  const value = service<number>("capture/config");
  const host = createHost();
  const installation = host.install(
    definePlugin({
      name: "capture.config",
      provides: { value },
      setup: (_ctx, config: number) => ({ value: config }),
    }),
    1,
  );
  await host.start();

  await installation.update(descriptorOnly({ config: 9 }));
  expect(host.get(value)).toBe(9);
  await host.stop();
});

it("looks up the Service captured from an optional wrapper", async () => {
  const selected = service<number>("capture/selected");
  const other = service<number>("capture/other");
  const host = createHost();
  host.install(
    definePlugin({
      name: "capture.selection",
      provides: { selected, other },
      setup: () => ({ selected: 7, other: 99 }),
    }),
  );
  await host.start();
  const requirement = new Proxy(
    { ...optional(selected) },
    {
      get(target, key, receiver) {
        return key === "service" ? other : Reflect.get(target, key, receiver);
      },
    },
  ) as OptionalService<number>;

  expect(host.get(requirement)).toBe(7);
  await host.stop();
});

it("captures an optional Service identity only once", async () => {
  const token = service<number>("capture/once");
  const host = createHost();
  host.install(
    definePlugin({ name: "capture.once", provides: { token }, setup: () => ({ token: 7 }) }),
  );
  await host.start();
  const reads = new Map<PropertyKey, number>();
  const selected = new Proxy(token, {
    getOwnPropertyDescriptor(target, key) {
      const count = (reads.get(key) ?? 0) + 1;
      reads.set(key, count);
      if (count > 1) throw new Error("Service identity was reflected twice");
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });

  expect(host.get({ kind: "optional", service: selected } as OptionalService<number>)).toBe(7);
  await host.stop();
});
