import { expect, it } from "vitest";
import { executeRelease, releaseTestTimeout } from "./release-fixture.mjs";

it(
  "rejects a timed-out command even when its termination handler exits successfully",
  async () => {
    await expect(
      executeRelease(
        ["-e", 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)'],
        { cwd: process.cwd(), env: process.env },
      ),
    ).rejects.toThrow("timed out");
  },
  releaseTestTimeout,
);
