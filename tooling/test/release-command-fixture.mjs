import childProcess from "node:child_process";
import { statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Dry-run and preflight fixtures observe the same clean branch, destination and absent tag.
export function cleanReleaseGit(commandArguments, { gitConfigurationArguments = [] } = {}) {
  const [command] = commandArguments;
  const head = "a".repeat(40);
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
  installCommandFixture((name, args, options, spawn) => {
    if (name === "git") {
      let command = 0;
      while (args[command] === "-c") command += 2;
      return handle(
        name,
        args.slice(command),
        { ...options, gitConfigurationArguments: args.slice(0, command) },
        spawn,
      );
    }
    if (name !== "npm") return handle(name, args, options, spawn);
    if (args[0] === "config" && args[1] === "get" && args.length === 3) {
      const defaults = { registry: "https://registry.npmjs.org/", scope: "" };
      return { status: 0, stdout: configured[args[2]] ?? defaults[args[2]] ?? "undefined" };
    }
    const command = args.findIndex((arg) => !arg.startsWith("--"));
    return handle(
      name,
      args.slice(command),
      { ...options, registryArguments: args.slice(0, command) },
      spawn,
    );
  });
}

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
