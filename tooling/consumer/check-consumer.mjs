#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, normalizePath } from "vite";
import { runtimeBaseline } from "../runtime-baseline.mjs";
import { abortListenerPort } from "../packages.mjs";
import { candidateOutput, packCandidates, writeVerifiedCandidates } from "./package-candidates.mjs";
import { installConsumerDependencies } from "./install-dependencies.mjs";
import { verifyBrowserBundle } from "./browser-runner.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "dougong-packed-consumer-"));
const modules = join(workspace, "node_modules");
const packed = new Map();
try {
  mkdirSync(modules);
  const candidates = packCandidates(root);
  for (const { name, source, files } of candidates.values()) {
    const target = join(modules, name);
    for (const [file, bytes] of files) {
      const path = join(target, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes, { flag: "wx" });
    }
    packed.set(source, target);
  }
  installConsumerDependencies(packed, join(workspace, "dependencies"));
  // An actual second installed copy gives a different module-local dependency collector.
  cpSync(join(modules, "@dougongjs/reactive"), join(modules, "@fixture/reactive-copy"), {
    recursive: true,
  });
  for (const fixture of [
    "application.mts",
    "browser.mts",
    "fallback-disposal.mjs",
    "mask-native-disposal.mjs",
  ])
    cpSync(new URL(fixture, import.meta.url), join(workspace, fixture));
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
      include: ["application.mts", "browser.mts"],
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
  // Compile the packed files as a browser consumer, including each package's private resolution conditions.
  const browser = await build({
    configFile: false,
    root: workspace,
    logLevel: "silent",
    build: {
      target: runtimeBaseline.buildTargets,
      write: false,
      lib: { entry: join(workspace, "browser.mts"), formats: ["es"] },
    },
  });
  const output = (Array.isArray(browser) ? browser : [browser]).flatMap((result) => result.output);
  const bundledModules = output
    .filter((file) => file.type === "chunk")
    .flatMap((chunk) => Object.keys(chunk.modules));
  for (const name of abortListenerPort.packages) {
    const installed = packed.get(resolve(root, "packages", name));
    if (
      !installed ||
      !bundledModules.includes(normalizePath(join(installed, abortListenerPort.targets.default)))
    )
      throw new Error(`${name}: browser build did not use its public cancellation protocol`);
  }
  if (bundledModules.some((id) => id.includes("__vite-browser-external")))
    throw new Error("Browser consumer includes a Node-only module");
  await verifyBrowserBundle(output);
  if (process.env[candidateOutput])
    writeVerifiedCandidates(process.env[candidateOutput], candidates);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
