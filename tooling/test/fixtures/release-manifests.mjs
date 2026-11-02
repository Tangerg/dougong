import fileSystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { cleanReleaseGit, installReleaseFixture } from "../release-command-fixture.mjs";

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
const remove = fileSystem.rmSync;
let writes = 0;
let injected = false;

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
    if (failure === "unclaimed" && writes === 1) write(target, contents);
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
fileSystem.rmSync = (path, options) => {
  remove(path, options);
  if (
    failure === "post-rename" &&
    !injected &&
    dirname(path) === dirname(target) &&
    basename(path).startsWith(".release-manifest-")
  ) {
    injected = true;
    throw new Error("fixture post-rename cleanup failure");
  }
};
syncBuiltinESMExports();

installReleaseFixture((name, commandArguments, options) => {
  if (name === "git") {
    if (failure === "preflight-source" && !injected) {
      injected = true;
      const manifest = JSON.parse(read(target, "utf8"));
      manifest.publishConfig = { registry: "https://new.example.test/" };
      write(target, JSON.stringify(manifest, null, 2) + "\n");
    }
    return cleanReleaseGit(commandArguments, options);
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
