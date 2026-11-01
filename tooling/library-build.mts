import { defineConfig } from "vite";
import generateDeclarations from "unplugin-dts/vite";
import { packageEntrypoints } from "./packages.mjs";
import { runtimeBaseline } from "./runtime-baseline.mjs";

export function libraryBuild(
  manifest: {
    readonly name: string;
    readonly type: string;
    readonly exports: Readonly<Record<string, { readonly types: string; readonly import: string }>>;
    readonly imports?: Readonly<Record<string, unknown>>;
    readonly dependencies?: Readonly<Record<string, string>>;
  },
  programs: Record<string, string> = {},
) {
  const entries = Object.fromEntries(
    packageEntrypoints(manifest).map(({ module }: { module: string }) => {
      if (!module.startsWith("dist/"))
        throw new Error(`${manifest.name}: library outputs must be under dist/`);
      const name = module.slice("dist/".length, -".js".length);
      return [name, `src/${name}.ts`];
    }),
  );
  const dependencies = Object.keys(manifest.dependencies ?? {});
  return defineConfig({
    plugins: [
      generateDeclarations({
        tsconfigPath: "./tsconfig.json",
        entryRoot: "src",
        include: ["src"],
        pathsToAliases: false,
      }),
    ],
    build: {
      target: runtimeBaseline.buildTargets,
      lib: {
        entry: { ...entries, ...programs },
        formats: ["es"],
        fileName: (_format, entry) => `${entry}.js`,
      },
      // A subpath is supplied by the same installed package as its root.
      rollupOptions: {
        // The consumer selects private runtime conditions when it resolves the installed library.
        external: (id) =>
          Object.hasOwn(manifest.imports ?? {}, id) ||
          dependencies.some((name) => id === name || id.startsWith(name + "/")),
      },
    },
  });
}
