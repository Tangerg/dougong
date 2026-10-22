import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { installCommandFixture } from "../release-command-fixture.mjs";

const workspace = process.cwd();
const failure = process.env.DOUGONG_RELEASE_FAILURE;
const target = join(
  workspace,
  "packages",
  failure === "restore" ? "reactive" : "core",
  "package.json",
);
const read = fs.readFileSync;
const write = fs.writeFileSync;
let gateFinished = false;
let writes = 0;

fs.readFileSync = (path, ...args) => {
  if (failure === "read" && path === target && gateFinished) {
    throw new Error("fixture manifest read failure");
  }
  return read(path, ...args);
};
fs.writeFileSync = (path, contents, ...args) => {
  if (path === target && gateFinished) {
    writes++;
    if (failure === "write" && writes === 1) {
      write(path, "partial write", ...args);
      throw new Error("fixture manifest write failure");
    }
    if (failure === "restore" && writes === 2) {
      throw new Error("fixture manifest restoration failure");
    }
  }
  return write(path, contents, ...args);
};
syncBuiltinESMExports();

installCommandFixture((name, args) => {
  if (name === "git") {
    if (args[0] === "rev-parse") {
      return { status: 0, stdout: args.includes("--abbrev-ref") ? "main" : "a".repeat(40) };
    }
    if (args[0] === "rev-list") return { status: 0, stdout: "0" };
    if (["status", "fetch"].includes(args[0]) || (args[0] === "tag" && args[1] === "--list")) {
      return { status: 0 };
    }
    process.exit(99);
  }

  if (name === "npm" && args[0] === "view") {
    return { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) };
  }

  if (name === "pnpm") {
    if (args.length === 1 && args[0] === "check") gateFinished = true;
    else if (args[0] === "pack") {
      fs.writeFileSync(
        join(workspace, "release-stage"),
        args[args.indexOf("--pack-destination") + 1],
      );
      return { status: 1 };
    } else process.exit(99);
    return { status: 0 };
  }
  process.exit(99);
});
