export const publishedDirectories = Object.freeze([
  "packages/reactive",
  "packages/dougong",
  "packages/platform",
]);

function isLiteralPackagePath(path) {
  return (
    typeof path === "string" &&
    path.startsWith("./") &&
    !/[\\*%?#]/.test(path) &&
    path
      .slice(2)
      .split("/")
      .every((part) => part && part !== "." && part !== "..")
  );
}

// API inspection and release must visit every package target a supported resolver can select.
export function packageEntrypoints(manifest) {
  if (manifest.type !== "module")
    throw new Error(`${manifest.name}: ESM packages must declare type module`);
  if (!manifest.exports || !Object.hasOwn(manifest.exports, ".")) {
    throw new Error(`${manifest.name}: missing root package export`);
  }
  return Object.entries(manifest.exports).map(([subpath, entry]) => {
    if (subpath !== "." && !isLiteralPackagePath(subpath)) {
      throw new Error(`${manifest.name}: invalid public subpath '${subpath}'`);
    }
    const specifier = subpath === "." ? manifest.name : manifest.name + subpath.slice(1);
    const conditions = Object.keys(entry ?? {});
    if (conditions.length !== 2 || conditions[0] !== "types" || conditions[1] !== "import") {
      throw new Error(
        `${specifier} must declare exactly the ordered export conditions 'types', 'import'`,
      );
    }
    const target = (path, extension) => {
      if (!isLiteralPackagePath(path) || !path.endsWith(extension))
        throw new Error(`${specifier} requires a package-relative ${extension} target`);
      return path.slice(2);
    };
    return { specifier, types: target(entry.types, ".d.ts"), module: target(entry.import, ".js") };
  });
}
