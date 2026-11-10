import type { StandardSchemaV1 } from "@standard-schema/spec";
import { expect, it, vi } from "vitest";
import {
  createHost,
  createResourceAuthority,
  definePlugin,
  service,
  type Plugin,
} from "../src/index.js";
import { capturePluginDeclaration } from "../src/advanced.js";

it("publishes the actual schema output through the declared Service", async () => {
  const count = service<number>("authoring/parsed-count");
  const validate = vi.fn<(input: unknown) => { value: number }>((input) => ({
    value: Number(input),
  }));
  const schema: StandardSchemaV1<string, number> = {
    "~standard": { version: 1, vendor: "authoring", validate },
  };
  const plugin = definePlugin({
    name: "parsed-count",
    configuration: schema,
    provides: { count },
    setup: (_context, configuration) => ({ count: configuration + 1 }),
  });
  const host = createHost({
    resourceAuthority: createResourceAuthority(),
    installations: [{ id: "parsed", plugin, configuration: "42" }],
  });
  try {
    await host.start();
    expect((await host.use(count, (value) => value)).value).toBe(43);
    expect(validate).toHaveBeenCalledExactlyOnceWith("42");
  } finally {
    await host.stop();
  }
});

it("captures an unknown module declaration through the same validation owner", () => {
  const setup = vi.fn<() => void>();
  const input: unknown = { name: "loaded", setup };
  const captured = capturePluginDeclaration(input);
  expect(captured).toMatchObject({ name: "loaded", setup, requires: {}, provides: {} });
  expect(Object.isFrozen(captured)).toBe(true);
  expect(capturePluginDeclaration(captured)).toBe(captured);
  expect(setup).not.toHaveBeenCalled();
  expect(() => capturePluginDeclaration({ name: "invalid", setup: 1 })).toThrow(TypeError);
});

it.each(["defined", "annotated", "captured"] as const)(
  "runs a %s declaration through the same installation capture",
  async (ingress) => {
    const count = service<number>("authoring/checked-count");
    const declaration = {
      name: "checked-count",
      provides: { count },
      setup(_context: unknown, configuration: number) {
        return { count: configuration + 1 };
      },
    };
    const annotated: Plugin<number, {}, { count: typeof count }> = declaration;
    const plugin =
      ingress === "defined"
        ? definePlugin(declaration)
        : ingress === "annotated"
          ? annotated
          : capturePluginDeclaration(declaration);
    const host = createHost({
      resourceAuthority: createResourceAuthority(),
      installations: [{ id: "checked", plugin, configuration: 42 }],
    });
    try {
      await host.start();
      expect((await host.use(count, (value) => value)).value).toBe(43);
    } finally {
      await host.stop();
    }
  },
);
