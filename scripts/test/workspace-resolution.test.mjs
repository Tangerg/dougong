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
    expect(loaded?.config.resolve?.alias).toEqual({
      dougong: join(workspace, "sources #data/replacement #1.ts"),
      "@fixture/addition": join(workspace, "sources #data/addition.ts"),
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
