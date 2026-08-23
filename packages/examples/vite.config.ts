import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { runtimeBaseline } from "../../scripts/runtime-baseline.mjs";

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
      entry: {
        index: "src/index.ts",
        run: "src/run.ts",
        benchmark: "src/benchmark.ts",
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: ["dougong"],
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});
