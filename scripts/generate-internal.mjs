import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const source = readFileSync(new URL("scripts/internal/sync-result.ts", root), "utf8");
const generated =
  "// Generated from scripts/internal/sync-result.ts. Run pnpm generate:internal.\n" + source;
const check = process.argv.includes("--check");
for (const packageName of ["core", "reactive"]) {
  const target = new URL(`packages/${packageName}/src/sync-result.ts`, root);
  if (readFileSync(target, "utf8") === generated) continue;
  if (check) throw new Error(`${fileURLToPath(target)} differs from its authoritative source`);
  writeFileSync(target, generated);
}
