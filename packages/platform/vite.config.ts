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
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      external: ["@dougong/core", "compare-versions", "zod"],
    },
  },
});
