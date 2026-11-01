import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const check = process.argv.includes("--check");
for (const filename of [
  "abort.ts",
  "sync-result.ts",
  "disposal-runtime.ts",
  "abort-listener.node.mjs",
  "abort-listener.web.mjs",
  "abort-listener.d.mts",
]) {
  const source = readFileSync(new URL(`tooling/internal/${filename}`, root), "utf8");
  const generated =
    `// Generated from tooling/internal/${filename}. Run pnpm generate:internal.\n` + source;
  for (const name of ["dougong", "reactive"]) {
    const directory = filename.endsWith(".ts")
      ? name === "dougong"
        ? "src/internal"
        : "src"
      : "runtime";
    const target = new URL(`packages/${name}/${directory}/${filename}`, root);
    let existing;
    try {
      existing = readFileSync(target, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing === generated) continue;
    if (check) throw new Error(`${fileURLToPath(target)} differs from its authoritative source`);
    mkdirSync(new URL("./", target), { recursive: true });
    writeFileSync(target, generated);
  }
}
