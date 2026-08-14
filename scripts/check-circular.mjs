#!/usr/bin/env node
// Run madge --circular over the workspace and fail on any cycle not on the
// allowlist. Allowlist entries are full file-sets of a known, benign cycle.
//
// Cycles matter more here than in an app: every package ships as a library, and
// a runtime cycle between two modules of `@dougong/core` would surface as a
// partially-initialised binding in a consumer's bundler, not in our tests.

import { execFileSync } from "node:child_process";

// Each entry is the full set of files in a known cycle, sorted. A reported
// cycle matches if its sorted file list deep-equals one of these. Paths are
// relative to `packages/`.
//
// Empty today: the core modules form a strict order (see check-layers.mjs), and
// `contracts.ts` / `errors.ts` import nothing at all. If a type-only cycle
// becomes genuinely worthwhile, add it here with a comment saying why breaking
// it would cost more than the cycle does. madge cannot tell `import type` from
// a value import, so type-only cycles are the only defensible entries.
const ALLOWED = [];

const allowedKeys = new Set(ALLOWED.map((cycle) => [...cycle].sort().join("|")));

let raw;
try {
  raw = execFileSync(
    "pnpm",
    [
      "exec",
      "madge",
      "--circular",
      "--extensions",
      "ts",
      "--ts-config",
      "tsconfig.base.json",
      // `dist/` holds emitted .d.ts files that mirror src; including them would
      // double every edge and report the same cycle twice.
      "--exclude",
      "(^|/)dist/",
      "--json",
      "packages/",
    ],
    { encoding: "utf8" },
  );
} catch (err) {
  // madge exits non-zero when it finds cycles, but still writes the JSON.
  raw = err.stdout?.toString() ?? "";
}

let cycles;
try {
  cycles = JSON.parse(raw);
} catch {
  console.error("[check-circular] madge did not produce valid JSON:");
  console.error(raw);
  process.exit(2);
}

const unexpected = cycles.filter((cycle) => !allowedKeys.has([...cycle].sort().join("|")));

if (unexpected.length > 0) {
  console.error(`[check-circular] Found ${unexpected.length} new circular dependency(ies):`);
  for (const cycle of unexpected) {
    console.error("  " + cycle.join(" > ") + " > " + cycle[0]);
  }
  console.error("");
  console.error("If a new cycle is intentional (type-only, no runtime hazard),");
  console.error("add it to ALLOWED in scripts/check-circular.mjs with a comment.");
  process.exit(1);
}

console.log(`[check-circular] OK: ${cycles.length} cycle(s) found, all on the allowlist.`);
