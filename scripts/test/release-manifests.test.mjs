import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { executeRelease, releaseTestTimeout } from "./release-fixture.mjs";

vi.setConfig({ testTimeout: releaseTestTimeout });

const release = fileURLToPath(new URL("../release.mjs", import.meta.url));
const packages = ["reactive", "core", "platform", "dougong"];
const version = "0.7.2";

const preload = fileURLToPath(new URL("./fixtures/release-manifests.mjs", import.meta.url));

async function runRelease(failure) {
  const workspace = mkdtempSync(join(tmpdir(), "dougong-release-manifests-test-"));
  try {
    const bin = join(workspace, "bin");
    mkdirSync(bin);
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

    const result = await executeRelease(["--import", preload, release, version, "--dry-run"], {
      cwd: workspace,
      env: { ...process.env, PATH: bin, DOUGONG_RELEASE_FAILURE: failure },
    });
    return {
      ...result,
      originals,
      manifests: Object.fromEntries(
        packages.map((name) => [
          name,
          readFileSync(join(workspace, "packages", name, "package.json"), "utf8"),
        ]),
      ),
      packStarted: existsSync(join(workspace, "release-stage")),
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
  async (failure) => {
    const result = await runRelease(failure);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`fixture manifest ${failure} failure`);
    expect(result.manifests).toEqual(result.originals);
    expect(result.packStarted).toBe(false);
  },
);

it("restores the original manifest bytes after packaging fails", async () => {
  const result = await runRelease("pack");
  expect(result.status).toBe(1);
  expect(result.packStarted).toBe(true);
  expect(result.manifests).toEqual(result.originals);
});

it("attempts the remaining restorations and reports a manifest it cannot restore", async () => {
  const result = await runRelease("restore");
  expect(result.status).toBe(1);
  expect(JSON.parse(result.manifests.reactive).version).toBe(version);
  expect(result.manifests.core).toBe(result.originals.core);
  expect(result.manifests.platform).toBe(result.originals.platform);
  expect(result.manifests.dougong).toBe(result.originals.dougong);
  expect(result.stderr).toContain("packages/reactive/package.json");
  expect(result.stderr).toContain("fixture manifest restoration failure");
  expect(result.stdout).not.toContain("versions restored");
});
