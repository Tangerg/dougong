import { expect, it, vi } from "vitest";
import { createHost, RecordedFailure } from "@dougongjs/core";
import { createPlatform, MemoryLoader, defineManifest, PermissionDeniedError } from "../src";
import { PlatformDiagnostics } from "../src/diagnostics";

it("settles every pending Registration when disposal overtakes queued admission", async () => {
  const platform = createPlatform({
    installer: createHost(),
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map()),
  });
  const change = platform.change();
  const registration = change.register({
    manifest: defineManifest({ name: "boundary.queued", version: "1.0.0", apiVersion: "^1.0.0" }),
    reference: "queued",
  });
  const ready = registration.ready().then(
    () => "ready",
    () => "rejected",
  );
  const commit = change.commit().catch((error: unknown) => error);
  const disposed = platform.dispose();
  expect(await commit).toBeInstanceOf(Error);
  await disposed;
  expect(registration.status).toBe("failed");
  expect(await ready).toBe("rejected");
  await expect(registration.ready()).rejects.toBeInstanceOf(RecordedFailure);
});

it("retains permission diagnostics on discarded registrations without impersonating the original error", async () => {
  const platform = createPlatform({
    installer: createHost(),
    apiVersion: "1.0.0",
    loader: new MemoryLoader(new Map()),
  });
  const change = platform.change();
  const registration = change.register({
    manifest: defineManifest({
      name: "boundary.denied",
      version: "1.0.0",
      permissions: ["filesystem"],
    }),
    reference: "unused",
  });
  await expect(change.commit()).rejects.toBeInstanceOf(PermissionDeniedError);
  const failure = await registration.ready().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RecordedFailure);
  expect(failure).not.toBeInstanceOf(PermissionDeniedError);
  expect(failure).toMatchObject({
    code: "PERMISSION_DENIED",
    snapshot: {
      name: "PermissionDeniedError",
      manifestName: "boundary.denied",
      denied: ["filesystem"],
    },
  });
  await platform.dispose();
});

it("builds Platform diagnostics lazily and preserves the final disposed snapshot", () => {
  let status: "active" | "disposed" = "active";
  const read = vi.fn<() => { status: "active" | "disposed"; registrations: [] }>(() => ({
    status,
    registrations: [],
  }));
  const diagnostics = new PlatformDiagnostics("1.0.0", read, () => undefined);
  read.mockClear();
  diagnostics.publish();
  diagnostics.publish();
  expect(read).not.toHaveBeenCalled();
  expect(diagnostics.view.get().revision).toBe(2);
  expect(read).toHaveBeenCalledOnce();
  status = "disposed";
  diagnostics.publish();
  diagnostics.dispose();
  expect(diagnostics.view.get().status).toBe("disposed");
  expect(read).toHaveBeenCalledTimes(2);
});
