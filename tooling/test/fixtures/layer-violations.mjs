import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
};

export function arrangeLayerViolations(workspace) {
  for (const [relativePath, lines] of Object.entries(files)) {
    const file = join(workspace, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, lines.join("\n") + "\n");
  }
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
