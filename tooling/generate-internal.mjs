import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { abortListenerPort } from "./packages.mjs";

const root = new URL("../", import.meta.url);
const check = process.argv.includes("--check");
for (const filename of [
  "abort.ts",
  "synchronous-result.ts",
  "disposal-runtime.ts",
  ...Object.values(abortListenerPort.targets).map((target) => basename(target)),
]) {
  const source = readFileSync(new URL(`tooling/internal/${filename}`, root), "utf8");
  const generated =
    `// Generated from tooling/internal/${filename}. Run pnpm generate:internal.\n` + source;
  for (const name of abortListenerPort.packages) {
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

for (const name of abortListenerPort.packages) {
  const path = new URL(`packages/${name}/package.json`, root);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const { specifier, targets } = abortListenerPort;
  // Resolution uses the first matching condition, so its order is part of the generated contract.
  if (JSON.stringify(manifest.imports?.[specifier]) === JSON.stringify(targets)) continue;
  if (check)
    throw new Error(`${fileURLToPath(path)}: ${specifier} differs from its authoritative source`);
  (manifest.imports ??= {})[specifier] = targets;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
