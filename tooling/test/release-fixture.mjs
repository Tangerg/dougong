import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const releaseCommandTimeout = 10000;

// Recovery runs two bounded CLIs plus real Git and archive operations.
export const releaseTestTimeout = 30000;

export async function executeRelease(args, { cwd, env }) {
  const execution = executeFile(process.execPath, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: releaseCommandTimeout,
  });
  const result = await execution.then(
    ({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
    (error) => {
      if (typeof error.code !== "number") throw error;
      return { status: error.code, stdout: error.stdout, stderr: error.stderr };
    },
  );
  // A signal handler can exit normally after the timeout has killed the command.
  if (execution.child.killed) {
    throw new Error(`Release command timed out after ${releaseCommandTimeout} ms`);
  }
  return result;
}
