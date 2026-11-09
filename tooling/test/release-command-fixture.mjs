import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";

// Dry-run and preflight fixtures observe the same clean branch, destination and absent tag.
export function cleanReleaseGit(commandArguments, { gitConfigurationArguments = [] } = {}) {
  const [command] = commandArguments;
  const head = "a".repeat(40);
  if (command === "--version") return { status: 0, stdout: "git version 2.48.0" };
  if (command === "rev-parse")
    return { status: 0, stdout: commandArguments.includes("--abbrev-ref") ? "main" : head };
  if (command === "rev-list") return { status: 0, stdout: "0" };
  if (commandArguments.join(" ") === "remote get-url --push --all origin")
    return { status: 0, stdout: "fixture-remote" };
  if (command === "remote" && commandArguments.length === 1) return { status: 0, stdout: "origin" };
  if (command === "ls-remote") {
    const local = commandArguments[1] === "--get-url";
    const remote = commandArguments[local ? 2 : 3];
    const expected = [
      "-c",
      `remote.${remote}.url=fixture-remote`,
      "-c",
      `remote.${remote}.pushurl=fixture-remote`,
    ];
    if (gitConfigurationArguments.join("\n") !== expected.join("\n"))
      throw new Error("Release Git fixture requires the same pinned read and push destination");
    return { status: 0, stdout: local ? "fixture-remote" : head + "\trefs/heads/main" };
  }
  if (
    ["status", "fetch"].includes(command) ||
    (command === "tag" && commandArguments[1] === "--list")
  )
    return { status: 0 };
  throw new Error("Unexpected Git fixture command: " + command);
}

export function installReleaseFixture(handle) {
  const configured = JSON.parse(process.env.DOUGONG_RELEASE_REGISTRIES ?? "{}");
  installCommandFixture((name, args, options, spawnSync, spawn) => {
    if (name === "git") {
      let command = 0;
      while (args[command] === "-c") command += 2;
      return handle(
        name,
        args.slice(command),
        { ...options, gitConfigurationArguments: args.slice(0, command) },
        spawnSync,
        spawn,
      );
    }
    if (name !== "npm") return handle(name, args, options, spawnSync, spawn);
    if (args[0] === "config" && args[1] === "get" && args.length === 3) {
      const defaults = { registry: "https://registry.npmjs.org/", scope: "" };
      return { status: 0, stdout: configured[args[2]] ?? defaults[args[2]] ?? "undefined" };
    }
    const command = args.findIndex((arg) => !arg.startsWith("--"));
    return handle(
      name,
      args.slice(command),
      { ...options, registryArguments: args.slice(0, command) },
      spawnSync,
      spawn,
    );
  });
}

// Keep one isolated release process; simulated commands must not boot another runtime per call.
export function installCommandFixture(handle) {
  const nativeSpawnSync = childProcess.spawnSync;
  const nativeSpawn = childProcess.spawn;
  const dispatch = (command, commandArguments, options, execute) => {
    const workingDirectory = options.cwd ?? process.cwd();
    if (!statSync(workingDirectory).isDirectory())
      throw new TypeError(`Working directory path is not a directory: ${workingDirectory}`);
    return handle(
      command,
      commandArguments,
      { ...options, cwd: workingDirectory },
      nativeSpawnSync,
      execute,
    );
  };
  const resultOf = (command, response, options) => {
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
      const disposition = Array.isArray(options.stdio)
        ? options.stdio[process[channel].fd]
        : options.stdio;
      if (disposition === "inherit") process[channel].write(bytes);
      result[channel] =
        disposition === "inherit" || disposition === "ignore"
          ? null
          : options.encoding
            ? bytes.toString(options.encoding)
            : bytes;
    }
    return result;
  };
  childProcess.spawnSync = (command, commandArguments, options = {}) =>
    resultOf(command, dispatch(command, commandArguments, options, nativeSpawnSync), options);
  childProcess.spawn = (command, commandArguments, options = {}) => {
    const response = dispatch(command, commandArguments, options, nativeSpawn);
    if (response instanceof childProcess.ChildProcess) return response;
    const result = resultOf(command, response, options);
    const child = new EventEmitter();
    child.stdout = result.stdout === null ? null : new PassThrough();
    child.stderr = result.stderr === null ? null : new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    setImmediate(() => {
      if (result.error) child.emit("error", result.error);
      child.stdout?.end(result.stdout);
      child.stderr?.end(result.stderr);
      const launchFailed = result.error && result.signal === null;
      const status = launchFailed ? (result.error.errno ?? result.status) : result.status;
      child.exitCode = status;
      child.signalCode = result.signal;
      if (!launchFailed) child.emit("exit", status, result.signal);
      setImmediate(() => child.emit("close", status, result.signal));
    });
    return child;
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
