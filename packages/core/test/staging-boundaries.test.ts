import { expect, it, vi } from "vitest";
import {
  createHost,
  definePlugin,
  event,
  extensionPoint,
  type LifetimeContext,
  type PluginContext,
} from "../src";

it.each(["install", "update"])(
  "refuses %s staging when input normalization has already committed the draft",
  async (operation) => {
    const host = createHost();
    const original = definePlugin({ name: "staging.declaration", setup() {} });
    const installation = host.install(original);
    await host.start();
    const change = host.change();
    let committed: Promise<void> | undefined;
    const declaration = new Proxy(
      { name: original.name, setup() {} },
      {
        getPrototypeOf(target) {
          committed ??= change.commit();
          return Reflect.getPrototypeOf(target);
        },
      },
    );

    expect(() => {
      if (operation === "install") change.install(declaration);
      else change.update(installation, { plugin: declaration });
    }).toThrow("submitted ChangeSet");
    await committed;
    expect(change.commit()).toBe(committed);
    expect(host.diagnostics.get().installations.size).toBe(1);
    expect(installation.status).toBe("active");
    await host.stop();
  },
);

it.each(["listener", "contribution", "emission"])(
  "refuses %s creation after Contract reflection has disposed the Lifetime",
  async (operation) => {
    const host = createHost();
    const notice = event<void>("staging/notice");
    const items = extensionPoint<number>("staging/items");
    const notified = vi.fn<() => void>();
    let context!: PluginContext<{}>;
    let child!: LifetimeContext;
    const installation = host.install(
      definePlugin({
        name: "staging.resources",
        setup(ctx) {
          context = ctx;
          ctx.on(notice, notified);
          child = ctx.lifetime("closing");
        },
      }),
    );
    await host.start();
    const view = installation.diagnostics.get().lifetime!;
    const contributions = host.contributions(items);
    let closing: Promise<void> | undefined;
    const reflect = <T extends object>(token: T): T =>
      new Proxy(token, {
        getOwnPropertyDescriptor(target, key) {
          closing ??= child.dispose();
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });

    let failure: unknown;
    try {
      if (operation === "emission") await child.emit(reflect(notice));
      else if (operation === "listener") child.on(reflect(notice), notified);
      else child.contribute(reflect(items), "late", 1);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "LIFETIME_DISPOSED" });
    await closing;
    expect(view.get().children).toEqual([]);
    expect(contributions.get().size).toBe(0);
    await context.emit(notice);
    expect(notified).toHaveBeenCalledTimes(1);
    await host.stop();
  },
);
