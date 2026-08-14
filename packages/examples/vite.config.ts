import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

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
    target: "es2024",
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
