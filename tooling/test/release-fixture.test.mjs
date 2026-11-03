import { expect, it } from "vitest";
import { executeRelease, releaseTestTimeout } from "./release-fixture.mjs";

it.each([false, true])(
  "retains timeout diagnostics when a termination handler exits successfully: %s",
  async (handlesTermination) => {
    const failure = await executeRelease(
      [
        "-e",
        `${handlesTermination ? 'process.on("SIGTERM", () => process.exit(0));' : ""}
         process.stdout.write("ready\\n");
         process.stderr.write("still running\\n");
         setInterval(() => {}, 1000);`,
      ],
      { stage: "resume", cwd: process.cwd(), env: process.env },
    ).catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("timed out after 10000 ms");
    expect(failure.message).toContain('"stage": "resume"');
    expect(failure.message).toContain('"stdout": "ready\\n"');
    expect(failure.message).toContain('"stderr": "still running\\n"');
    expect(failure).toMatchObject({
      stage: "resume",
      code: handlesTermination ? 0 : null,
      status: handlesTermination ? 0 : null,
      signal: handlesTermination ? null : "SIGTERM",
      killed: true,
      timeoutMilliseconds: 10_000,
      stdout: "ready\n",
      stderr: "still running\n",
    });
  },
  releaseTestTimeout,
);

it("distinguishes unexpected signal termination from a fixture timeout", async () => {
  const failure = await executeRelease(
    ["-e", 'process.stderr.write("interrupted\\n"); process.kill(process.pid, "SIGTERM")'],
    { stage: "initial attempt", cwd: process.cwd(), env: process.env },
  ).catch((error) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).not.toContain("timed out");
  expect(failure).toMatchObject({
    stage: "initial attempt",
    code: null,
    status: null,
    signal: "SIGTERM",
    killed: false,
    stdout: "",
    stderr: "interrupted\n",
    cause: { code: null, signal: "SIGTERM" },
  });
});

it("retains startup failures before a child process can execute", async () => {
  await expect(
    executeRelease(["-e", ""], {
      stage: "spawn",
      cwd: process.execPath + "/missing",
      env: process.env,
    }),
  ).rejects.toMatchObject({
    stage: "spawn",
    code: expect.stringMatching(/^(ENOENT|ENOTDIR)$/u),
    signal: null,
    killed: false,
    stdout: "",
    stderr: "",
    cause: expect.any(Error),
  });
});
