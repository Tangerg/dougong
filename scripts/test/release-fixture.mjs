import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

// Recovery runs two CLIs, each bounded at ten seconds, plus real Git and archives.
export const releaseTestTimeout = 30000;

export async function executeRelease(args, { cwd, env }) {
  try {
    const { stdout, stderr } = await executeFile(process.execPath, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}
