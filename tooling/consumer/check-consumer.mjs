#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { x } from "tar";
import { publishedDirectories } from "../packages.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "dougong-packed-consumer-"));
const modules = join(workspace, "node_modules");
const unpacked = new Set();
const published = new Map(
  publishedDirectories.map((directory) => {
    const path = join(root, directory);
    return [JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name, path];
  }),
);

function installedDependency(from, name) {
  let directory = realpathSync(from);
  while (true) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`Cannot resolve production dependency '${name}' from ${from}`);
    directory = parent;
  }
}

function copyDependency(source) {
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (published.has(manifest.name) || unpacked.has(manifest.name)) return;
  unpacked.add(manifest.name);
  const target = join(modules, manifest.name);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !path.slice(source.length).split(/[\\/]/).includes("node_modules"),
  });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    copyDependency(installedDependency(source, dependency));
  }
}

try {
  mkdirSync(modules);
  for (const [name, directory] of published) {
    const destination = join(workspace, "archives", name.replaceAll("/", "-"));
    mkdirSync(destination, { recursive: true });
    execFileSync("pnpm", ["pack", "--pack-destination", destination], {
      cwd: directory,
      stdio: "pipe",
    });
    const archives = readdirSync(destination).filter((file) => file.endsWith(".tgz"));
    if (archives.length !== 1)
      throw new Error(`Packing ${name} produced ${archives.length} archives`);
    const target = join(modules, name);
    mkdirSync(target, { recursive: true });
    await x({ file: join(destination, archives[0]), cwd: target, strip: 1 });
    const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!published.has(dependency)) copyDependency(installedDependency(directory, dependency));
    }
  }
  // An actual second installed copy gives a different module-local dependency collector.
  cpSync(join(modules, "@dougongjs/reactive"), join(modules, "@fixture/reactive-copy"), {
    recursive: true,
  });
  cpSync(new URL("./application.mts", import.meta.url), join(workspace, "application.mts"));
  cpSync(
    new URL("./fallback-disposal.mjs", import.meta.url),
    join(workspace, "fallback-disposal.mjs"),
  );
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ name: "isolated-consumer", private: true, type: "module" }),
  );
  writeFileSync(
    join(workspace, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: false,
        lib: ["ES2024", "DOM", "ESNext.Disposable"],
        outDir: "output",
        types: [],
      },
      include: ["application.mts"],
    }),
  );
  execFileSync(
    process.execPath,
    [resolve(root, "node_modules/typescript/bin/tsc"), "-p", workspace],
    { cwd: workspace, stdio: "inherit" },
  );
  for (const fixture of ["output/application.mjs", "fallback-disposal.mjs"]) {
    execFileSync(process.execPath, [join(workspace, fixture)], {
      cwd: workspace,
      stdio: "inherit",
    });
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
