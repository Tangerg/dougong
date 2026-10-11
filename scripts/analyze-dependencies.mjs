import madge from "madge";

export const packagesDirectory = "packages";

export async function analyzeDependencies() {
  const analysis = await madge(packagesDirectory, {
    fileExtensions: ["ts"],
    tsConfig: "tsconfig.base.json",
    excludeRegExp: ["(^|/)dist/"],
  });
  const { skipped } = analysis.warnings();
  if (skipped.length) {
    throw new Error(`Dependency analysis could not resolve imports:\n${skipped.join("\n")}`);
  }
  return analysis;
}
