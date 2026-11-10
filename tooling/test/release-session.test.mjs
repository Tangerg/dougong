import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { executeRelease, releaseTestTimeout } from "./release-fixture.mjs";

const sessionModule = new URL("../release/release-session.mjs", import.meta.url).href;
const commandTimeoutMilliseconds = 2_000;
const descendantReady = "descendant ready\n";
const descendantLateOutput = "descendant completed beyond the deadline\n";

it("preserves terminal descriptors for interactive publication authentication", () => {
  const ready = "interactive release command ready";
  const command = `
    const assert = require("node:assert/strict");
    assert.equal(process.stdin.isTTY, true);
    assert.equal(process.stdout.isTTY, true);
    assert.equal(process.stderr.isTTY, true);
    console.log(${JSON.stringify(ready)});
  `;
  const source = `
    import assert from "node:assert/strict";
    import { ReleaseSession } from ${JSON.stringify(sessionModule)};
    const session = new ReleaseSession();
    try {
      const result = await session.execute(process.execPath, ["--eval", ${JSON.stringify(command)}], {
        stdio: "inherit",
        interactive: true,
      });
      assert.equal(result.status, 0);
    } finally {
      await session.close();
    }
  `;
  const nodeArguments = [process.execPath, "--input-type=module", "--eval", source];
  const commandLine = nodeArguments
    .map((argument) => "'" + argument.replaceAll("'", "'\\''") + "'")
    .join(" ");
  const result = spawnSync(
    "script",
    process.platform === "darwin"
      ? ["-q", "/dev/null", ...nodeArguments]
      : ["-q", "-e", "-c", commandLine, "/dev/null"],
    { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({
    status: 0,
    signal: null,
    stdout: expect.stringContaining(ready),
    stderr: "",
  });
});

it.each(["running", "exited"])(
  "terminates the command group at its deadline with a %s leader",
  async (leaderState) => {
    const descendant = `
      process.send("ready");
      process.disconnect();
      setTimeout(() => process.stdout.write(${JSON.stringify(descendantLateOutput)}), ${2 * commandTimeoutMilliseconds});
    `;
    const leader = `
      const { spawn } = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      descendant.once("message", () => process.stdout.write(${JSON.stringify(descendantReady)}, () => {
        if (${leaderState === "exited"}) process.exit(0);
      }));
    `;
    const execution = await executeRelease(
      [
        "--input-type=module",
        "--eval",
        `
          import { ReleaseSession } from ${JSON.stringify(sessionModule)};
          const session = new ReleaseSession();
          try {
            const result = await session.execute(process.execPath, ["-e", ${JSON.stringify(leader)}], {
              encoding: "utf8",
              timeout: ${commandTimeoutMilliseconds},
              killSignal: "SIGKILL",
            });
            console.log(JSON.stringify({ ...result, errorCode: result.error?.code }));
          } finally {
            await session.close();
          }
        `,
      ],
      { cwd: process.cwd(), env: process.env },
    );
    expect(execution.status).toBe(0);
    const result = JSON.parse(execution.stdout);
    expect(result.stdout).toContain(descendantReady);
    expect(result.stdout).not.toContain(descendantLateOutput);
    expect(result.errorCode).toBe("ETIMEDOUT");
    expect(result.status).toBe(leaderState === "exited" ? 0 : null);
    expect(result.signal).toBe(leaderState === "exited" ? null : "SIGKILL");
  },
  releaseTestTimeout,
);

it(
  "preserves an OS cancellation signal while joining a command with an active deadline",
  async () => {
    const descendantStopped = "descendant joined after cancellation\n";
    const descendant = `
      process.on("SIGTERM", () => process.stdout.write(${JSON.stringify(descendantStopped)}, () => process.exit(0)));
      process.send("ready");
      setTimeout(() => process.stdout.write(${JSON.stringify(descendantLateOutput)}), ${2 * commandTimeoutMilliseconds});
    `;
    const leader = `
      const { spawn } = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      descendant.once("message", () => process.stdout.write(${JSON.stringify(descendantReady)}, () => {
        process.kill(Number(process.argv[1]), "SIGTERM");
      }));
    `;
    const execution = executeRelease(
      [
        "--input-type=module",
        "--eval",
        `
          import { ReleaseSession } from ${JSON.stringify(sessionModule)};
          const session = new ReleaseSession();
          try {
            await session.execute(process.execPath, ["-e", ${JSON.stringify(leader)}, String(process.pid)], {
              stdio: "inherit",
              timeout: ${commandTimeoutMilliseconds},
              killSignal: "SIGKILL",
            });
          } catch (error) {
            if (error !== session.signal.reason) throw error;
          } finally {
            await session.close();
          }
        `,
      ],
      { cwd: process.cwd(), env: process.env },
    );
    await expect(execution).rejects.toMatchObject({
      status: null,
      signal: "SIGTERM",
      killed: false,
      stdout: descendantReady + descendantStopped,
    });
  },
  releaseTestTimeout,
);

it.each(
  [false, true].flatMap((interactive) =>
    ["repeated", "grace"].flatMap((interruption) =>
      ["running", "exited"].map((leaderState) => ({ interactive, interruption, leaderState })),
    ),
  ),
)(
  "joins an uncooperative command group after $interruption cancellation with a $leaderState leader (interactive: $interactive)",
  async ({ interactive, interruption, leaderState }) => {
    const interrupted = "descendant received the first interruption\n";
    const repeatedStillWaiting = "repeated interruption did not force termination\n";
    const escapedCancellation = "descendant outlived cancellation\n";
    const commandJoined = "release command joined\n";
    const descendant = `
      const parent = Number(process.argv[1]);
      process.on("SIGINT", () => process.stdout.write(${JSON.stringify(interrupted)}, () => {
        if (${interruption === "repeated"}) {
          process.kill(parent, "SIGTERM");
          setTimeout(() => process.stdout.write(${JSON.stringify(repeatedStillWaiting)}), 1_000);
        }
      }));
      process.on("SIGTERM", () => {});
      process.send("ready", () => process.disconnect());
      setTimeout(() => process.stdout.write(${JSON.stringify(escapedCancellation)}, () => process.exit(0)), 6_000);
    `;
    const leader = `
      const { spawn } = require("node:child_process");
      const parent = Number(process.argv[1]);
      process.on("SIGINT", () => {
        if (${leaderState === "exited"}) process.exit(0);
      });
      process.on("SIGTERM", () => {});
      const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, String(parent)], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      descendant.once("message", () => process.stdout.write(${JSON.stringify(descendantReady)}, () => {
        process.kill(parent, "SIGINT");
      }));
    `;
    const execution = executeRelease(
      [
        "--input-type=module",
        "--eval",
        `
          import { ReleaseSession } from ${JSON.stringify(sessionModule)};
          const session = new ReleaseSession();
          try {
            await session.run(process.execPath, ["-e", ${JSON.stringify(leader)}, String(process.pid)], {
              interactive: ${interactive},
            });
          } catch (error) {
            if (error !== session.signal.reason) console.error(error);
            else process.stdout.write(${JSON.stringify(commandJoined)});
          } finally {
            await session.close();
          }
        `,
      ],
      { cwd: process.cwd(), env: process.env },
    );
    await expect(execution).rejects.toMatchObject({
      status: null,
      signal: "SIGINT",
      killed: false,
      stdout: descendantReady + interrupted + commandJoined,
      stderr: "",
    });
  },
  releaseTestTimeout,
);

it(
  "confirms group exit after a temporary probe permission failure",
  async () => {
    const joined = "release command joined\n";
    const command = `
      process.once("SIGINT", () => process.exit(0));
      process.kill(Number(process.argv[1]), "SIGINT");
      setTimeout(() => process.exit(0), 6_000);
    `;
    const execution = executeRelease(
      [
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          import { ReleaseSession } from ${JSON.stringify(sessionModule)};
          const session = new ReleaseSession();
          const kill = process.kill;
          let probes = 0;
          process.kill = (pid, signal) => {
            if (signal === 0 && pid < 0) {
              const code = ++probes === 1 ? "EPERM" : "ESRCH";
              throw Object.assign(new Error(code), { code });
            }
            return kill(pid, signal);
          };
          try {
            await session.run(process.execPath, ["-e", ${JSON.stringify(command)}, String(process.pid)], {
              interactive: true,
            });
            assert.fail("Cancelled command resolved");
          } catch (error) {
            assert.equal(error, session.signal.reason);
            assert.equal(probes, 2);
            process.stdout.write(${JSON.stringify(joined)});
          } finally {
            await session.close();
          }
        `,
      ],
      { cwd: process.cwd(), env: process.env },
    );
    await expect(execution).rejects.toMatchObject({
      status: null,
      signal: "SIGINT",
      killed: false,
      stdout: joined,
      stderr: "",
    });
  },
  releaseTestTimeout,
);

it.each(["present", "permission denied"])(
  "retains release files when process-group termination cannot be confirmed (%s)",
  async (probe) => {
    const workspace = mkdtempSync(join(tmpdir(), "dougong-release-session-test-"));
    const stageRecord = join(workspace, "stage.json");
    const directory = join(workspace, "package");
    const original = JSON.stringify({ name: "release-fixture", version: "1.0.0" });
    const versioned = JSON.stringify({ name: "release-fixture", version: "2.0.0" });
    mkdirSync(directory);
    writeFileSync(join(directory, "package.json"), original);
    try {
      const command = `
        process.once("SIGINT", () => process.exit(0));
        process.kill(Number(process.argv[1]), "SIGINT");
        setTimeout(() => process.exit(0), 6_000);
      `;
      const execution = executeRelease(
        [
          "--input-type=module",
          "--eval",
          `
            import assert from "node:assert/strict";
            import { writeFileSync } from "node:fs";
            import { ReleaseSession } from ${JSON.stringify(sessionModule)};
            const session = new ReleaseSession();
            const stage = session.createStage();
            writeFileSync(${JSON.stringify(stageRecord)}, JSON.stringify(stage));
            session.replaceManifests([{
              directory: "package",
              name: "release-fixture",
              original: Buffer.from(${JSON.stringify(original)}),
              versioned: Buffer.from(${JSON.stringify(versioned)}),
            }], { branch: "main", head: "unpublished" });
            const kill = process.kill;
            process.kill = (pid, signal) => {
              if (signal === 0 && pid < 0) {
                if (${probe === "permission denied"}) throw Object.assign(new Error("probe denied"), { code: "EPERM" });
                return true;
              }
              return kill(pid, signal);
            };
            try {
              await session.run(process.execPath, ["-e", ${JSON.stringify(command)}, String(process.pid)], {
                interactive: true,
              });
              assert.fail("Cancelled command resolved");
            } catch (error) {
              assert(error instanceof AggregateError);
              assert.equal(error.errors[0], session.signal.reason);
              assert.match(error.errors[1].message, /could not be confirmed stopped/);
              await assert.rejects(session.restoreManifests(), /before the release command is confirmed stopped/);
            } finally {
              await session.close();
            }
          `,
        ],
        { cwd: workspace, env: process.env },
      );
      await expect(execution).rejects.toMatchObject({
        status: null,
        signal: "SIGINT",
        killed: false,
        stderr: expect.stringContaining("Release cleanup withheld"),
      });
      const stage = JSON.parse(readFileSync(stageRecord, "utf8"));
      expect(existsSync(stage)).toBe(true);
      expect(readFileSync(join(directory, "package.json"), "utf8")).toBe(versioned);
    } finally {
      if (existsSync(stageRecord))
        rmSync(JSON.parse(readFileSync(stageRecord, "utf8")), { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  },
  releaseTestTimeout,
);
