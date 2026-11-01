import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import { packageName } from "../packages.mjs";

function installedDependency(from, name) {
  let directory = from;
  while (true) {
    const candidate = join(directory, "node_modules", name);
    if (basename(directory) !== "node_modules" && existsSync(join(candidate, "package.json")))
      return realpathSync(candidate);
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

// Seed the graph with the inspected tarballs; every other physical package gets exactly one private copy.
export function installConsumerDependencies(packed, store) {
  const copies = new Map([...packed].map(([source, target]) => [realpathSync(source), target]));
  for (const [source, target] of copies) {
    const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    const names = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const name of names) {
      packageName(name);
      const installed = installedDependency(source, name);
      if (!installed) {
        if (
          Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
          (manifest.peerDependenciesMeta?.[name]?.optional &&
            !Object.hasOwn(manifest.dependencies ?? {}, name))
        )
          continue;
        throw new Error(`Cannot resolve production dependency '${name}' from ${source}`);
      }
      let copy = copies.get(installed);
      if (!copy) {
        copy = join(store, String(copies.size));
        copies.set(installed, copy);
        cpSync(installed, copy, {
          recursive: true,
          filter: (file) => {
            if (relative(installed, file).split(sep).includes("node_modules")) return false;
            if (lstatSync(file).isSymbolicLink())
              throw new Error(`Unexpected symlink inside installed package: ${file}`);
            return true;
          },
        });
      }
      // The dependency key is the resolver's name; an npm alias need not equal the target manifest name.
      const link = join(target, "node_modules", name);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(copy, link, "junction");
    }
  }
}
