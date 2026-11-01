import madge from "madge";
import typescript from "typescript";
import { existsSync } from "node:fs";
import { sourceExtensions } from "./rules.mjs";

export const sourceDirectory = ".";

export function compilerOptions() {
  const source = typescript.readJsonConfigFile("tsconfig.base.json", typescript.sys.readFile);
  const configuration = typescript.parseJsonSourceFileConfigFileContent(
    source,
    typescript.sys,
    process.cwd(),
  );
  if (configuration.errors.length) {
    throw new Error(
      configuration.errors
        .map((error) => typescript.flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n"),
    );
  }
  return configuration.options;
}

export async function analyzeDependencies(options = compilerOptions()) {
  const analysis = await madge(["packages", "examples"].filter(existsSync), {
    baseDir: process.cwd(),
    fileExtensions: sourceExtensions,
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
