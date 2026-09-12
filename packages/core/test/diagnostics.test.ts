import { expect, it, vi } from "vitest";
import { HostDiagnostics } from "../src/diagnostics";
import { GroupNode } from "../src/group";

it("builds Host diagnostic collections only on read and caches each revision", () => {
  const group = GroupNode.root("diagnostics");
  const read = vi.fn<() => { status: "idle"; installations: []; groups: GroupNode[] }>(() => ({
    status: "idle",
    installations: [],
    groups: [group],
  }));
  const diagnostics = new HostDiagnostics("diagnostics", read, () => undefined);
  const first = diagnostics.view.get();
  read.mockClear();
  for (let i = 0; i < 20; i++) diagnostics.publish();
  expect(read).not.toHaveBeenCalled();
  const current = diagnostics.view.get();
  expect(read).toHaveBeenCalledOnce();
  expect(current.revision).toBe(20);
  expect(first.revision).toBe(0);
  expect(diagnostics.view.get()).toBe(current);
  expect(read).toHaveBeenCalledOnce();
});
