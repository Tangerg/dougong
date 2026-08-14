import { describe, expect, it } from "vitest";
import * as core from "../src/index";

describe("public API surface", () => {
  it("keeps the Core runtime budget explicit", () => {
    expect(Object.keys(core).sort()).toEqual([
      "ConfigValidationError",
      "DougongError",
      "createApp",
      "definePlugin",
      "event",
      "extension",
      "optional",
      "service",
    ]);
  });

  it("does not leak orchestrator internals through JavaScript handles", async () => {
    const ITEMS = core.extension<string>("surface/items");
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
          child: ctx.lifetime(),
          task: ctx.spawn(() => undefined),
        };
      },
    });

    const app = core.createApp();
    const change = app.change();
    const handle = app.install(plugin);
    const group = app.group("empty", () => {});
    await app.start();

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
    expect(Object.keys(handle)).toEqual([]);
    expect(Object.keys(group)).toEqual([]);
    expect(Object.keys(app.diagnostics).sort()).toEqual(["get", "subscribe"]);
    expect(Object.isFrozen(app)).toBe(true);
    expect("cancel" in change).toBe(false);
    expect("attach" in handle).toBe(false);
    expect("revoke" in handle).toBe(false);
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
      expect(internal in app).toBe(false);
    }

    for (const resource of [
      surfaces.listener,
      surfaces.contribution,
      surfaces.cleanup,
      surfaces.child,
      surfaces.task,
      handle,
      group,
    ]) {
      expect(Object.isFrozen(resource)).toBe(true);
    }

    await app.stop();
  });
});
