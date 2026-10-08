import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const release = fileURLToPath(new URL("../release.mjs", import.meta.url));
const packages = ["reactive", "core", "platform", "dougong"];
const version = "0.7.2";

const command = `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
if (name === "git") {
  if (args[0] === "rev-parse") console.log(args.includes("--abbrev-ref") ? "main" : "a".repeat(40));
  else if (args[0] === "rev-list") console.log("0");
  else if (!["status", "fetch", "tag"].includes(args[0])) process.exit(99);
} else if (name === "npm" && args[0] === "view") {
  console.log(JSON.stringify({ error: { code: "E404" } }));
  process.exit(1);
} else if (name === "pnpm") {
  if (args[0] === "check") writeFileSync("gate-finished", "");
  else if (args[0] === "pack") {
    writeFileSync("../../pack-started", "");
    writeFileSync("../../release-stage", args[args.indexOf("--pack-destination") + 1]);
    process.exit(1);
  } else process.exit(99);
} else process.exit(99);
`;

function runRelease(failure) {
  const workspace = mkdtempSync(join(tmpdir(), "dougong-release-manifests-test-"));
  try {
    const bin = join(workspace, "bin");
    mkdirSync(bin);
    for (const name of ["git", "npm", "pnpm"]) {
      writeFileSync(join(bin, name), command, { mode: 0o755 });
    }
    const originals = {};
    for (const name of packages) {
      const packageName = name === "dougong" ? name : `@dougongjs/${name}`;
      const contents =
        `${JSON.stringify({ name: packageName, version: "0.7.1" }, null, 2)}\n`.replace(
          packageName,
          packageName.replace("d", "\\u0064"),
        );
      const directory = join(workspace, "packages", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), contents);
      originals[name] = contents;
    }

    const preload = join(workspace, "failure.mjs");
    writeFileSync(
      preload,
      `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const failure = ${JSON.stringify(failure)};
const target = join(process.cwd(), "packages", failure === "restore" ? "reactive" : "core", "package.json");
const gate = join(process.cwd(), "gate-finished");
const read = fs.readFileSync;
const write = fs.writeFileSync;
let writes = 0;
fs.readFileSync = (path, ...args) => {
  if (failure === "read" && path === target && fs.existsSync(gate)) {
    throw new Error("fixture manifest read failure");
  }
  return read(path, ...args);
};
fs.writeFileSync = (path, contents, ...args) => {
  if (path === target && fs.existsSync(gate)) {
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
`,
    );

    const result = spawnSync(
      process.execPath,
      ["--import", preload, release, version, "--dry-run"],
      {
        cwd: workspace,
        env: { ...process.env, PATH: bin },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    if (result.error) throw result.error;
    return {
      ...result,
      originals,
      manifests: Object.fromEntries(
        packages.map((name) => [
          name,
          readFileSync(join(workspace, "packages", name, "package.json"), "utf8"),
        ]),
      ),
      packStarted: existsSync(join(workspace, "pack-started")),
    };
  } finally {
    const stageRecord = join(workspace, "release-stage");
    if (existsSync(stageRecord)) {
      rmSync(readFileSync(stageRecord, "utf8"), { recursive: true, force: true });
    }
    rmSync(workspace, { recursive: true, force: true });
  }
}

it.each(["read", "write"])(
  "restores every manifest when the second package's %s fails",
  (failure) => {
    const result = runRelease(failure);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`fixture manifest ${failure} failure`);
    expect(result.manifests).toEqual(result.originals);
    expect(result.packStarted).toBe(false);
  },
);

it("restores the original manifest bytes after packaging fails", () => {
  const result = runRelease("pack");
  expect(result.status).toBe(1);
  expect(result.packStarted).toBe(true);
  expect(result.manifests).toEqual(result.originals);
});

it("attempts the remaining restorations and reports a manifest it cannot restore", () => {
  const result = runRelease("restore");
  expect(result.status).toBe(1);
  expect(JSON.parse(result.manifests.reactive).version).toBe(version);
  expect(result.manifests.core).toBe(result.originals.core);
  expect(result.manifests.platform).toBe(result.originals.platform);
  expect(result.manifests.dougong).toBe(result.originals.dougong);
  expect(result.stderr).toContain("packages/reactive/package.json");
  expect(result.stderr).toContain("fixture manifest restoration failure");
  expect(result.stdout).not.toContain("versions restored");
});
