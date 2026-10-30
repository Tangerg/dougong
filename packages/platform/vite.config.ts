import { defineConfig } from "vite";
import dts from "unplugin-dts/vite";
import { runtimeBaseline } from "../../tooling/runtime-baseline.mjs";

export default defineConfig({
  plugins: [
    dts({
      tsconfigPath: "./tsconfig.json",
      entryRoot: "src",
      include: ["src"],
      pathsToAliases: false,
    }),
  ],
  build: {
    target: runtimeBaseline.buildTargets,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      external: ["dougong", "dougong/advanced", "semver", "zod"],
    },
  },
});
