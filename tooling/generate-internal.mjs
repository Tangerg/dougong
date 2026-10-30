import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const check = process.argv.includes("--check");
for (const name of ["sync-result", "disposal-runtime"]) {
  const source = readFileSync(new URL(`tooling/internal/${name}.ts`, root), "utf8");
  const generated =
    `// Generated from tooling/internal/${name}.ts. Run pnpm generate:internal.\n` + source;
  const targets =
    name === "disposal-runtime"
      ? [
          "packages/dougong/src/internal/disposal-runtime.ts",
          "packages/reactive/src/disposal-runtime.ts",
        ]
      : ["packages/dougong/src/internal/sync-result.ts", "packages/reactive/src/sync-result.ts"];
  for (const relative of targets) {
    const target = new URL(relative, root);
    let existing;
    try {
      existing = readFileSync(target, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing === generated) continue;
    if (check) throw new Error(`${fileURLToPath(target)} differs from its authoritative source`);
    writeFileSync(target, generated);
  }
}
