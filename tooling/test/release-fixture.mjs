import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const releaseCommandTimeoutMilliseconds = 10_000;

// Recovery runs two bounded CLIs plus real Git and archive operations.
export const releaseTestTimeout = 30_000;

export async function executeRelease(
  commandArguments,
  { stage = "single attempt", cwd: workingDirectory, env: environment },
) {
  let execution;
  let output;
  let failure;
  try {
    execution = executeFile(process.execPath, commandArguments, {
      cwd: workingDirectory,
      env: environment,
      encoding: "utf8",
      timeout: releaseCommandTimeoutMilliseconds,
    });
    output = await execution;
  } catch (error) {
    failure = error;
    output = error;
  }
  const { stdout = "", stderr = "" } = output;
  const status = execution?.child?.exitCode ?? null;
  const killed = execution?.child?.killed ?? false;
  // A signal handler can exit normally after the timeout has killed the command.
  if (killed || (failure && typeof failure.code !== "number")) {
    const diagnostics = {
      stage,
      code: failure?.code ?? status,
      status,
      signal: failure?.signal ?? execution?.child?.signalCode ?? null,
      killed,
      timeoutMilliseconds: releaseCommandTimeoutMilliseconds,
      workingDirectory,
      stdout,
      stderr,
    };
    const timedOut =
      killed && (!failure || failure.code === null || typeof failure.code === "number");
    const reason = timedOut
      ? `timed out after ${releaseCommandTimeoutMilliseconds} ms`
      : "could not complete";
    throw Object.assign(
      new Error(`Release command (${stage}) ${reason}\n${JSON.stringify(diagnostics, null, 2)}`, {
        cause: failure,
      }),
      diagnostics,
    );
  }
  return { status, stdout, stderr };
}
