/// <reference types="vitest/config" />

import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests import the workspace packages by their published names so the suite
  // exercises the same specifiers a consumer writes, while resolving to source
  // rather than a stale `dist/`. Keep in sync with tsconfig.base.json's paths.
  resolve: {
    alias: {
      "@dougongjs/reactive": fileURLToPath(
        new URL("./packages/reactive/src/index.ts", import.meta.url),
      ),
      "@dougongjs/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@dougongjs/platform": fileURLToPath(
        new URL("./packages/platform/src/index.ts", import.meta.url),
      ),
      dougong: fileURLToPath(new URL("./packages/dougong/src/index.ts", import.meta.url)),
    },
  },

  test: {
    include: ["packages/*/test/**/*.test.ts"],

    // Resource-retention tests need an explicit GC boundary. Forked workers
    // are required because V8 flags cannot be added to an existing thread.
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--expose-gc"],
      },
    },

    // Mocks are per-package listeners and event handlers; leaking one into the
    // next test would show up as a phantom extra call, not as a failure here.
    restoreMocks: true,

    // Type-level coverage is not configured here on purpose: `pnpm typecheck`
    // already runs `tsc --noEmit -p tsconfig.test.json` over the same files
    // under the repo's own strict options, which is the stricter gate of the
    // two. Both live in the `check` chain.
    coverage: {
      enabled: true,
      provider: "istanbul",
      include: ["packages/*/src/**"],
      // Thresholds follow the measured package floors. A package cannot hide a
      // regression behind stronger coverage elsewhere in the workspace.
      thresholds: {
        "packages/core/src/**": { statements: 92, functions: 96, branches: 83, lines: 95 },
        "packages/platform/src/**": {
          statements: 97,
          functions: 100,
          branches: 90,
          lines: 98,
        },
        "packages/reactive/src/**": { statements: 95, functions: 100, branches: 87, lines: 98 },
      },
    },
  },
});
