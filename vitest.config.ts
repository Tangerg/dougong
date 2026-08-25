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

    // Compile-only `public-api.types.ts` files are intentionally outside this
    // runtime pattern. `pnpm typecheck` checks every file under `test/` with
    // the repository's strict options; both gates live in the `check` chain.
    coverage: {
      enabled: true,
      provider: "istanbul",
      include: ["packages/*/src/**"],
      // Thresholds follow the measured package floors. A package cannot hide a
      // regression behind stronger coverage elsewhere in the workspace.
      //
      // They are floors, not targets. The remaining gap in each package is
      // defence-in-depth behind an earlier check — a `GroupNode.assertAttached()`
      // that the GroupCoordinator has already refused, a `SERVICE_CYCLE` for a
      // self-dependency that `definePlugin` rejects first. Reaching those lines
      // would mean bypassing the public API, so raising the numbers further
      // would buy assertions about unreachable states rather than behaviour.
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
