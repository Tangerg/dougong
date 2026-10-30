#!/usr/bin/env node

import { analyzeDependencies } from "./analyze-dependencies.mjs";

const cycles = (await analyzeDependencies()).circular();
if (cycles.length) {
  console.error(`[check-circular] Found ${cycles.length} circular dependency(ies):`);
  for (const cycle of cycles) console.error(`  ${[...cycle, cycle[0]].join(" > ")}`);
  console.error(
    "Move the shared protocol to its owning lower responsibility before adding the dependency.",
  );
  process.exit(1);
}
console.log("[check-circular] OK: 0 cycles; responsibility dependencies are acyclic.");
