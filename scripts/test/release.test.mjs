import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { executeRelease, releaseTestTimeout } from "./release-fixture.mjs";

vi.setConfig({ testTimeout: releaseTestTimeout });

const release = fileURLToPath(new URL("../release.mjs", import.meta.url));
const version = "0.7.2";

const preload = fileURLToPath(new URL("./fixtures/release-preflight.mjs", import.meta.url));

async function runRelease(
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
    const result = await executeRelease(["--import", preload, release, ...releaseArgs], {
      cwd: workspace,
      env: { ...process.env, PATH: bin },
    });
    return {
      ...result,
      gate: existsSync(join(workspace, "gate-started"))
        ? JSON.parse(readFileSync(join(workspace, "gate-started"), "utf8"))
        : undefined,
      queries: JSON.parse(readFileSync(join(workspace, "queries.json"), "utf8")),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

it.each(["E503", "ENOTFOUND", "E401"])(
  "stops release preflight when the registry reports %s",
  async (code) => {
    const result = await runRelease({ status: 1, stdout: JSON.stringify({ error: { code } }) });
    expect(result.status).toBe(1);
    expect(result.gate).toBeUndefined();
    expect(result.stdout).not.toContain(`${version} is unused on the registry`);
    expect(result.stderr).toContain(code);
  },
);

it.each([
  { label: "an unavailable npm executable", missing: true },
  { label: "a terminated query", signal: "SIGTERM" },
  { label: "malformed output", status: 1, stdout: "not JSON" },
  { label: "empty successful output", status: 0, stdout: "" },
  { label: "a different version", status: 0, stdout: JSON.stringify("0.7.3") },
])("stops release preflight on $label", async (response) => {
  const result = await runRelease(response);
  expect(result.status).toBe(1);
  expect(result.gate).toBeUndefined();
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
])("rejects invalid release version %s before external commands", async (candidate) => {
  const result = await runRelease(
    { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) },
    undefined,
    [candidate, "--dry-run"],
  );
  expect(result.status).toBe(1);
  expect(result.queries).toEqual([]);
  expect(result.gate).toBeUndefined();
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
])("rejects ambiguous or malformed release arguments $args", async ({ args, error }) => {
  const result = await runRelease(
    { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) },
    undefined,
    args,
  );
  expect(result.status).toBe(1);
  expect(result.queries).toEqual([]);
  expect(result.gate).toBeUndefined();
  expect(result.stderr).toContain(error);
});

it.each([
  ["0.7.2-alpha.1", "--dry-run"],
  ["--otp=123456", "--dry-run", version],
  [version, "--yes", "--dry-run", "--otp=123456"],
])("accepts canonical release inputs %s", async (...args) => {
  const result = await runRelease(
    { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) },
    undefined,
    args,
  );
  expect(result.status).toBe(1);
  expect(result.gate).toEqual(["check"]);
});

it("continues to verification only for an explicit missing version", async () => {
  const result = await runRelease({
    status: 1,
    stdout: JSON.stringify({ error: { code: "E404" } }),
  });
  expect(result.status).toBe(1);
  expect(result.gate).toEqual(["check"]);
  expect(result.stdout).toContain(`${version} is unused on the registry`);
});

it("verifies a fully published version before finishing its release record", async () => {
  const result = await runRelease({ status: 0, stdout: JSON.stringify(version) });
  expect(result.status).toBe(1);
  expect(result.gate).toEqual(["check"]);
  expect(result.queries).toHaveLength(4);
  expect(result.stdout).toContain("resuming:");
});

it("queries the release identities captured from package manifests", async () => {
  const names = ["@fixture/reactive", "@fixture/core", "@fixture/platform", "fixture-facade"];
  const result = await runRelease(
    { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) },
    names,
  );
  expect(result.queries).toEqual(names.map((name) => `${name}@${version}`));
  expect(result.gate).toEqual(["check"]);
});

it.each([
  { label: "missing", names: [undefined, "core", "platform", "facade"], error: "package name" },
  { label: "duplicate", names: ["shared", "shared", "platform", "facade"], error: "unique" },
])("rejects $label release identities before querying npm", async ({ names, error }) => {
  const result = await runRelease(
    { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) },
    names,
  );
  expect(result.status).toBe(1);
  expect(result.queries).toEqual([]);
  expect(result.gate).toBeUndefined();
  expect(result.stderr).toContain(error);
});
