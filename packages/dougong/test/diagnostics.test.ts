import { expect, it } from "vitest";
import {
  createResourceAuthority,
  createHost,
  definePlugin,
  type HostSnapshot,
  type LifetimeContext,
} from "../src/index";

const resourceAuthority = createResourceAuthority();

it("publishes one starting snapshot before an empty Host commits", async () => {
  const host = createHost({ resourceAuthority });
  const snapshots: HostSnapshot[] = [];
  using subscription = host.diagnostics.subscribe(() => {
    snapshots.push(host.diagnostics.get());
  });

  await host.start();

  expect(snapshots.map(({ status }) => status)).toEqual(["starting", "running"]);
  expect(host.diagnostics.get()).toBe(snapshots[1]);
  subscription[Symbol.dispose]();
  await host.stop();
});

it("retains the startup snapshot from validation through unpublished preparation", async () => {
  let host!: ReturnType<typeof createHost>;
  let validating: HostSnapshot | undefined;
  let preparing: HostSnapshot | undefined;
  const plugin = definePlugin({
    name: "diagnostics.startup",
    configuration: {
      "~standard": {
        version: 1,
        vendor: "test",
        async validate() {
          validating = host.diagnostics.get();
          await expect(host.stop()).rejects.toMatchObject({ code: "HOST_BUSY" });
          return { value: undefined };
        },
      },
    },
    setup() {
      preparing = host.diagnostics.get();
    },
  });
  host = createHost({ resourceAuthority, installations: [{ id: "startup", plugin }] });
  const snapshots: HostSnapshot[] = [];
  using subscription = host.diagnostics.subscribe(() => {
    snapshots.push(host.diagnostics.get());
  });

  await host.start();

  expect(validating?.status).toBe("starting");
  expect(preparing).toBe(validating);
  expect(snapshots.filter(({ status }) => status === "starting")).toEqual([validating]);
  expect(host.diagnostics.get().status).toBe("running");
  subscription[Symbol.dispose]();
  await host.stop();
});

it("caches immutable projections while resource changes do not advance stateRevision", async () => {
  let scope!: LifetimeContext;
  const host = createHost({
    resourceAuthority,
    installations: [
      {
        id: "a",
        plugin: definePlugin({
          name: "a",
          setup({ lifetime }) {
            scope = lifetime;
          },
        }),
      },
    ],
  });
  expect(host.diagnostics.get()).toBe(host.diagnostics.get());
  await host.start();
  const before = host.diagnostics.get(),
    revision = host.stateRevision;
  const cleanup = scope.defer(() => undefined);
  const after = host.diagnostics.get();
  expect(after).not.toBe(before);
  expect(after.stateRevision).toBe(revision);
  expect(Object.isFrozen(after.installations)).toBe(true);
  expect(host.diagnostics.get()).toBe(after);
  await cleanup[Symbol.asyncDispose]();
  expect(host.diagnostics.get()).not.toBe(after);
  await host.stop();
  expect(host.diagnostics.get().installations[0]?.lifetime).toBeUndefined();
});
