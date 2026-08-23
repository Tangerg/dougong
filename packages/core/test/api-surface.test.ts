import { describe, expect, it } from "vitest";
import * as core from "../src/index";

describe("public API surface", () => {
  it("keeps the Core value-export budget explicit", () => {
    expect(Object.keys(core).sort()).toEqual([
      "ConfigValidationError",
      "DougongError",
      "ErrorSummary",
      "ReadonlyMapSnapshot",
      "SerialQueue",
      "SnapshotPublisher",
      "assertPlainRecord",
      "asyncDisposeSymbol",
      "createHost",
      "definePlugin",
      "disposeSymbol",
      "event",
      "extensionPoint",
      "isCancellationReason",
      "isLogger",
      "optional",
      "service",
    ]);
  });

  it("summarizes terminal errors without retaining their object graph", () => {
    const retained = { payload: "application state" };
    const original = new core.DougongError("TEST_FAILURE", "failed", { cause: retained });
    original.name = "SpecializedError";

    const summary = new core.ErrorSummary(original);
    const restored = summary.restore((code, message) => new core.DougongError(code, message));

    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.keys(summary)).toEqual([]);
    expect(restored).toMatchObject({
      name: "SpecializedError",
      message: "failed",
      code: "TEST_FAILURE",
    });
    expect(restored).not.toBe(original);
    expect(restored).not.toHaveProperty("cause");
    expect(new core.ErrorSummary(new TypeError("invalid")).restore()).toBeInstanceOf(TypeError);
    expect(() => new core.ErrorSummary(null as never)).toThrowError(
      new TypeError("ErrorSummary expects an Error"),
    );
    expect(() => summary.restore(() => null as never)).toThrowError(
      new TypeError("ErrorSummary coded error factory must return an Error"),
    );

    const hostile = Object.defineProperties(new Error(), {
      name: { get: () => 1 },
      message: {
        get() {
          throw new Error("must not escape");
        },
      },
    });
    const recovered = new core.ErrorSummary(hostile).restore();
    expect(recovered).toMatchObject({ name: "Error", message: "" });
  });

  it("validates structured error identity at the JavaScript boundary", () => {
    expect(() => new core.DougongError("" as never, "failed")).toThrowError(
      new TypeError("DougongError code must be a non-empty trimmed string"),
    );
    expect(() => new core.DougongError(" TEST " as never, "failed")).toThrowError(
      new TypeError("DougongError code must be a non-empty trimmed string"),
    );
    expect(() => new core.DougongError("TEST", null as never)).toThrowError(
      new TypeError("DougongError message must be a string"),
    );
  });

  it("does not leak orchestrator internals through public objects", async () => {
    const ITEMS = core.extensionPoint<string>("surface/items");
    const NOTICE = core.event<void>("surface/notice");
    let surfaces!: {
      readonly context: object;
      readonly view: object;
      readonly listener: object;
      readonly contribution: object;
      readonly cleanup: object;
      readonly child: object;
      readonly task: object;
    };
    const plugin = core.definePlugin({
      name: "surface.plugin",
      requires: { items: ITEMS },
      setup(ctx) {
        surfaces = {
          context: ctx,
          view: ctx.items,
          listener: ctx.on(NOTICE, () => undefined),
          contribution: ctx.contribute(ITEMS, "item", "value"),
          cleanup: ctx.cleanup(() => undefined),
          child: ctx.lifetime("surface-child"),
          task: ctx.spawn(() => undefined),
        };
      },
    });

    const host = core.createHost();
    const change = host.change();
    const installation = host.install(plugin);
    const group = host.group("empty", () => {});
    await host.start();

    expect(Object.keys(surfaces.context).sort()).toEqual([
      "cleanup",
      "contribute",
      "emit",
      "items",
      "lifetime",
      "log",
      "meta",
      "on",
      "signal",
      "spawn",
    ]);
    expect(Object.keys(surfaces.view).sort()).toEqual(["get", "subscribe"]);
    expect(Object.keys(surfaces.listener)).toEqual([]);
    expect(Object.keys(surfaces.contribution)).toEqual([]);
    expect(Object.keys(surfaces.cleanup)).toEqual([]);
    expect(Object.keys(surfaces.child)).toEqual([]);
    expect(Object.keys(surfaces.task)).toEqual(["result"]);
    expect(Object.keys(installation)).toEqual([]);
    expect(Object.keys(group)).toEqual([]);
    expect(Object.keys(host.diagnostics).sort()).toEqual(["get", "subscribe"]);
    expect(Object.isFrozen(host)).toBe(true);
    expect("cancel" in change).toBe(false);
    expect("attach" in installation).toBe(false);
    expect("revoke" in installation).toBe(false);
    expect("revoke" in group).toBe(false);
    expect("finishConfiguration" in group).toBe(false);
    for (const internal of [
      "installInGroup",
      "changeInGroup",
      "createChildGroup",
      "readyGroup",
      "groupStatus",
      "removeGroup",
    ]) {
      expect(internal in host).toBe(false);
    }

    for (const resource of [
      surfaces.listener,
      surfaces.contribution,
      surfaces.cleanup,
      surfaces.child,
      surfaces.task,
      installation,
      group,
    ]) {
      expect(Object.isFrozen(resource)).toBe(true);
    }

    await host.stop();
  });
});
