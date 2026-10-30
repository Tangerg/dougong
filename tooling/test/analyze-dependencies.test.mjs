import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const analyzer = new URL("../architecture/analyze-dependencies.mjs", import.meta.url).href;

function analyze(imports) {
  const workspace = mkdtempSync(join(tmpdir(), "dougong-dependency-analysis-"));
  try {
    const files = {
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
      }),
      "packages/index.ts": imports,
      "packages/model.ts": "export interface Model { value: string }",
      "packages/lazy.ts": "export const value = 1;",
      "node_modules/esm-only/package.json": JSON.stringify({
        name: "esm-only",
        type: "module",
        exports: { "./plugin": { import: { types: "./plugin.d.mts", default: "./plugin.mjs" } } },
      }),
      "node_modules/esm-only/plugin.d.mts": "export declare const plugin: string;",
      "node_modules/esm-only/plugin.mjs": 'export const plugin = "plugin";',
    };
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(workspace, path);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, content);
    }
    return spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { analyzeDependencies } from ${JSON.stringify(analyzer)}; console.log(JSON.stringify((await analyzeDependencies()).obj()));`,
      ],
      { cwd: workspace, encoding: "utf8" },
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

it("resolves ESM exports while retaining type-only and dynamic import edges", () => {
  const result = analyze(
    'import { plugin } from "esm-only/plugin"; import type { Model } from "./model"; export const load = () => import("./lazy");',
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)["packages/index.ts"]).toEqual([
    "packages/lazy.ts",
    "packages/model.ts",
  ]);
});

it("still rejects missing imports", () => {
  const result = analyze('import "missing-package";');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "Dependency analysis could not resolve imports:\nmissing-package",
  );
});
