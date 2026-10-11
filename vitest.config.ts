/// <reference types="vitest/config" />

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfig from "./tsconfig.base.json";

const sourceRoot = fileURLToPath(new URL("./", import.meta.url));
const aliases = Object.fromEntries(
  Object.entries(tsconfig.compilerOptions.paths).map(([specifier, targets]) => {
    const [target] = targets;
    if (
      specifier.includes("*") ||
      targets.length !== 1 ||
      typeof target !== "string" ||
      target.includes("*")
    ) {
      throw new TypeError("Workspace test paths must have an exact specifier and one exact target");
    }
    return [specifier, resolve(sourceRoot, tsconfig.compilerOptions.baseUrl, target)];
  }),
);

export default defineConfig({
  // Resolve through TypeScript paths so tests cannot drift to stale dist artifacts.
  resolve: {
    alias: aliases,
  },

  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/test/**/*.test.mjs"],

    // V8 flags require forked workers for the GC boundary used by retention tests.
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--expose-gc"],
      },
    },

    restoreMocks: true,

    coverage: {
      enabled: true,
      provider: "istanbul",
      include: ["packages/*/src/**"],
      // Package floors prevent one layer from masking another layer's coverage regression.
      thresholds: {
        "packages/core/src/**": { statements: 93, functions: 96, branches: 86, lines: 96 },
        "packages/platform/src/**": {
          statements: 97,
          functions: 100,
          branches: 92,
          lines: 99,
        },
        "packages/reactive/src/**": { statements: 96, functions: 100, branches: 89, lines: 99 },
      },
    },
  },
});
