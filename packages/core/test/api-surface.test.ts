import { describe, expect, it } from "vitest";
import * as core from "../src/index";

describe("public API surface", () => {
  it("keeps the Core value-export budget explicit", () => {
    expect(Object.keys(core).sort()).toEqual([
      "ConfigValidationError",
      "DougongError",
      "ReadonlyMapSnapshot",
      "RecordedFailure",
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

  it("records terminal diagnostics without claiming the original error class", () => {
    const retained = { payload: "application state" };
    const original = new core.DougongError("TEST_FAILURE", "failed", { cause: retained });
    original.name = "SpecializedError";
    const recorded = new core.RecordedFailure(original);
    expect(Object.isFrozen(recorded)).toBe(true);
    expect(Object.isFrozen(recorded.snapshot)).toBe(true);
    expect(recorded).toMatchObject({
      name: "RecordedFailure",
      message: "failed",
      code: "TEST_FAILURE",
    });
    expect(recorded).not.toBeInstanceOf(core.DougongError);
    expect(recorded.snapshot).toMatchObject({
      name: "SpecializedError",
      message: "failed",
      code: "TEST_FAILURE",
      cause: { name: "NonError", message: "Non-Error object omitted" },
    });
    expect(recorded.snapshot.stack).toBe(original.stack);
    expect(recorded).not.toHaveProperty("cause");
    expect(new core.RecordedFailure(recorded).snapshot).toBe(recorded.snapshot);
    expect(() => new core.RecordedFailure(null as never)).toThrow(
      "RecordedFailure expects an Error",
    );
    const hostile = Object.defineProperties(new Error(), {
      name: { get: () => 1 },
      message: {
        get() {
          throw new Error("must not escape");
        },
      },
    });
    expect(new core.RecordedFailure(hostile).snapshot).toMatchObject({
      name: "Error",
      message: "",
    });
  });

  it("bounds diagnostic chains and preserves aggregate causes and validation issues", () => {
    const config = new core.ConfigValidationError([
      { message: "expected integer", path: [{ key: "port" }] },
    ]);
    const aggregate = new AggregateError([config, new TypeError("secondary")], "startup", {
      cause: new Error("root"),
    });
    const snapshot = new core.RecordedFailure(aggregate).snapshot;
    expect(snapshot.cause?.message).toBe("root");
    expect(snapshot.errors?.[0]).toMatchObject({
      code: "CONFIG_INVALID",
      issues: [{ message: "expected integer", path: ["port"] }],
    });
    expect(snapshot.errors?.[1]?.name).toBe("TypeError");
    const cyclic = new Error("x".repeat(5000));
    cyclic.cause = cyclic;
    const bounded = new core.RecordedFailure(cyclic).snapshot;
    expect(bounded.message.length).toBe(4096);
    expect(bounded.truncated).toBe(true);
    expect(bounded.cause?.truncated).toBe(true);
    expect(
      new core.RecordedFailure(
        new AggregateError(Array.from({ length: 100 }, () => new Error("child"))),
      ).snapshot.errors,
    ).toHaveLength(8);
  });

  it("records primitive causes and bounds validation paths and deep failure trees", () => {
    for (const cause of [null, false, 42, "reason", 1n, Symbol("reason")]) {
      expect(new core.RecordedFailure(new Error("failed", { cause })).snapshot.cause).toEqual({
        name: "NonError",
        message: String(cause),
      });
    }
    const config = new core.ConfigValidationError([
      { message: "index", path: [2, Symbol.for("field"), "field", { key: 3 }] },
      { message: "x".repeat(5000), path: Array.from({ length: 20 }, () => "segment") },
      { message: "without path" },
    ]);
    const snapshot = new core.RecordedFailure(config).snapshot;
    expect(snapshot.issues?.[0]?.path).toEqual([2, "Symbol(field)", "field", 3]);
    expect(snapshot.issues?.[1]?.path).toHaveLength(16);
    expect(snapshot.issues?.[1]?.message).toHaveLength(4096);
    expect(snapshot.issues?.[2]).toEqual({ message: "without path" });
    expect(snapshot.truncated).toBe(true);
    let deep = new Error("root");
    for (let i = 0; i < 10; i++) deep = new Error("parent", { cause: deep });
    let recorded = new core.RecordedFailure(deep).snapshot;
    for (let i = 0; i < 5; i++) recorded = recorded.cause!;
    expect(recorded.truncated).toBe(true);
    const longPermission = Object.assign(new Error("denied"), { denied: ["x".repeat(300)] });
    const permission = new core.RecordedFailure(longPermission).snapshot;
    expect(permission.denied?.[0]).toHaveLength(256);
    expect(permission.truncated).toBe(true);
    const empty = Object.defineProperty(new Error("no stack"), "stack", { value: undefined });
    expect(new core.RecordedFailure(empty).snapshot).not.toHaveProperty("stack");
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
