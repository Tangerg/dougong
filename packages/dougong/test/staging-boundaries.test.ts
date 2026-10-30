import { expect, it, vi } from "vitest";
import {
  createHost,
  definePlugin,
  event,
  extensionPoint,
  service,
  type Plan,
  type PluginContext,
} from "../src";

it.each(["install", "update"])(
  "refuses %s staging when input normalization has already consumed the draft",
  async (operation) => {
    const original = definePlugin({ name: "staging.declaration", setup() {} });
    const host = createHost({ installations: [{ id: "owner", plugin: original }] });
    const installation = host.installation("owner")!;
    await host.start();
    const change = host.change();
    let planning: Promise<Plan> | undefined;
    const declaration = new Proxy(
      { name: original.name, setup() {} },
      {
        getPrototypeOf(target) {
          planning ??= host.plan(change);
          return Reflect.getPrototypeOf(target);
        },
      },
    );
    expect(() => {
      if (operation === "install") change.install(declaration, { id: "late", config: undefined });
      else change.update(installation, { plugin: declaration });
    }).toThrow("planned");
    const plan = await planning!;
    expect(plan.report.operations).toEqual([]);
    await host.apply(plan);
    expect(host.inspect().installations).toHaveLength(1);
    expect(installation.status).toBe("running");
    await expect(host.plan(change)).rejects.toMatchObject({ code: "CHANGE_FOREIGN" });
    await host.stop();
  },
);

it.each(["listener", "contribution", "emission"])(
  "refuses %s after Contract reflection closes its owning Lifetime",
  async (operation) => {
    const notice = event<void>("staging/notice");
    const items = extensionPoint<number>("staging/items");
    const notified = vi.fn<() => void>();
    let context!: PluginContext<{}>;
    let observer!: PluginContext<{}>;
    const host = createHost({
      installations: [
        {
          id: "owner",
          plugin: definePlugin({
            name: "staging.resources",
            setup(ctx) {
              context = ctx;
              ctx.events.on(notice, notified);
              ctx.lifetime.child("closing");
            },
          }),
        },
        {
          id: "observer",
          plugin: definePlugin({
            name: "staging.observer",
            setup(ctx) {
              observer = ctx;
              ctx.events.on(notice, notified);
            },
          }),
        },
      ],
    });
    await host.start();
    const contributions = host.contributions(items);
    let closing: PromiseLike<void> | undefined;
    const reflect = <T extends object>(token: T): T =>
      new Proxy(token, {
        getOwnPropertyDescriptor(target, key) {
          closing ??= context.lifetime[Symbol.asyncDispose]();
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    let failure: unknown;
    try {
      if (operation === "emission") await context.events.emit(reflect(notice));
      else if (operation === "listener") context.events.on(reflect(notice), notified);
      else context.contributions.add(reflect(items), "late", 1);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "LIFETIME_DISPOSED" });
    await closing;
    expect(contributions.get().size).toBe(0);
    expect(notified).not.toHaveBeenCalled();
    await observer.events.emit(notice);
    expect(notified).toHaveBeenCalledOnce();
    await host.stop();
  },
);

it("rejects a candidate closed by provided-service reflection before committing its generation", async () => {
  const value = service<number>("staging/reflected-service");
  let closing: Promise<void> | undefined;
  const host = createHost({
    installations: [
      {
        id: "provider",
        plugin: definePlugin({
          name: "staging.reflected-provider",
          provides: { value },
          setup(ctx) {
            return new Proxy(
              { value: 1 },
              {
                getPrototypeOf(target) {
                  closing ??= ctx.lifetime[Symbol.asyncDispose]();
                  return Reflect.getPrototypeOf(target);
                },
              },
            );
          },
        }),
      },
    ],
  });
  await expect(host.start()).rejects.toMatchObject({
    code: "TRANSITION_FAILED",
    details: { outcome: "restored", phase: "prepare" },
  });
  await closing;
  expect(host.status).toBe("stopped");
  expect(host.inspect().unresolved).toEqual([]);
  expect(host.installation("provider")?.status).toBe("stopped");
  await expect(host.use(value, (current) => current)).rejects.toMatchObject({
    code: "SERVICE_UNAVAILABLE",
  });
});
