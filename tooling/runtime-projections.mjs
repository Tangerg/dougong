import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { publishedDirectories } from "./packages.mjs";
import { runtimeBaseline } from "./runtime-baseline.mjs";

const runtimeDocumentPaths = [
  "README.md",
  "README.en.md",
  "docs/guide/getting-started.md",
  "docs/en/guide/getting-started.md",
  "docs/guide/migrating-to-0.9.md",
  "docs/en/guide/migrating-to-0.9.md",
  "docs/guide/migrating-to-0.10.md",
  "docs/en/guide/migrating-to-0.10.md",
  "packages/dougong/README.md",
  "packages/reactive/README.md",
];
const projectionName = "runtime-baseline";
const openingMarker = `<!-- ${projectionName}:start -->`;
const closingMarker = `<!-- ${projectionName}:end -->`;
const runtimeDescription = [
  `Node.js \`${runtimeBaseline.engines.node}\``,
  ...runtimeBaseline.browserslist.map((target) => target.replace(" >= ", " ≥ ")),
].join(", ");

export function runtimeProjectionChanges(root) {
  const changes = [];
  const capture = (path, project) => {
    const url = new URL(path, root);
    const current = readFileSync(url, "utf8");
    const generated = project(current);
    if (current !== generated) changes.push({ path, url, generated });
  };
  for (const directory of [".", ...publishedDirectories, "examples"]) {
    capture(`${directory}/package.json`, (source) => {
      const manifest = JSON.parse(source);
      manifest.engines = runtimeBaseline.engines;
      if (directory !== "examples") manifest.browserslist = runtimeBaseline.browserslist;
      return `${JSON.stringify(manifest, null, 2)}\n`;
    });
  }
  for (const path of runtimeDocumentPaths) {
    capture(path, (source) => {
      const opening = source.indexOf(openingMarker);
      const closing = source.indexOf(closingMarker);
      if (
        opening < 0 ||
        closing < opening ||
        source.indexOf(openingMarker, opening + openingMarker.length) !== -1 ||
        source.indexOf(closingMarker, closing + closingMarker.length) !== -1
      )
        throw new Error(
          `${fileURLToPath(new URL(path, root))}: expected one ${projectionName} region`,
        );
      return (
        source.slice(0, opening + openingMarker.length) + runtimeDescription + source.slice(closing)
      );
    });
  }
  return changes;
}
