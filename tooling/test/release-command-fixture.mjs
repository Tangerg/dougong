import childProcess from "node:child_process";
import { statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Keep one isolated release process; simulated commands must not boot another runtime per call.
export function installCommandFixture(handle) {
  const nativeSpawn = childProcess.spawnSync;
  childProcess.spawnSync = (command, args, options = {}) => {
    const cwd = options.cwd ?? process.cwd();
    if (!statSync(cwd).isDirectory()) throw new TypeError(`Command cwd is not a directory: ${cwd}`);
    const response = handle(command, args, { ...options, cwd }, nativeSpawn);
    if (
      !response ||
      (response.error || response.signal
        ? response.status !== null
        : !Number.isInteger(response.status))
    ) {
      throw new TypeError(
        `Command fixture must return a consistent explicit exit status: ${command}`,
      );
    }
    const result = {
      signal: null,
      stdout: "",
      stderr: "",
      ...response,
    };
    for (const channel of ["stdout", "stderr"]) {
      const value = result[channel];
      if (value === null || value === undefined) continue;
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (options.stdio === "inherit") process[channel].write(bytes);
      result[channel] =
        options.stdio === "inherit" || options.stdio === "ignore"
          ? null
          : options.encoding
            ? bytes.toString(options.encoding)
            : bytes;
    }
    return result;
  };
  childProcess.execFileSync = (command, args, options = {}) => {
    const result = childProcess.spawnSync(command, args, options);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw Object.assign(new Error(`Command failed: ${command} ${args.join(" ")}`), result);
    }
    return result.stdout;
  };
  syncBuiltinESMExports();
}
