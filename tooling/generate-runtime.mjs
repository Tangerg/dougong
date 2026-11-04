import { writeFileSync } from "node:fs";
import { runtimeProjectionChanges } from "./runtime-projections.mjs";

const changes = runtimeProjectionChanges(new URL("../", import.meta.url));
if (process.argv.includes("--check")) {
  if (changes.length)
    throw new Error(
      `Runtime projections differ from tooling/runtime-baseline.mjs: ${changes.map(({ path }) => path).join(", ")}. Run pnpm generate:runtime.`,
    );
} else {
  for (const { url, generated } of changes) writeFileSync(url, generated);
}
