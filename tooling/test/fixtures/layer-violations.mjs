import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const toolingSourceExtensions = ["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"];

const validTooling = {
  "tooling/commands/foreign.mjs": [
    'import { parseArgs } from "node:util";',
    'import { defineConfig } from "vite";',
    'const parsed = parseArgs({ args: [], options: { config: { type: "string" } } });',
    "export const configuration = defineConfig({ build: { outDir: parsed.values.config } });",
    'export { parseArgs } from "node:util";',
    'export { loadConfigFromFile } from "vite";',
    'export const commandArguments = ["Runtime", "Extension", "args"];',
    'const extension = ".mjs";',
    'export const filename = "command" + extension;',
  ],
  "tooling/commands/foreign.mts": [
    'import type { UserConfig } from "vite";',
    'import { parseArgs as parseArguments } from "node:util";',
    'export const configuration: UserConfig = { build: { outDir: "dist" } };',
    "export const parsed = parseArguments({ args: [] });",
  ],
  "tooling/test/fixtures/vocabulary.mjs": ["export const args = [];", "export class Runtime {}"],
};

// Distinct files let one compiler graph exercise independent violations and their legal lookalikes.
const files = {
  "packages/dougong/src/contracts/direction-probe.ts": [
    'import "../execution/host.js";',
    'import "@dougongjs/platform";',
  ],
  "packages/dougong/src/unowned/registry.ts": ["export const value = 1;"],
  "packages/dougong/src/composition/ownership-probe.ts": [
    'import { service as declare } from "../contracts/contracts.js";',
    'import * as contract from "../contracts/contracts.js";',
    'export const first = declare("probe/duplicate");',
    "const emit = contract.event;",
    'const ids = { conflict: "probe/duplicate" } as const;',
    "export const second = emit(ids.conflict);",
    'export function unrelated(declare: (id: string) => string) { return declare("probe/shadow"); }',
    'export const actual = declare("probe/shadow");',
  ],
  "packages/platform/src/activation/access-probe.ts": [
    'export type Hidden = import("../../../dougong/src/execution/engine.js").Engine;',
    'export { Engine } from "../../../dougong/src/execution/engine.js";',
    'export const load = () => import("fs");',
  ],
  "packages/dougong/test/helper.ts": ["export type Helper = string;"],
  "packages/dougong/src/composition/owner-probe.ts": [
    'import { Lifetime as Scope } from "../lifetime/lifetime.js";',
    "const Alias = Scope;",
    'export const invalid = () => new Alias({ label: "orphan" });',
    "class Lifetime {}",
    "export const unrelated = new Lifetime();",
    'export type TestHelper = import("../../test/helper.js").Helper;',
    "type Notify = () => void;",
    "interface ProbePort { notify?: Notify; readonly receive: Notify; count: number }",
  ],
  "packages/reactive/src/source.mts": ['export { readFile as read } from "node:fs";'],
  "packages/reactive/src/common.cts": [
    'import fs = require("node:fs");',
    'const path = require("node:path");',
    "export const read = fs.readFile;",
    "export const separator = path.sep;",
    'export function local(require: (id: string) => string) { return require("node:os"); }',
  ],
  "packages/reactive/src/names.ts": [
    'export interface Options { readonly ["deps"]: string }',
    "export class Owner { #cachedDeps = 0 }",
    "export function read(ctx: Record<string, string>) {",
    "  const { deps: dependencies } = ctx;",
    "  const shutdownTimeoutMs = 5;",
    "  const fn = () => ctx.fn;",
    '  return [ctx.deps, dependencies, "deps", fn(), import.meta.url, ctx.config, ctx.publishConfig, shutdownTimeoutMs];',
    "}",
  ],
  "packages/reactive/src/retired.ts": ['export { Runtime } from "./retired-owner.js";'],
  "packages/reactive/src/retired-owner.ts": ["export class Runtime {}"],
  "tooling/commands/aliases.mjs": [
    'import { parseArgs as args } from "node:util";',
    'import * as cfg from "node:util";',
    'import config from "node:fs";',
    'import { args as commandArguments } from "./arguments.mjs";',
    'export { parseArgs as opts } from "node:util";',
    'export { args } from "./arguments.mjs";',
  ],
  "tooling/commands/project-imports.mts": [
    'import { args } from "./arguments.mjs";',
    'import { config } from "dougong";',
    'export { args } from "dougong/advanced";',
    'import { deps } from "#project";',
  ],
};

function writeSources(workspace, sources) {
  for (const [relativePath, lines] of Object.entries(sources)) {
    const file = join(workspace, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, lines.join("\n") + "\n");
  }
}

export function arrangeValidToolingVocabulary(workspace) {
  writeSources(workspace, validTooling);
}

export function arrangeLayerViolations(workspace) {
  writeSources(workspace, files);
  arrangeValidToolingVocabulary(workspace);
  for (const extension of toolingSourceExtensions)
    writeFileSync(
      join(workspace, `tooling/commands/arguments.${extension}`),
      "export const args = [];\n",
    );
  const reactive = join(workspace, "packages/reactive");
  appendFileSync(
    join(reactive, "src/index.ts"),
    '\nexport { read } from "./source.mjs";\nexport { separator } from "./common.cjs";\n',
  );
  const manifestFile = join(reactive, "package.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.imports["#abort-listener"].types = "./runtime/undeclared.d.mts";
  writeFileSync(manifestFile, JSON.stringify(manifest));
  copyFileSync(
    join(reactive, "runtime/abort-listener.d.mts"),
    join(reactive, "runtime/undeclared.d.mts"),
  );
}
