import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";
import { expect, it } from "vitest";

it("lints workspace source independently of installed build artifacts", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dougong-lint-resolution-"));
  try {
    for (const directory of [
      "packages/sample/src",
      "packages/sample/test",
      "examples",
      "tooling",
      "node_modules/dougong",
    ])
      mkdirSync(join(workspace, directory), { recursive: true });
    writeFileSync(
      join(workspace, "tsconfig.json"),
      JSON.stringify({ extends: "./tsconfig.base.json", files: [] }),
    );
    writeFileSync(
      join(workspace, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { dougong: ["packages/sample/src/index.ts"] } },
      }),
    );
    writeFileSync(
      join(workspace, "packages/sample/tsconfig.json"),
      JSON.stringify({ extends: "../../tsconfig.base.json", include: ["src"] }),
    );
    writeFileSync(join(workspace, "packages/sample/src/index.ts"), "export const current = 1;\n");
    writeFileSync(
      join(workspace, "node_modules/dougong/package.json"),
      JSON.stringify({ name: "dougong", type: "module", exports: "./index.js" }),
    );
    writeFileSync(join(workspace, "node_modules/dougong/index.js"), "export const obsolete = 1;\n");
    writeFileSync(
      join(workspace, ".oxlintrc.json"),
      readFileSync(new URL("../../.oxlintrc.json", import.meta.url)),
    );
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const [command, ...arguments_] = manifest.scripts.lint.split(" ");
    const executable = fileURLToPath(
      new URL(`../../node_modules/.bin/${command}`, import.meta.url),
    );
    const source = join(workspace, "packages/sample/test/public-api.types.ts");
    const lint = () => spawnSync(executable, arguments_, { cwd: workspace, encoding: "utf8" });
    writeFileSync(source, 'import * as core from "dougong";\nconsole.log(core.current);\n');
    expect(lint()).toMatchObject({ status: 0, stderr: "" });
    writeFileSync(source, 'import * as core from "dougong";\nconsole.log(core.obsolete);\n');
    const rejected = lint();
    expect(rejected.status).toBe(1);
    expect(rejected.stdout + rejected.stderr).toContain("import(namespace)");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

it("derives runtime test resolution from the TypeScript workspace paths", async () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "dougong-workspace-resolution-")));
  try {
    writeFileSync(
      join(workspace, "vitest.config.ts"),
      readFileSync(new URL("../../vitest.config.ts", import.meta.url)),
    );
    writeFileSync(
      join(workspace, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: "sources #data",
          paths: {
            dougong: ["replacement #1.ts"],
            "@fixture/addition": ["addition.ts"],
          },
        },
      }),
    );
    symlinkSync(
      fileURLToPath(new URL("../../node_modules", import.meta.url)),
      join(workspace, "node_modules"),
      "dir",
    );
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "test" },
      join(workspace, "vitest.config.ts"),
      workspace,
    );
    expect(loaded?.config.resolve?.alias).toEqual([
      { find: /^dougong$/, replacement: join(workspace, "sources #data/replacement #1.ts") },
      { find: /^@fixture\/addition$/, replacement: join(workspace, "sources #data/addition.ts") },
    ]);
    expect(loaded.config.resolve.alias[0].find.test("dougong/advanced")).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

it("keeps the installed dependency in control of both root and subpath runtime imports", async () => {
  const configuration = await loadConfigFromFile(
    { command: "build", mode: "production" },
    fileURLToPath(new URL("../../examples/vite.config.ts", import.meta.url)),
  );
  const external = configuration.config.build.rollupOptions.external;
  const matches = (id) => (typeof external === "function" ? external(id) : external.includes(id));
  expect(matches("dougong")).toBe(true);
  expect(matches("dougong/advanced")).toBe(true);
  expect(matches("dougong-unrelated")).toBe(false);
});
