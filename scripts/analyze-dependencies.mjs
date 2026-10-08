import madge from "madge";

export const packagesDirectory = "packages";

/** Owns both guards' scan configuration and rejects unresolved dependency edges. */
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
