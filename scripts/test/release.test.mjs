import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const release = fileURLToPath(new URL("../release.mjs", import.meta.url));
const version = "0.7.2";

const command = `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
if (name === "git") {
  if (args[0] === "rev-parse") console.log(args.includes("--abbrev-ref") ? "main" : "a".repeat(40));
  else if (args[0] === "rev-list") console.log("0");
  else if (!["status", "fetch", "tag"].includes(args[0])) process.exit(99);
} else if (name === "npm") {
  const queries = JSON.parse(readFileSync("queries.json", "utf8"));
  queries.push(args[1]);
  writeFileSync("queries.json", JSON.stringify(queries));
  const response = JSON.parse(readFileSync("response.json", "utf8"));
  if (response.signal) process.kill(process.pid, response.signal);
  process.stdout.write(args.includes("--json") ? response.stdout : (response.plain ?? response.stdout));
  process.exit(response.status);
} else if (name === "pnpm") {
  writeFileSync("gate-started", JSON.stringify(args));
  process.exit(1);
} else process.exit(99);
`;

function runRelease(
  response,
  names = ["@dougongjs/reactive", "@dougongjs/core", "@dougongjs/platform", "dougong"],
  releaseArgs = [version, "--dry-run"],
) {
  const workspace = mkdtempSync(join(tmpdir(), "dougong-release-test-"));
  try {
    const bin = join(workspace, "bin");
    mkdirSync(bin);
    for (const [index, directory] of ["reactive", "core", "platform", "dougong"].entries()) {
      const path = join(workspace, "packages", directory);
      mkdirSync(path, { recursive: true });
      writeFileSync(
        join(path, "package.json"),
        JSON.stringify({ name: names[index], version: "0.7.1" }),
      );
    }
    writeFileSync(join(workspace, "queries.json"), "[]");
    writeFileSync(join(workspace, "response.json"), JSON.stringify(response));
    for (const name of ["git", "pnpm", ...(response.missing ? [] : ["npm"])]) {
      writeFileSync(join(bin, name), command, { mode: 0o755 });
    }
    const result = spawnSync(process.execPath, [release, ...releaseArgs], {
      cwd: workspace,
      env: { ...process.env, PATH: bin },
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.error) throw result.error;
    return {
      ...result,
      gateStarted: existsSync(join(workspace, "gate-started")),
      queries: JSON.parse(readFileSync(join(workspace, "queries.json"), "utf8")),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

it.each(["E503", "ENOTFOUND", "E401"])(
  "stops release preflight when the registry reports %s",
  (code) => {
    const result = runRelease({ status: 1, stdout: JSON.stringify({ error: { code } }) });
    expect(result.status).toBe(1);
    expect(result.gateStarted).toBe(false);
    expect(result.stdout).not.toContain(`${version} is unused on the registry`);
    expect(result.stderr).toContain(code);
  },
);

it.each([
  { label: "an unavailable npm executable", missing: true, status: 1, stdout: "" },
  { label: "a terminated query", signal: "SIGTERM", status: 1, stdout: "" },
  { label: "malformed output", status: 1, stdout: "not JSON" },
  { label: "empty successful output", status: 0, stdout: "" },
  { label: "a different version", status: 0, stdout: JSON.stringify("0.7.3"), plain: "0.7.3" },
])("stops release preflight on $label", (response) => {
  const result = runRelease(response);
  expect(result.status).toBe(1);
  expect(result.gateStarted).toBe(false);
  expect(result.stdout).not.toContain(`${version} is unused on the registry`);
});

it.each([
  "01.2.3",
  "1.02.3",
  "1.2.03",
  "1.2.3-01",
  "1.2.3-alpha..1",
  "1.2.3-alpha.",
  "1.2.3-.alpha",
])("rejects invalid release version %s before external commands", (candidate) => {
  const result = runRelease(
    { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) },
    undefined,
    [candidate, "--dry-run"],
  );
  expect(result.status).toBe(1);
  expect(result.queries).toEqual([]);
  expect(result.gateStarted).toBe(false);
  expect(result.stderr).toContain("version");
});

it.each([
  { args: [version, "--dryrun", "--yes"], error: "--dryrun" },
  { args: [version, "--dry-run", "--yess"], error: "--yess" },
  { args: [version, "0.7.3", "--dry-run"], error: "usage:" },
  { args: [version, "--dry-run", "--otp"], error: "--otp" },
  { args: [version, "--dry-run", "--otp="], error: "--otp" },
  { args: [version, "--dry-run", "--otp=   "], error: "--otp" },
  { args: [version, "--dry-run", "--dry-run"], error: "specified once" },
  { args: [version, "--dry-run", "--yes", "--yes"], error: "specified once" },
  {
    args: [version, "--dry-run", "--otp=123456", "--otp=654321"],
    error: "specified once",
  },
])("rejects ambiguous or malformed release arguments $args", ({ args, error }) => {
  const result = runRelease(
    { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) },
    undefined,
    args,
  );
  expect(result.status).toBe(1);
  expect(result.queries).toEqual([]);
  expect(result.gateStarted).toBe(false);
  expect(result.stderr).toContain(error);
});

it.each([
  ["0.7.2-alpha.1", "--dry-run"],
  ["--otp=123456", "--dry-run", version],
  [version, "--yes", "--dry-run", "--otp=123456"],
])("accepts canonical release inputs %s", (...args) => {
  const result = runRelease(
    { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) },
    undefined,
    args,
  );
  expect(result.status).toBe(1);
  expect(result.gateStarted).toBe(true);
});

it("continues to verification only for an explicit missing version", () => {
  const result = runRelease({ status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) });
  expect(result.status).toBe(1);
  expect(result.gateStarted).toBe(true);
  expect(result.stdout).toContain(`${version} is unused on the registry`);
});

it("recognizes an existing version before starting verification", () => {
  const result = runRelease({ status: 0, stdout: JSON.stringify(version), plain: version });
  expect(result.status).toBe(1);
  expect(result.gateStarted).toBe(false);
  expect(result.stderr).toContain(`${version} is already published for every package`);
});

it("queries the release identities captured from package manifests", () => {
  const names = ["@fixture/reactive", "@fixture/core", "@fixture/platform", "fixture-facade"];
  const result = runRelease(
    { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) },
    names,
  );
  expect(result.queries).toEqual(names.map((name) => `${name}@${version}`));
  expect(result.gateStarted).toBe(true);
});

it.each([
  { label: "missing", names: [undefined, "core", "platform", "facade"], error: "package name" },
  { label: "duplicate", names: ["shared", "shared", "platform", "facade"], error: "unique" },
])("rejects $label release identities before querying npm", ({ names, error }) => {
  const result = runRelease(
    { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) },
    names,
  );
  expect(result.status).toBe(1);
  expect(result.queries).toEqual([]);
  expect(result.gateStarted).toBe(false);
  expect(result.stderr).toContain(error);
});
