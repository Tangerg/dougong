#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, normalizePath } from "vite";
import { runtimeBaseline } from "../runtime-baseline.mjs";
import { candidateOutput, packCandidates, writeVerifiedCandidates } from "./package-candidates.mjs";
import { installConsumerDependencies } from "./install-dependencies.mjs";

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
  const browserEntry = join(workspace, "browser.mjs");
  writeFileSync(
    browserEntry,
    'export { onAbort } from "dougong/advanced";\nexport { observe } from "@dougongjs/reactive";\n',
  );
  // Compile the packed files as a browser consumer, including each package's private resolution conditions.
  const browser = await build({
    configFile: false,
    root: workspace,
    logLevel: "silent",
    build: {
      target: runtimeBaseline.buildTargets,
      write: false,
      lib: { entry: browserEntry, formats: ["es"] },
    },
  });
  const bundledModules = (Array.isArray(browser) ? browser : [browser])
    .flatMap((result) => result.output)
    .filter((file) => file.type === "chunk")
    .flatMap((chunk) => Object.keys(chunk.modules));
  for (const name of ["dougong", "@dougongjs/reactive"]) {
    if (
      !bundledModules.includes(normalizePath(join(modules, name, "runtime/abort-listener.web.mjs")))
    )
      throw new Error(`${name}: browser build did not use its Web abort listener`);
  }
  if (
    bundledModules.some(
      (id) => id.includes("abort-listener.node.mjs") || id.includes("__vite-browser-external"),
    )
  )
    throw new Error("Browser consumer includes a Node-only module");
  if (process.env[candidateOutput])
    writeVerifiedCandidates(process.env[candidateOutput], candidates);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
