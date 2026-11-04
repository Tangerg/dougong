import { spawnSync } from "node:child_process";
import {
  cpSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { publishedDirectories } from "../packages.mjs";
import { runtimeBaseline } from "../runtime-baseline.mjs";

it("regenerates every runtime projection from one policy change and refuses missing boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "dougong-runtime-projections-"));
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  try {
    const documents = globSync(["README*.md", "docs/**/*.md", "packages/*/README.md"], {
      cwd: repository,
    }).filter((path) =>
      readFileSync(join(repository, path), "utf8").includes("<!-- runtime-baseline:start -->"),
    );
    const exampleManifestPath = "examples/package.json";
    const projections = [
      "package.json",
      ...publishedDirectories.map((path) => `${path}/package.json`),
      exampleManifestPath,
      ...documents,
    ];
    for (const path of [
      ...projections,
      ...[
        "generate-runtime.mjs",
        "runtime-projections.mjs",
        "runtime-baseline.mjs",
        "packages.mjs",
      ].map((name) => `tooling/${name}`),
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(repository, path), join(root, path));
    }
    const generate = (...arguments_) =>
      spawnSync(process.execPath, [join(root, "tooling/generate-runtime.mjs"), ...arguments_], {
        encoding: "utf8",
      });
    expect(generate("--check").status).toBe(0);
    const before = new Map(
      projections.map((path) => [path, readFileSync(join(root, path), "utf8")]),
    );
    const previousVersion = runtimeBaseline.nodeTestVersions[0];
    const version = previousVersion.split(".").map(Number);
    version[2]++;
    const nextVersion = version.join(".");
    const policyPath = join(root, "tooling/runtime-baseline.mjs");
    writeFileSync(
      policyPath,
      readFileSync(policyPath, "utf8").replace(
        JSON.stringify(previousVersion),
        JSON.stringify(nextVersion),
      ),
    );
    const stale = generate("--check");
    expect(stale.status).toBe(1);
    for (const path of projections) expect(stale.stderr).toContain(path);
    expect(generate().status).toBe(0);
    expect(generate("--check").status).toBe(0);
    expect(projections).toHaveLength(13);
    for (const [path, source] of before) {
      const generated = readFileSync(join(root, path), "utf8");
      expect(generated).not.toBe(source);
      expect(generated).toContain(`^${nextVersion}`);
    }
    const beforeBrowser = new Map(
      projections.map((path) => [path, readFileSync(join(root, path), "utf8")]),
    );
    const [browser, minimum] = runtimeBaseline.browserslist[0].split(" >= ");
    const nextMinimum = String(Number(minimum) + 1);
    writeFileSync(
      policyPath,
      readFileSync(policyPath, "utf8").replace(
        JSON.stringify(minimum),
        JSON.stringify(nextMinimum),
      ),
    );
    const staleBrowser = generate("--check");
    expect(staleBrowser.status).toBe(1);
    expect(staleBrowser.stderr).not.toContain(exampleManifestPath);
    expect(generate().status).toBe(0);
    expect(generate("--check").status).toBe(0);
    expect(readFileSync(join(root, exampleManifestPath), "utf8")).toBe(
      beforeBrowser.get(exampleManifestPath),
    );
    for (const [path, source] of [...beforeBrowser].filter(
      ([path]) => path !== exampleManifestPath,
    )) {
      const generated = readFileSync(join(root, path), "utf8");
      expect(staleBrowser.stderr).toContain(path);
      expect(generated).not.toBe(source);
      expect(generated).toContain(
        path.endsWith(".json") ? `${browser} >= ${nextMinimum}` : `${browser} ≥ ${nextMinimum}`,
      );
    }
    const documentPath = join(root, documents[0]);
    writeFileSync(
      documentPath,
      readFileSync(documentPath, "utf8").replace("<!-- runtime-baseline:start -->", ""),
    );
    const incomplete = generate();
    expect(incomplete.status).toBe(1);
    expect(incomplete.stderr).toContain("expected one runtime-baseline region");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
