import { expect, it } from "vitest";
import { createHost } from "@dougongjs/core";
import { createPlatform, MemoryLoader } from "../src";

it.each(["register", "update"])(
  "refuses %s staging when Artifact normalization has already committed the draft",
  async (operation) => {
    const platform = createPlatform({
      installer: createHost(),
      apiVersion: "1.0.0",
      loader: new MemoryLoader(new Map()),
    });
    const artifact = {
      manifest: { name: "staging.artifact", version: "1.0.0" },
      reference: "unused",
    };
    const registration = await platform.register(artifact);
    const change = platform.change();
    let committed: Promise<void> | undefined;
    const declaration = new Proxy(artifact, {
      getPrototypeOf(target) {
        committed ??= change.commit();
        return Reflect.getPrototypeOf(target);
      },
    });

    expect(() => {
      if (operation === "register") change.register(declaration);
      else change.update(registration, declaration);
    }).toThrow("submitted ChangeSet");
    await committed;
    expect(change.commit()).toBe(committed);
    expect(platform.diagnostics.get().registrations.size).toBe(1);
    expect(registration.status).toBe("registered");
    await platform.dispose();
  },
);
