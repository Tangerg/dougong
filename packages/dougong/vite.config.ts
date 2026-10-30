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
      entry: { index: "src/index.ts", advanced: "src/advanced.ts" },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
  },
});
