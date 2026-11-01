import { describe, expect, it, vi } from "vitest";
import { createHost, definePlugin, event, extensionPoint, optional, service } from "../src/index";

const value = service<number>("plugin/value");
const items = extensionPoint<number>("plugin/items");
const setup = () => undefined;

describe("Plugin declaration contracts", () => {
  it.each([
    { name: "", setup },
    { name: " padded ", setup },
    { name: 1, setup },
    { name: "missing-setup" },
    { name: "schema", setup, configuration: null },
    { name: "schema", setup, configuration: {} },
    { name: "schema", setup, configuration: { "~standard": null } },
    {
      name: "schema",
      setup,
      configuration: { "~standard": { version: 2, vendor: "test", validate: setup } },
    },
    {
      name: "schema",
      setup,
      configuration: { "~standard": { version: 1, vendor: 1, validate: setup } },
    },
    { name: "schema", setup, configuration: { "~standard": { version: 1, vendor: "test" } } },
    { name: "alias", setup, requires: { "": value } },
    { name: "alias", setup, requires: { " padded ": value } },
    { name: "alias", setup, provides: { "": value } },
    { name: "alias", setup, provides: { " padded ": value } },
    // Deliberately invalid authoring input must reject the Promise-protocol alias.
    // oxlint-disable-next-line unicorn/no-thenable
    { name: "then", setup, provides: { then: value } },
    { name: "contract", setup, requires: { value: null } },
    { name: "event", setup, requires: { notice: event<void>("plugin/notice") } },
    { name: "extension", setup, provides: { items } },
  ])("rejects malformed authoring declaration %j", (declaration) => {
    expect(() => definePlugin(declaration as never)).toThrow(TypeError);
  });

  it("rejects duplicate capability names and cross-role ambiguity at declaration time", () => {
    expect(() =>
      definePlugin({ name: "duplicate", requires: { one: value, two: optional(value) }, setup }),
    ).toThrow(/reference the same Service/);
    expect(() =>
      definePlugin({ name: "duplicate", requires: { one: items, two: items }, setup }),
    ).toThrow(/reference the same ExtensionPoint/);
    expect(() =>
      definePlugin({
        name: "duplicate",
        provides: { one: value, two: value },
        setup: () => ({ one: 1, two: 2 }),
      }),
    ).toThrow(/reference the same Service/);
    expect(() =>
      definePlugin({
        name: "conflict",
        requires: { input: value },
        provides: { output: value },
        setup: () => ({ output: 1 }),
      }),
    ).toThrow(/cannot both require and provide/);
    expect(() =>
      definePlugin({
        name: "kind",
        requires: { service: value, contributions: extensionPoint("plugin/value") },
        setup,
      }),
    ).toThrow(/both Service and ExtensionPoint/);
  });

  it("reuses a captured configuration protocol when composing Plugin declarations", async () => {
    const validate = vi.fn<(input: unknown) => { value: unknown }>((input) => ({ value: input }));
    const original = definePlugin<unknown>({
      name: "base",
      configuration: { "~standard": { version: 1, vendor: "test", validate } },
      setup,
    });
    let composed = original;
    for (let index = 0; index < 10_000; index++) {
      composed = definePlugin({ ...composed, name: "composed" });
    }
    const host = createHost({
      installations: [{ id: "composed", plugin: composed, configuration: 1 }],
    });
    await host.start();
    expect(validate).toHaveBeenCalledExactlyOnceWith(1);
    await host.stop();
  });

  it("captures a Standard Schema protocol once while preserving its receiver", async () => {
    const validate = vi.fn<(input: unknown) => { value: unknown }>(function (
      this: { marker: string },
      input,
    ) {
      expect(this.marker).toBe("schema receiver");
      return { value: input };
    });
    const standard = { version: 1 as const, vendor: "test", marker: "schema receiver", validate };
    const read = vi.fn<() => typeof standard>(() => standard);
    const schema = Object.defineProperty({}, "~standard", { get: read });
    const received: unknown[] = [];
    const plugin = definePlugin<unknown>({
      name: "captured-schema",
      configuration: schema as never,
      setup(_context, configuration) {
        received.push(configuration);
      },
    });
    expect(read).toHaveBeenCalledOnce();
    standard.validate = vi.fn<() => never>(() => {
      throw new Error("replaced");
    }) as typeof validate;
    const host = createHost({
      installations: [{ id: "configuration", plugin, configuration: { value: 1 } }],
    });
    await host.start();
    expect(read).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledOnce();
    expect(received).toEqual([{ value: 1 }]);
    await host.stop();
  });
});
