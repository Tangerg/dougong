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
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
  },
});
