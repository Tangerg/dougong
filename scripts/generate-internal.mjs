import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const check = process.argv.includes("--check");
for (const name of ["sync-result", "disposal-runtime"]) {
  const source = readFileSync(new URL(`scripts/internal/${name}.ts`, root), "utf8");
  const generated =
    `// Generated from scripts/internal/${name}.ts. Run pnpm generate:internal.\n` + source;
  for (const packageName of ["core", "reactive"]) {
    const target = new URL(`packages/${packageName}/src/${name}.ts`, root);
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
