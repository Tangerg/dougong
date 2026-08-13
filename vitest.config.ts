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
  },
});
