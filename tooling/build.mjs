import { spawnSync } from "node:child_process";
import { publishedDirectories } from "./packages.mjs";

for (const directory of [...publishedDirectories, "examples"]) {
  const result = spawnSync("pnpm", ["--dir", directory, "build"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
