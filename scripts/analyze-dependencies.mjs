import madge from "madge";
import ts from "typescript";

export const packagesDirectory = "packages";

export async function analyzeDependencies() {
  const source = ts.readJsonConfigFile("tsconfig.base.json", ts.sys.readFile);
  const config = ts.parseJsonSourceFileConfigFileContent(source, ts.sys, process.cwd());
  if (config.errors.length) {
    throw new Error(
      config.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n"),
    );
  }
  const analysis = await madge(packagesDirectory, {
    fileExtensions: ["ts"],
    // Madge reparses numeric compiler options as JSON and loses Bundler resolution.
    tsConfig: { options: config.options },
    excludeRegExp: ["(^|/)dist/"],
  });
  const { skipped } = analysis.warnings();
  if (skipped.length) {
    throw new Error(`Dependency analysis could not resolve imports:\n${skipped.join("\n")}`);
  }
  return analysis;
}
