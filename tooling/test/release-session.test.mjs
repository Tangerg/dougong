import { expect, it } from "vitest";
import { executeRelease, releaseTestTimeout } from "./release-fixture.mjs";

const sessionModule = new URL("../release/release-session.mjs", import.meta.url).href;
const commandTimeoutMilliseconds = 2_000;
const descendantReady = "descendant ready\n";
const descendantLateOutput = "descendant completed beyond the deadline\n";

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
