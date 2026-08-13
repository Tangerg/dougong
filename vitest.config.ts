/// <reference types="vitest/config" />

import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests import the workspace packages by their published names so the suite
  // exercises the same specifiers a consumer writes, while resolving to source
  // rather than a stale `dist/`. Keep in sync with tsconfig.base.json's paths.
  resolve: {
    alias: {
      "@dougong/reactive": fileURLToPath(
        new URL("./packages/reactive/src/index.ts", import.meta.url),
      ),
      "@dougong/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      dougong: fileURLToPath(new URL("./packages/dougong/src/index.ts", import.meta.url)),
    },
  },

  test: {
    include: ["packages/*/test/**/*.test.ts"],

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
      // Thresholds are pinned to the suite's measured coverage, per package, so
      // a regression fails rather than quietly averaging out against the other
      // package. Raise them when coverage improves; lowering one is a decision
      // that should show up in review.
      thresholds: {
        "packages/core/src/**": { statements: 84, functions: 85, branches: 72, lines: 88 },
        "packages/reactive/src/**": { statements: 92, functions: 100, branches: 75, lines: 96 },
      },
    },
  },
});
