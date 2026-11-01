import { resolve } from "node:path";
import ts from "typescript";

export function declarationSurface(distPath) {
  const file = resolve(distPath);
  const program = ts.createProgram([file], {
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`Cannot read ${distPath}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`${distPath} is not a module`);

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
