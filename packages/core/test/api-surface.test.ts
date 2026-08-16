import { describe, expect, expectTypeOf, it } from "vitest";
import * as core from "../src/index";

describe("public API surface", () => {
  it("requires Contract values to come through the typed factory boundary", () => {
    type PlainService = { readonly id: "plain"; readonly kind: "service" };
    type IsService = PlainService extends core.Service<unknown> ? true : false;
    type PlainOptional = {
      readonly kind: "optional";
      readonly service: core.Service<unknown>;
    };
    type IsOptional = PlainOptional extends core.OptionalService<unknown> ? true : false;

    expectTypeOf<IsService>().toEqualTypeOf<false>();
    expectTypeOf<IsOptional>().toEqualTypeOf<false>();
    expectTypeOf<core.Group["status"]>().toEqualTypeOf<core.LifecycleStatus>();
    expectTypeOf<core.Installation["status"]>().toEqualTypeOf<core.LifecycleStatus>();

    const CONFIG = core.service<string>("surface/config");
    const configured = core.definePlugin({
      name: "surface.configured",
      requires: { config: CONFIG },
      setup(ctx) {
        void ctx.config;
      },
    });
    const plugins: readonly core.AnyPlugin[] = [configured];
    expectTypeOf(plugins[0]).toEqualTypeOf<core.AnyPlugin | undefined>();
    type AnyPluginIsAuthoringInput = core.AnyPlugin extends Parameters<typeof core.definePlugin>[0]
      ? true
      : false;
    expectTypeOf<AnyPluginIsAuthoringInput>().toEqualTypeOf<false>();
    expectTypeOf<core.Host>().toMatchTypeOf<core.Installer>();
    expectTypeOf<core.Group>().toMatchTypeOf<core.Installer>();
    expectTypeOf<ReturnType<core.ChangeSet["update"]>>().toEqualTypeOf<void>();
    expectTypeOf<ReturnType<core.ChangeSet["remove"]>>().toEqualTypeOf<void>();
    type OptionalGet = <T>(token: core.OptionalService<T>) => T | undefined;
    expectTypeOf<core.Host["get"]>().toMatchTypeOf<OptionalGet>();

    type NarrowLogger = {
      debug(message: string): void;
      info(message: string): void;
      warn(message: string): void;
      error(message: string): void;
    };
    type AcceptsUnknownMessages = NarrowLogger extends core.Logger ? true : false;
    expectTypeOf<AcceptsUnknownMessages>().toEqualTypeOf<false>();
  });

  it("keeps the Core value-export budget explicit", () => {
    expect(Object.keys(core).sort()).toEqual([
      "ConfigValidationError",
      "DougongError",
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
