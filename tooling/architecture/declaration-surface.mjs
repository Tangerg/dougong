import { resolve } from "node:path";
import typescript from "typescript";

export function declarationSurface(declarationPath) {
  const file = resolve(declarationPath);
  const program = typescript.createProgram([file], {
    noEmit: true,
    skipLibCheck: true,
    target: typescript.ScriptTarget.ES2022,
    module: typescript.ModuleKind.ESNext,
    moduleResolution: typescript.ModuleResolutionKind.Bundler,
    strict: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`Cannot read ${declarationPath}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`${declarationPath} is not a module`);

  // The namespace type excludes type-only re-exports, including aliases of runtime classes.
  const values = new Set(
    checker
      .getTypeOfSymbolAtLocation(moduleSymbol, source)
      .getProperties()
      .map((symbol) => symbol.name),
  );
  const names = checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name);
  return { values: [...values].sort(), types: names.filter((name) => !values.has(name)).sort() };
}
