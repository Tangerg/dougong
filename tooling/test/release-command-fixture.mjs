import childProcess from "node:child_process";
import { statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Keep one isolated release process; simulated commands must not boot another runtime per call.
export function installCommandFixture(handle) {
  const nativeSpawn = childProcess.spawnSync;
  childProcess.spawnSync = (command, commandArguments, options = {}) => {
    const workingDirectory = options.cwd ?? process.cwd();
    if (!statSync(workingDirectory).isDirectory())
      throw new TypeError(`Working directory path is not a directory: ${workingDirectory}`);
    const response = handle(
      command,
      commandArguments,
      { ...options, cwd: workingDirectory },
      nativeSpawn,
    );
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
  childProcess.execFileSync = (command, commandArguments, options = {}) => {
    const result = childProcess.spawnSync(command, commandArguments, options);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const failure = `Command failed: ${command} ${commandArguments.join(" ")}`;
      const message = result.stderr?.length ? `${failure}\n${result.stderr}` : failure;
      throw Object.assign(new Error(message), result);
    }
    return result.stdout;
  };
  syncBuiltinESMExports();
}
