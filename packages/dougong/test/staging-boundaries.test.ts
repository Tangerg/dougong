import { expect, it, vi } from "vitest";
import {
  createHost,
  definePlugin,
  event,
  extensionPoint,
  service,
  type Plan,
  type ChildLifetime,
} from "../src";
import { EventHub } from "../src/events/event-hub";
import { Lifetime } from "../src/lifetime/lifetime";
import { ContributionRegistry } from "../src/contributions/contribution-store";

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
    expect(host.diagnostics.get().installations).toHaveLength(1);
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
    const owner = new Lifetime({ label: "owner", report() {} });
    const observer = new Lifetime({ label: "observer", report() {} });
    const hub = new EventHub();
    const registry = new ContributionRegistry(() => undefined);
    const events = hub.scope(owner, () => undefined);
    const otherEvents = hub.scope(observer, () => undefined);
    const contributions = registry.scope(owner, "owner", () => undefined);
    const view = registry.view(items);
    events.on(notice, notified);
    otherEvents.on(notice, notified);
    owner.publish();
    observer.publish();
    let closing: PromiseLike<void> | undefined;
    const reflect = <T extends object>(token: T): T =>
      new Proxy(token, {
        getOwnPropertyDescriptor(target, key) {
          closing ??= owner.dispose();
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    let failure: unknown;
    try {
      if (operation === "emission") await events.emit(reflect(notice));
      else if (operation === "listener") events.on(reflect(notice), notified);
      else contributions.add(reflect(items), "late", 1);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "LIFETIME_DISPOSED" });
    await closing;
    expect(view.get().size).toBe(0);
    expect(notified).not.toHaveBeenCalled();
    await otherEvents.emit(notice);
    expect(notified).toHaveBeenCalledOnce();
    await observer.dispose();
  },
);

it("keeps Instance lifetime termination in the Engine while a plugin can retire its child", async () => {
  const value = service<number>("staging/owned-service");
  const release = vi.fn<() => void>();
  let child!: ChildLifetime;
  const host = createHost({
    installations: [
      {
        id: "provider",
        plugin: definePlugin({
          name: "provider",
          provides: { value },
          setup({ lifetime }) {
            expect(Symbol.asyncDispose in lifetime).toBe(false);
            lifetime.defer(release);
            child = lifetime.child("request");
            return { value: 1 };
          },
        }),
      },
    ],
  });
  await host.start();
  await child[Symbol.asyncDispose]();
  expect(release).not.toHaveBeenCalled();
  expect(await host.use(value, (current) => current)).toBe(1);
  await host.stop();
  expect(release).toHaveBeenCalledOnce();
});
