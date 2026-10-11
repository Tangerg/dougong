#!/usr/bin/env node

import { analyzeDependencies } from "./analyze-dependencies.mjs";

// madge cannot distinguish type-only edges, so any allowed cycle needs a demonstrated ownership rationale.
const ALLOWED = [];

const allowedKeys = new Set(ALLOWED.map((cycle) => [...cycle].sort().join("|")));

const cycles = (await analyzeDependencies()).circular();

const unexpected = cycles.filter((cycle) => !allowedKeys.has([...cycle].sort().join("|")));

if (unexpected.length > 0) {
  console.error(`[check-circular] Found ${unexpected.length} new circular dependency(ies):`);
  for (const cycle of unexpected) {
    console.error("  " + cycle.join(" > ") + " > " + cycle[0]);
  }
  console.error("");
  console.error("If a new cycle is intentional (type-only, no initialization hazard),");
  console.error("add it to ALLOWED in scripts/check-circular.mjs with a comment.");
  process.exit(1);
}

console.log(`[check-circular] OK: ${cycles.length} cycle(s) found, all on the allowlist.`);
