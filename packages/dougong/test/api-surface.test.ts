import budget from "../../../tooling/architecture/public-api.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import * as core from "../src/index";
import { normalizeFailure } from "../src/contracts/errors";

describe("public API surface", () => {
  it("captures structured error context as bounded data without retaining custom resources", () => {
    const path = ["consumer", "provider"];
    const error = new core.DougongError("SERVICE_CYCLE", "cycle", {
      details: {
        outcome: "rejected",
        installation: "consumer",
        contract: "value",
        dependencyPath: path,
        stateRevision: 3,
        expectedRevision: 2,
      },
    });
    path[0] = "changed";
    const recorded = new core.RecordedFailure(error);
    expect(recorded.snapshot.details).toEqual({
      outcome: "rejected",
      installation: "consumer",
      contract: "value",
      dependencyPath: ["consumer", "provider"],
      stateRevision: 3,
      expectedRevision: 2,
    });
    expect(Object.isFrozen(recorded.snapshot.details)).toBe(true);
    const hostile = Object.assign(new Error("context"), {
      details: {
        outcome: "wrong",
        phase: "x".repeat(300),
        stateRevision: -1,
        expectedRevision: NaN,
        contract: {},
        installation: 3,
        retained: new Map(),
        dependencyPath: Array(40).fill("node"),
        affectedInstallations: ["one", {}, 4],
      },
    });
    const snapshot = new core.RecordedFailure(hostile).snapshot;
    expect(snapshot.details).toEqual({
      phase: "x".repeat(256),
      dependencyPath: Array(32).fill("node"),
      affectedInstallations: ["one"],
    });
    expect(snapshot.truncated).toBe(true);
  });
  it("classifies inaccessible rejection values without reflecting a replacement failure", () => {
    const reason = Proxy.revocable({}, {});
    reason.revoke();

    expect(core.isError(new Error("explicit"))).toBe(true);
    expect(core.isError(reason.proxy)).toBe(false);
    expect(core.isError(null)).toBe(false);
    expect(core.isCancellationReason(AbortSignal.abort(), reason.proxy)).toBe(false);
    expect(core.isCancellationReason(AbortSignal.abort(reason.proxy), reason.proxy)).toBe(true);
  });

  it("does not grant normalization authority through an inherited error prototype", () => {
    const normalized = normalizeFailure("original", "FIRST_BOUNDARY", "first boundary");
    const explicit = new Error("explicit failure");
    Object.setPrototypeOf(explicit, Object.getPrototypeOf(normalized));

    expect(normalizeFailure(explicit, "SECOND_BOUNDARY", "second boundary")).toBe(explicit);
    expect(normalizeFailure(normalized, "FIRST_BOUNDARY", "first boundary")).toBe(normalized);
    expect(normalizeFailure(normalized, "SECOND_BOUNDARY", "second boundary")).toMatchObject({
      code: "SECOND_BOUNDARY",
      cause: "original",
    });
  });

  it("does not grant normalization authority through a copied error constructor", () => {
    const normalized = normalizeFailure("original", "FIRST_BOUNDARY", "first boundary");
    const ErrorClass = normalized.constructor as new (
      code: string,
      message: string,
      options: ErrorOptions,
    ) => Error;
    const explicit = new ErrorClass("SECOND_BOUNDARY", "explicit failure", { cause: "explicit" });

    expect(normalizeFailure(explicit, "THIRD_BOUNDARY", "third boundary")).toBe(explicit);
  });

  it("keeps Core's normalization identity and original reason immutable", () => {
    const original = { reason: "original" };
    const normalized = normalizeFailure(original, "FIRST_BOUNDARY", "first boundary");

    expect(Reflect.set(normalized, "cause", { reason: "replacement" })).toBe(false);
    expect(Reflect.set(normalized, "code", "SECOND_BOUNDARY")).toBe(false);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(normalizeFailure(normalized, "FIRST_BOUNDARY", "first boundary")).toBe(normalized);
    expect(normalizeFailure(normalized, "SECOND_BOUNDARY", "second boundary").cause).toBe(original);
  });

  it("keeps the Core value-export budget explicit", () => {
    expect(Object.keys(core).sort()).toEqual([...budget["dougong"].values].sort());
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
    expect(new core.RecordedFailure(null).snapshot).toEqual({ name: "NonError", message: "null" });
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

  it("captures external error identity once when sealing a failure record", () => {
    let reads = 0;
    const failure = new Proxy(new Error("original"), {
      getPrototypeOf() {
        if (reads++ > 0) throw new Error("prototype read twice");
        return Error.prototype;
      },
    });

    expect(new core.RecordedFailure(failure).snapshot.message).toBe("original");
    expect(reads).toBe(1);
  });

  it("records errors that inherit a RecordedFailure prototype without trusting their payload", () => {
    const payload = { name: "ForgedFailure", message: "mutable snapshot", owner: {} };
    const original = new Error("actual failure", { cause: payload.owner });
    Object.setPrototypeOf(original, core.RecordedFailure.prototype);
    Object.defineProperty(original, "snapshot", { value: payload, enumerable: true });
    const recorded = new core.RecordedFailure(original);
    payload.message = "changed later";
    expect(recorded.snapshot).toMatchObject({
      name: "Error",
      message: "actual failure",
      cause: { name: "NonError", message: "Non-Error object omitted" },
    });
    expect(recorded.snapshot).not.toBe(payload);
    expect(recorded.snapshot).not.toHaveProperty("owner");
    expect(Object.isFrozen(recorded.snapshot)).toBe(true);
  });

  it("records an inaccessible cause without replacing the original failure", () => {
    const cause = Proxy.revocable({}, {});
    cause.revoke();
    const failure = new Error("original failure", { cause: cause.proxy });

    expect(new core.RecordedFailure(failure).snapshot).toMatchObject({
      name: "Error",
      message: "original failure",
      cause: { name: "NonError", message: "Non-Error object omitted" },
    });
  });

  it.each(["errors", "issues"])("omits an inaccessible diagnostic array (%s)", (field) => {
    const items = Proxy.revocable([], {});
    items.revoke();
    const failure = Object.assign(new Error("original failure"), { [field]: items.proxy });

    const snapshot = new core.RecordedFailure(failure).snapshot;
    expect(snapshot.message).toBe("original failure");
    expect(snapshot).not.toHaveProperty(field);
  });

  it("captures diagnostic array length once through the external field boundary", () => {
    let reads = 0;
    const failures = new Proxy([new Error("nested failure")], {
      get(target, key, receiver) {
        if (key === "length") {
          if (reads++ > 0) throw new Error("array length read twice");
          return 1;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const failure = Object.assign(new Error("original failure"), { errors: failures });

    expect(new core.RecordedFailure(failure).snapshot.errors?.[0]?.message).toBe("nested failure");
    expect(reads).toBe(1);
  });

  it("omits an inaccessible validation path while retaining its issue message", () => {
    const path = new Proxy(["field"], {
      get() {
        throw new Error("path is inaccessible");
      },
    });
    const failure = Object.assign(new Error("original failure"), {
      issues: [{ message: "expected value", path }],
    });

    expect(new core.RecordedFailure(failure).snapshot.issues).toEqual([
      { message: "expected value" },
    ]);
  });

  it("bounds diagnostic chains and preserves aggregate causes and validation issues", () => {
    const configuration = new core.ConfigurationValidationError([
      { message: "expected integer", path: [{ key: "port" }] },
    ]);
    const aggregate = new AggregateError([configuration, new TypeError("secondary")], "startup", {
      cause: new Error("root"),
    });
    const snapshot = new core.RecordedFailure(aggregate).snapshot;
    expect(snapshot.cause?.message).toBe("root");
    expect(snapshot.errors?.[0]).toMatchObject({
      code: "CONFIGURATION_INVALID",
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
    const configuration = new core.ConfigurationValidationError([
      { message: "index", path: [2, Symbol.for("field"), "field", { key: 3 }] },
      { message: "x".repeat(5000), path: Array.from({ length: 20 }, () => "segment") },
      { message: "without path" },
    ]);
    const snapshot = new core.RecordedFailure(configuration).snapshot;
    expect(snapshot.issues?.[0]?.path).toEqual([2, "Symbol(field)", "field", 3]);
    expect(snapshot.issues?.[1]?.path).toHaveLength(16);
    expect(snapshot.issues?.[1]?.message).toHaveLength(4096);
    expect(snapshot.issues?.[2]).toEqual({ message: "without path" });
    expect(snapshot.truncated).toBe(true);
    let deep = new Error("root");
    for (let depth = 0; depth < 10; depth++) deep = new Error("parent", { cause: deep });
    let recorded = new core.RecordedFailure(deep).snapshot;
    for (let depth = 0; depth < 5; depth++) recorded = recorded.cause!;
    expect(recorded.truncated).toBe(true);
    const empty = Object.defineProperty(new Error("no stack"), "stack", { value: undefined });
    expect(new core.RecordedFailure(empty).snapshot).not.toHaveProperty("stack");
  });

  it("captures only selected domain fields and preserves their bounded projection when nested", () => {
    const tags = ["x".repeat(300), "blue"];
    const error = Object.assign(new Error("invalid delivery"), {
      subject: "revision-1",
      tags,
      privateResource: { secret: "omitted" },
    });
    expect(new core.RecordedFailure(error).snapshot).not.toHaveProperty("fields");
    const recorded = new core.RecordedFailure(error, ["subject", "tags", "privateResource"]);
    tags.pop();
    expect(recorded.snapshot.fields).toEqual({
      subject: "revision-1",
      tags: ["x".repeat(256), "blue"],
    });
    expect(Object.isFrozen(recorded.snapshot.fields?.tags)).toBe(true);
    expect(recorded.snapshot.truncated).toBe(true);
    expect(
      new core.RecordedFailure(new Error("outer", { cause: recorded })).snapshot.cause,
    ).toEqual(recorded.snapshot);
  });

  it("does not execute domain accessors or trust unreadable metadata", () => {
    const failure = Object.defineProperty(new Error("denied"), "extra", {
      get() {
        throw new Error("unexpected getter");
      },
    });
    Object.defineProperty(failure, "code", { value: "TEST" });
    const value = new Proxy(failure, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "blocked") throw new Error("inaccessible");
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(new core.RecordedFailure(value, ["extra", "blocked"]).snapshot).toMatchObject({
      code: "TEST",
    });
    expect(new core.RecordedFailure(value, ["extra", "blocked"]).snapshot).not.toHaveProperty(
      "fields",
    );
    expect(() => new core.RecordedFailure(value, Array(9).fill("key"))).toThrow(TypeError);
  });

  it("marks clipped primitive rejection reasons as truncated", () => {
    expect(new core.RecordedFailure("x".repeat(5000)).snapshot).toMatchObject({
      name: "NonError",
      message: "x".repeat(4096),
      truncated: true,
    });
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

  it("does not replace a failure when its cancellation name cannot be read", () => {
    const failure = Object.defineProperty(new Error("original failure"), "name", {
      get() {
        throw new Error("name accessor failed");
      },
    });
    expect(core.isCancellationReason(AbortSignal.abort(), failure)).toBe(false);
    expect(core.isCancellationReason(AbortSignal.abort(failure), failure)).toBe(true);
  });

  it("owns the exact validation issue fields that it accepted", () => {
    let messageReads = 0;
    let pathReads = 0;
    const payload = { retained: "application state" };
    const issue = Object.defineProperties(
      { message: "unused", path: ["unused"] },
      {
        message: {
          get: () => (messageReads++ === 0 ? "expected value" : payload),
        },
        path: {
          get: () => (pathReads++ === 0 ? ["original"] : ["changed"]),
        },
      },
    );
    const failure = new core.ConfigurationValidationError([issue]);
    expect(failure.issues).toEqual([{ message: "expected value", path: ["original"] }]);
    expect(failure.message).toBe("Invalid Plugin configuration:\n  - expected value");
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
      setup(context) {
        surfaces = {
          context,
          view: context.dependencies.items,
          listener: context.events.on(NOTICE, () => undefined),
          contribution: context.contributions.add(ITEMS, "item", "value"),
          cleanup: context.lifetime.defer(() => undefined),
          child: context.lifetime.child("surface-child"),
          task: context.lifetime.spawn(() => undefined),
        };
      },
    });

    const host = core.createHost();
    const change = host.change();
    const group = change.group("empty");
    const installation = change.install(plugin, { id: "plugin", group });
    await host.apply(await host.plan(change));
    await host.start();

    expect(Object.keys(surfaces.context).sort()).toEqual([
      "contributions",
      "dependencies",
      "events",
      "lifetime",
      "logger",
      "metadata",
    ]);
    expect(Object.keys(surfaces.view).sort()).toEqual(["get", "subscribe", "use"]);
    expect(Object.keys(surfaces.listener)).toEqual([]);
    expect(Object.keys(surfaces.contribution)).toEqual(["update"]);
    expect(Object.keys(surfaces.cleanup)).toEqual([]);
    expect(Object.keys(surfaces.child).sort()).toEqual([
      "acquire",
      "child",
      "defer",
      "interrupt",
      "signal",
      "spawn",
      "use",
    ]);
    expect(Object.keys(surfaces.task)).toEqual(["result"]);
    expect(Object.keys(installation).sort()).toEqual(["groupId", "id", "origin", "status"]);
    expect(Object.keys(group).sort()).toEqual(["id", "parentId"]);
    expect(Object.keys(host.diagnostics).sort()).toEqual(["get", "subscribe"]);
    expect("inspect" in host).toBe(false);
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

it("reads error detail fields once and retains a snapshot independent of caller mutation", () => {
  const path = ["one"];
  let reads = 0;
  const failure = new core.DougongError("TEST", "failure", {
    details: {
      get dependencyPath() {
        return ++reads === 1 ? path : undefined;
      },
    } as { dependencyPath: string[] },
  });
  path.push("two");
  expect(reads).toBe(1);
  expect(failure.details.dependencyPath).toEqual(["one"]);
  expect(Object.isFrozen(failure.details.dependencyPath)).toBe(true);
});

it("preserves the bounded diagnostic tree of a failure nested by another owner", () => {
  const cause = new core.DougongError("PLUGIN_FAILURE", "deferred operation failed", {
    cause: new TypeError("root"),
    details: { phase: "prepare", installation: "worker" },
  });
  const first = new core.RecordedFailure(cause);
  const second = new core.RecordedFailure(new AggregateError([first], "shutdown"));
  expect(second.snapshot.errors).toEqual([first.snapshot]);
  let wrapped = first;
  for (let index = 0; index < 12; index++) {
    wrapped = new core.RecordedFailure(new Error("outer", { cause: wrapped }));
  }
  let child = wrapped.snapshot;
  for (let depth = 0; depth < 5; depth++) child = child.cause!;
  expect(child).toMatchObject({ truncated: true });
  expect(child.cause).toBeUndefined();
});
