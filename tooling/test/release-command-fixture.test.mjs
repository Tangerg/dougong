import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { executeRelease } from "./release-fixture.mjs";

const fixture = fileURLToPath(new URL("./release-command-fixture.mjs", import.meta.url));

async function evaluate(source) {
  const result = await executeRelease(["--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    env: process.env,
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

it.each([
  { label: "buffer output", source: 'process.stdout.write("out"); process.stderr.write("err")' },
  {
    label: "encoded output and nonzero exit",
    source: 'process.stdout.write("out"); process.stderr.write("err"); process.exit(7)',
    options: { encoding: "utf8" },
  },
  { label: "signal termination", source: 'process.kill(process.pid, "SIGTERM")' },
  { label: "launch failure", missing: true, source: "" },
  { label: "ignored output", source: 'process.stdout.write("out")', options: { stdio: "ignore" } },
])("preserves native command results for $label", async ({ source, options = {}, missing }) => {
  const result = await evaluate(`
    import childProcess from "node:child_process";
    import { installCommandFixture } from ${JSON.stringify(fixture)};
    const command = ${missing ? 'process.execPath + "-missing"' : "process.execPath"};
    const args = ["-e", ${JSON.stringify(source)}];
    const options = ${JSON.stringify(options)};
    const native = childProcess.spawnSync(command, args, options);
    installCommandFixture(() => native);
    const simulated = childProcess.spawnSync(command, args, options);
    const inspect = (result) => ({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.code,
    });
    let execution;
    try {
      execution = { stdout: childProcess.execFileSync(command, args, options) };
    } catch (error) {
      execution = { status: error.status, signal: error.signal, error: error.code };
    }
    console.log(JSON.stringify({ native: inspect(native), simulated: inspect(simulated), execution }));
  `);
  expect(result.simulated).toEqual(result.native);
  const expectedExecution = result.native.error
    ? { error: result.native.error }
    : result.native.status !== 0
      ? { status: result.native.status, signal: result.native.signal }
      : { stdout: result.native.stdout };
  expect(result.execution).toEqual(expectedExecution);
});

it("refuses to simulate a command in a missing working directory", async () => {
  const result = await evaluate(`
    import childProcess from "node:child_process";
    import { installCommandFixture } from ${JSON.stringify(fixture)};
    let dispatched = false;
    installCommandFixture(() => { dispatched = true; return { status: 0 }; });
    let error;
    try {
      childProcess.spawnSync("fixture", [], { cwd: process.execPath + "/missing" });
    } catch (failure) { error = failure.code; }
    console.log(JSON.stringify({ dispatched, error }));
  `);
  expect(result.dispatched).toBe(false);
  expect(["ENOENT", "ENOTDIR"]).toContain(result.error);
});

it.each([undefined, {}, { status: null }, { signal: "SIGTERM" }, { status: 0, signal: "SIGTERM" }])(
  "refuses to invent a successful exit for an incomplete command result %j",
  async (response) => {
    const result = await evaluate(`
      import childProcess from "node:child_process";
      import { installCommandFixture } from ${JSON.stringify(fixture)};
      installCommandFixture(() => (${JSON.stringify(response)}));
      let rejected = false;
      try { childProcess.spawnSync("fixture", []); }
      catch { rejected = true; }
      console.log(JSON.stringify({ rejected }));
    `);
    expect(result.rejected).toBe(true);
  },
);
