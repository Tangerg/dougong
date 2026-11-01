import fileSystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { installCommandFixture } from "../release-command-fixture.mjs";

const workspace = process.cwd();
const failure = process.env.DOUGONG_RELEASE_FAILURE;
const target = join(
  workspace,
  "packages",
  failure === "restore" ? "reactive" : "dougong",
  "package.json",
);
const read = fileSystem.readFileSync;
const write = fileSystem.writeFileSync;
let writes = 0;

fileSystem.readFileSync = (path, ...fileOptions) => {
  if (failure === "read" && path === target && !fileOptions.length) {
    throw new Error("fixture manifest read failure");
  }
  return read(path, ...fileOptions);
};
fileSystem.writeFileSync = (path, contents, ...fileOptions) => {
  if (
    basename(path) === "package.json" &&
    dirname(dirname(path)) === dirname(target) &&
    basename(dirname(path)).startsWith(".release-manifest-")
  ) {
    writes++;
    if (failure === "write" && writes === 1) {
      write(path, "partial write", ...fileOptions);
      throw new Error("fixture manifest write failure");
    }
    if (failure === "restore" && writes === 2) {
      throw new Error("fixture manifest restoration failure");
    }
  }
  return write(path, contents, ...fileOptions);
};
syncBuiltinESMExports();

installCommandFixture((name, commandArguments) => {
  if (name === "git") {
    if (commandArguments[0] === "rev-parse") {
      return {
        status: 0,
        stdout: commandArguments.includes("--abbrev-ref") ? "main" : "a".repeat(40),
      };
    }
    if (commandArguments[0] === "rev-list") return { status: 0, stdout: "0" };
    if (
      ["status", "fetch", "ls-remote"].includes(commandArguments[0]) ||
      (commandArguments[0] === "tag" && commandArguments[1] === "--list")
    ) {
      return { status: 0 };
    }
    process.exit(99);
  }

  if (name === "npm" && commandArguments[0] === "view") {
    return { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) };
  }

  if (name === "pnpm") {
    if (commandArguments.length !== 1 || commandArguments[0] !== "check") process.exit(99);
    fileSystem.writeFileSync(join(workspace, "release-stage"), join(workspace, "test-pack"));
    return { status: 1 };
  }
  process.exit(99);
});
