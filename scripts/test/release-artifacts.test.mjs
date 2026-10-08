import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const release = fileURLToPath(new URL("../release.mjs", import.meta.url));
const version = "0.7.2";
const packages = ["reactive", "core", "platform", "dougong"];

const command = `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
const workspace = process.env.DOUGONG_RELEASE_FIXTURE;
if (name === "git") {
  if (args[0] === "rev-parse") console.log(args.includes("--abbrev-ref") ? "main" : "a".repeat(40));
  else if (args[0] === "rev-list") console.log("0");
  else if (!["status", "fetch", "tag"].includes(args[0])) process.exit(99);
} else if (name === "mkdir") {
  mkdirSync(args[1], { recursive: true });
} else if (name === "pnpm" && args[0] === "check") {
  process.exit(0);
} else if (args[0] === "pack" && (name === "pnpm" || name === "npm")) {
  const stage = args[args.indexOf("--pack-destination") + 1];
  const packageName = name === "pnpm" ? basename(process.cwd()) : "reactive";
  const source = join(workspace, name === "pnpm" ? "local" : "published", packageName);
  if (name === "pnpm") {
    cpSync(join(process.cwd(), "package.json"), join(source, "package/package.json"));
    if (packageName === "core") {
      const manifestPath = join(source, "package/package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (process.env.DOUGONG_RELEASE_PACKED_NAME) manifest.name = process.env.DOUGONG_RELEASE_PACKED_NAME;
      if (process.env.DOUGONG_RELEASE_PACKED_DEPENDENCIES) {
        manifest.dependencies = JSON.parse(process.env.DOUGONG_RELEASE_PACKED_DEPENDENCIES);
      }
      writeFileSync(manifestPath, JSON.stringify(manifest));
    }
    writeFileSync(join(workspace, "release-stage"), stage);
  }
  const archive = join(stage, packageName + ".tgz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", source, "package"]);
  if (packed.error || packed.status !== 0) process.exit(99);
  console.log(archive);
} else if (name === "npm" && args[0] === "view") {
  if (args[1].startsWith("@dougongjs/reactive@")) console.log(JSON.stringify("${version}"));
  else {
    console.log(JSON.stringify({ error: { code: "E404" } }));
    process.exit(1);
  }
} else process.exit(99);
`;

function runRelease(mutate, { packedName = "", packedDependencies, escapedNames = false } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "dougong-release-artifacts-test-"));
  try {
    const bin = join(workspace, "bin");
    mkdirSync(bin);
    for (const name of ["git", "npm", "pnpm", "mkdir"]) {
      writeFileSync(join(bin, name), command, { mode: 0o755 });
    }
    for (const name of ["tar", "gzip"]) {
      const executable = (process.env.PATH ?? "")
        .split(delimiter)
        .map((directory) => join(directory, name))
        .find((path) => existsSync(path));
      if (!executable) throw new Error(`Release fixture requires ${name}`);
      symlinkSync(executable, join(bin, name));
    }

    const originals = new Map();
    for (const name of packages) {
      const packageName = name === "dougong" ? name : `@dougongjs/${name}`;
      const manifest =
        `${JSON.stringify({ name: packageName, version: "0.7.1" }, null, 2)}\n`.replace(
          packageName,
          escapedNames ? packageName.replace("d", "\\u0064") : packageName,
        );
      const path = join(workspace, "packages", name, "package.json");
      mkdirSync(join(workspace, "packages", name), { recursive: true });
      writeFileSync(path, manifest);
      originals.set(path, manifest);
      const files = {
        "dist/index.js": "export const signal = value => value;\n",
        "dist/index.d.ts": 'export { signal } from "./signals";\n',
        "dist/signals.d.ts": "export declare function signal(value: number): number;\n",
        "dist/index.d.ts.map": '{"version":3,"sources":["../src/index.ts"]}',
        "dist/payload.bin": Buffer.from([0xff, 0x00, 0x01]),
        "README.md": "Fixture documentation\n",
        LICENSE: "Fixture license\n",
        "package.json": `${JSON.stringify({ name: packageName, version }, null, 2)}\n`,
      };
      for (const side of ["local", "published"]) {
        const root = join(workspace, side, name, "package");
        for (const [file, contents] of Object.entries(files)) {
          mkdirSync(dirname(join(root, file)), { recursive: true });
          writeFileSync(join(root, file), contents);
        }
      }
    }
    mutate(join(workspace, "published/reactive/package"));
    const result = spawnSync(process.execPath, [release, version, "--dry-run"], {
      cwd: workspace,
      env: {
        ...process.env,
        PATH: bin,
        DOUGONG_RELEASE_FIXTURE: workspace,
        DOUGONG_RELEASE_PACKED_NAME: packedName,
        DOUGONG_RELEASE_PACKED_DEPENDENCIES:
          packedDependencies === undefined ? "" : JSON.stringify(packedDependencies),
      },
      encoding: "utf8",
      timeout: 10000,
    });
    if (result.error) throw result.error;
    for (const [path, contents] of originals) expect(readFileSync(path, "utf8")).toBe(contents);
    return result;
  } finally {
    const stageRecord = join(workspace, "release-stage");
    if (existsSync(stageRecord)) {
      rmSync(readFileSync(stageRecord, "utf8"), { recursive: true, force: true });
    }
    rmSync(workspace, { recursive: true, force: true });
  }
}

it.each([
  ["dist/signals.d.ts", "export declare function signal(value: string): string;\n"],
  ["dist/index.d.ts.map", '{"version":3,"sources":["../src/previous.ts"]}'],
  ["dist/payload.bin", Buffer.from([0xfe, 0x00, 0x01])],
  ["README.md", "Previous documentation\n"],
  ["LICENSE", "Previous license\n"],
])("refuses to resume a published version with different %s", (file, contents) => {
  const result = runRelease((root) => writeFileSync(join(root, file), contents));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(file);
  expect(result.stdout).not.toContain("contents match");
});

it.each(["missing", "additional"])("refuses to resume when a package file is %s", (kind) => {
  const file = kind === "missing" ? "dist/signals.d.ts" : "dist/previous.d.ts";
  const result = runRelease((root) => {
    if (kind === "missing") rmSync(join(root, file));
    else writeFileSync(join(root, file), "Previous public declaration\n");
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(file);
  expect(result.stdout).not.toContain("contents match");
});

it("resumes packaging only when the complete published package matches", () => {
  const result = runRelease(() => undefined);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("already published, contents match");
  expect(result.stdout).toContain("Dry run complete");
});

it("restores the original manifest bytes after a successful dry run", () => {
  const result = runRelease(() => undefined, { escapedNames: true });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("package.json versions restored");
});

it("rejects a tarball carrying another package's identity before publication", () => {
  const result = runRelease(() => undefined, { packedName: "@fixture/unexpected" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("tarball declares name @fixture/unexpected");
  expect(result.stdout).not.toContain("Dry run complete");
});

it.each([
  { range: version, status: 0, output: "stdout", message: "Dry run complete" },
  { range: "^0.7.20", status: 1, output: "stderr", message: `expected ${version}` },
])("checks the packed internal dependency version $range", ({ range, status, output, message }) => {
  const result = runRelease(() => undefined, {
    packedDependencies: { "@dougongjs/reactive": range },
  });
  expect(result.status).toBe(status);
  expect(result[output]).toContain(message);
});
