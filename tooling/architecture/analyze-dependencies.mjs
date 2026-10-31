import madge from "madge";
import ts from "typescript";
import { existsSync } from "node:fs";

export const sourceDirectory = ".";

export function compilerOptions() {
  const source = ts.readJsonConfigFile("tsconfig.base.json", ts.sys.readFile);
  const config = ts.parseJsonSourceFileConfigFileContent(source, ts.sys, process.cwd());
  if (config.errors.length) {
    throw new Error(
      config.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n"),
    );
  }
  return config.options;
}

export async function analyzeDependencies(options = compilerOptions()) {
  const analysis = await madge(["packages", "examples"].filter(existsSync), {
    baseDir: process.cwd(),
    fileExtensions: ["ts"],
    // Madge reparses numeric compiler options as JSON and loses Bundler resolution.
    tsConfig: { options },
    excludeRegExp: ["(^|/)dist/"],
  });
  const { skipped } = analysis.warnings();
  if (skipped.length) {
    throw new Error(`Dependency analysis could not resolve imports:\n${skipped.join("\n")}`);
  }
  return analysis;
}
