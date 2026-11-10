import { expect, it, vi } from "vitest";
import { createResourceAuthority, createHost, definePlugin, service } from "../src/index";

const resourceAuthority = createResourceAuthority();

it("groups installation ownership without creating another capability namespace", async () => {
  const serviceA = service<number>("group/a"),
    serviceB = service<number>("group/b");
  const host = createHost({ resourceAuthority });
  const change = host.change();
  const parent = change.group("parent"),
    child = change.group("child", parent),
    other = change.group("other");
  change.install(
    definePlugin({ name: "provider", provides: { serviceA }, setup: () => ({ serviceA: 1 }) }),
    { id: "provider", group: parent },
  );
  change.install(
    definePlugin({
      name: "consumer",
      requires: { serviceA },
      provides: { serviceB },
      setup: ({ dependencies }) => ({ serviceB: dependencies.serviceA + 1 }),
    }),
    { id: "consumer", group: other },
  );
  change.install(definePlugin({ name: "nested", setup() {} }), { id: "nested", group: child });
  await host.apply(await host.plan(change));
  await host.start();
  expect((await host.use(serviceB, (result) => result)).value).toBe(2);
  const invalid = host.change();
  invalid.removeGroup(parent);
  await expect(host.plan(invalid)).rejects.toMatchObject({ code: "SERVICE_MISSING" });
  expect(host.group("parent")).toBe(parent);
  const remove = host.change();
  remove.removeGroup(parent);
  remove.removeGroup(other);
  await host.apply(await host.plan(remove));
  expect(host.diagnostics.get().groups).toEqual([]);
  expect(host.diagnostics.get().installations).toEqual([]);
  expect(host.group("child")).toBeUndefined();
  await host.stop();
});

it("removes descendants in one plan and preserves unrelated Instances", async () => {
  const stopped = vi.fn<() => void>(),
    otherStarted = vi.fn<() => void>();
  const host = createHost({
    resourceAuthority,
    groups: [{ id: "root" }, { id: "child", parentId: "root" }],
    installations: [
      {
        id: "child",
        groupId: "child",
        plugin: definePlugin({
          name: "child",
          setup({ lifetime }) {
            lifetime.defer(stopped);
          },
        }),
      },
      { id: "other", plugin: definePlugin({ name: "other", setup: otherStarted }) },
    ],
  });
  await host.start();
  const change = host.change();
  change.removeGroup(host.group("root")!);
  const plan = await host.plan(change);
  expect(plan.report.affectedInstallations).toEqual(["child"]);
  await host.apply(plan);
  expect(stopped).toHaveBeenCalledOnce();
  expect(otherStarted).toHaveBeenCalledOnce();
  expect(host.diagnostics.get().groups).toEqual([]);
  await host.stop();
});

it("plans overlapping Group removals once for each affected Installation", async () => {
  const plugin = definePlugin({ name: "group.member", setup() {} });
  const ids = ["outer", "inner", "sibling", "keep"];
  const host = createHost({
    resourceAuthority,
    groups: [
      { id: "outer" },
      { id: "inner", parentId: "outer" },
      { id: "sibling" },
      { id: "keep" },
    ],
    installations: ids.map((id) => ({ id, groupId: id, plugin })),
  });
  const change = host.change();
  for (const id of ["sibling", "inner", "outer"]) change.removeGroup(host.group(id)!);
  const plan = await host.plan(change);
  expect(plan.report.affectedInstallations).toEqual(["outer", "inner", "sibling"]);
  await host.apply(plan);
  expect(host.diagnostics.get().groups.map((group) => group.id)).toEqual(["keep"]);
  expect(host.diagnostics.get().installations.map((installation) => installation.id)).toEqual([
    "keep",
  ]);
});

it("rejects duplicate, missing and cyclic Group ownership", async () => {
  expect(() => createHost({ resourceAuthority, groups: [{ id: "x" }, { id: "x" }] })).toThrowError(
    expect.objectContaining({ code: "GROUP_CONFLICT" }),
  );
  expect(() =>
    createHost({ resourceAuthority, groups: [{ id: "x", parentId: "y" }] }),
  ).toThrowError(expect.objectContaining({ code: "GROUP_MISSING" }));
  expect(() =>
    createHost({
      resourceAuthority,
      groups: [
        { id: "x", parentId: "y" },
        { id: "y", parentId: "x" },
      ],
    }),
  ).toThrowError(expect.objectContaining({ code: "GROUP_CYCLE" }));
  const host = createHost({ resourceAuthority, groups: [{ id: "x" }] });
  const duplicate = host.change();
  duplicate.group("x");
  await expect(host.plan(duplicate)).rejects.toMatchObject({ code: "GROUP_CONFLICT" });
  const other = createHost({ resourceAuthority, groups: [{ id: "foreign" }] });
  expect(() => host.change().group("child", other.group("foreign"))).toThrowError(
    expect.objectContaining({ code: "GROUP_FOREIGN" }),
  );
});

it("rejects late plans targeting removed Group identity", async () => {
  const host = createHost({ resourceAuthority, groups: [{ id: "x" }] });
  const group = host.group("x")!;
  const pending = host.change();
  pending.install(definePlugin({ name: "a", setup() {} }), { id: "a", group });
  const remove = host.change();
  remove.removeGroup(group);
  await host.apply(await host.plan(remove));
  await expect(host.plan(pending)).rejects.toMatchObject({ code: "GROUP_MISSING" });
  const repeated = host.change();
  repeated.removeGroup(group);
  await expect(host.plan(repeated)).rejects.toMatchObject({ code: "GROUP_REMOVED" });
});

it("rejects conflicting edits inside a removed subtree", async () => {
  const host = createHost({
    resourceAuthority,
    groups: [{ id: "x" }],
    installations: [{ id: "a", groupId: "x", plugin: definePlugin({ name: "a", setup() {} }) }],
  });
  const change = host.change();
  change.removeGroup(host.group("x")!);
  change.update(host.installation("a")!, { configuration: undefined });
  await expect(host.plan(change)).rejects.toMatchObject({ code: "CHANGE_CONFLICT" });
  expect(host.installation("a")).toBeDefined();
});

it("constructs a deep child-first group declaration without depending on the JavaScript call stack", async () => {
  const depth = 10_000;
  const groups = Array.from({ length: depth }, (_, index) => ({
    id: String(depth - 1 - index),
    ...(index === depth - 1 ? {} : { parentId: String(depth - 2 - index) }),
  }));
  const host = createHost({ resourceAuthority, groups });
  expect(host.group(String(depth - 1))?.parentId).toBe(String(depth - 2));
  const change = host.change();
  change.removeGroup(host.group("0")!);
  await host.apply(await host.plan(change));
  expect(host.group(String(depth - 1))).toBeUndefined();
});
