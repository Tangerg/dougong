import {
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
  const config = await loadConfigFromFile(
    { command: "build", mode: "production" },
    fileURLToPath(new URL("../../examples/vite.config.ts", import.meta.url)),
  );
  const external = config.config.build.rollupOptions.external;
  const matches = (id) => (typeof external === "function" ? external(id) : external.includes(id));
  expect(matches("dougong")).toBe(true);
  expect(matches("dougong/advanced")).toBe(true);
  expect(matches("dougong-unrelated")).toBe(false);
});
