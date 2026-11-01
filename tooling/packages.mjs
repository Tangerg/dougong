export const publishedDirectories = Object.freeze([
  "packages/reactive",
  "packages/dougong",
  "packages/platform",
]);

export const abortListenerPort = Object.freeze({
  specifier: "#abort-listener",
  packages: Object.freeze(["dougong", "reactive"]),
  targets: Object.freeze({
    types: "./runtime/abort-listener.d.mts",
    node: "./runtime/abort-listener.node.mjs",
    default: "./runtime/abort-listener.web.mjs",
  }),
});

// A package specifier is also a relative node_modules path; scoped names own exactly two components.
export function packageName(name) {
  if (typeof name !== "string" || !name || name.trim() !== name)
    throw new Error("Expected a non-empty trimmed package name");
  const parts = name.split("/");
  if (
    parts.length !== (name.startsWith("@") ? 2 : 1) ||
    parts[0] === "@" ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\\:]/.test(part) ||
        part.toLowerCase() === "node_modules",
    )
  )
    throw new Error(`Invalid package name: ${name}`);
  return name;
}

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
      if (
        !isLiteralPackagePath(path) ||
        path.split("/").some((part) => part.toLowerCase() === "node_modules") ||
        !path.endsWith(extension)
      )
        throw new Error(`${specifier} requires a package-relative ${extension} target`);
      return path.slice(2);
    };
    return { specifier, types: target(entry.types, ".d.ts"), module: target(entry.import, ".js") };
  });
}
