import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30000 });

const repository = fileURLToPath(new URL("../../", import.meta.url));

function runGuard(script, arrange = () => undefined) {
  const workspace = mkdtempSync(join(tmpdir(), "dougong-dependency-guard-test-"));
  try {
    for (const name of ["dougong", "platform", "reactive"]) {
      const directory = join(workspace, "packages", name);
      mkdirSync(directory, { recursive: true });
      cpSync(join(repository, "packages", name, "src"), join(directory, "src"), {
        recursive: true,
      });
      const runtime = join(repository, "packages", name, "runtime");
      if (existsSync(runtime)) cpSync(runtime, join(directory, "runtime"), { recursive: true });
      copyFileSync(
        join(repository, "packages", name, "package.json"),
        join(directory, "package.json"),
      );
      const dependencies = join(repository, "packages", name, "node_modules");
      if (existsSync(dependencies)) {
        symlinkSync(dependencies, join(directory, "node_modules"), "dir");
      }
    }
    for (const file of ["package.json", "tsconfig.base.json"]) {
      copyFileSync(join(repository, file), join(workspace, file));
    }
    symlinkSync(join(repository, "node_modules"), join(workspace, "node_modules"), "dir");
    arrange(workspace);
    const result = spawnSync(
      process.execPath,
      [join(repository, "tooling", "architecture", script)],
      {
        cwd: workspace,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    if (result.error) throw result.error;
    return { ...result, output: result.stdout + result.stderr };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

it.each(["check-circular.mjs", "check-layers.mjs"])(
  "%s rejects a graph with an unresolved import",
  (script) => {
    const result = runGuard(script, (workspace) => {
      appendFileSync(
        join(workspace, "packages/dougong/src/contracts/contracts.ts"),
        '\nimport "./missing-dependency";\n',
      );
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("missing-dependency");
    expect(result.output).not.toContain("OK:");
  },
);

it.each(["check-circular.mjs", "check-layers.mjs"])(
  "%s accepts the complete valid source graph",
  (script) => {
    const result = runGuard(script);
    expect(result).toMatchObject({ status: 0, output: expect.stringContaining("OK:") });
  },
);

it("rejects an actual dependency cycle", () => {
  const result = runGuard("check-circular.mjs", (workspace) => {
    const directory = join(workspace, "packages/reactive/src");
    writeFileSync(join(directory, "cycle-a.ts"), 'import "./cycle-b";\nexport const a = 1;\n');
    writeFileSync(join(directory, "cycle-b.ts"), 'import "./cycle-a";\nexport const b = 1;\n');
  });
  expect(result.status).toBe(1);
  expect(result.output).toContain("circular dependency");
  expect(result.output).toContain("cycle-a.ts");
});

it("rejects an actual upward layer dependency", () => {
  const result = runGuard("check-layers.mjs", (workspace) => {
    appendFileSync(
      join(workspace, "packages/dougong/src/contracts/contracts.ts"),
      '\nimport "../execution/host";\n',
    );
  });
  expect(result.status).toBe(1);
  expect(result.output).toContain("contracts -> execution");
});

it("rejects core depending on a higher package", () => {
  const result = runGuard("check-layers.mjs", (workspace) => {
    appendFileSync(
      join(workspace, "packages/dougong/src/contracts/contracts.ts"),
      '\nimport "@dougongjs/platform";\n',
    );
  });
  expect(result.status).toBe(1);
  expect(result.output).toContain("dougong -> platform");
});

it("requires new implementation directories to declare a responsibility", () => {
  const result = runGuard("check-layers.mjs", (workspace) => {
    const directory = join(workspace, "packages/dougong/src/unowned");
    mkdirSync(directory);
    writeFileSync(join(directory, "registry.ts"), "export const value = 1;\n");
  });
  expect(result.status).toBe(1);
  expect(result.output).toContain("no declared responsibility");
});

it("follows actual Contract factory symbols, including ESM aliases, without treating a shadow as a declaration", () => {
  const result = runGuard("check-layers.mjs", (workspace) => {
    writeFileSync(
      join(workspace, "packages/dougong/src/composition/ownership-probe.ts"),
      [
        'import { service as declare } from "../contracts/contracts.js";',
        'import * as contract from "../contracts/contracts.js";',
        'export const first = declare("probe/duplicate");',
        "const emit = contract.event;",
        'const ids = { conflict: "probe/duplicate" } as const;',
        "export const second = emit(ids.conflict);",
        'export function unrelated(declare: (id: string) => string) { return declare("probe/shadow"); }',
        'export const actual = declare("probe/shadow");',
      ].join("\n"),
    );
  });
  expect(result.status).toBe(1);
  expect(result.output).toContain("fixed Contract ID 'probe/duplicate'");
  expect(result.output).not.toContain("fixed Contract ID 'probe/shadow'");
});

it("checks import types, re-exports and dynamic imports against the same package boundaries", () => {
  const result = runGuard("check-layers.mjs", (workspace) => {
    writeFileSync(
      join(workspace, "packages/platform/src/activation/access-probe.ts"),
      [
        'export type Hidden = import("../../../dougong/src/execution/engine.js").Engine;',
        'export { Engine } from "../../../dougong/src/execution/engine.js";',
        'export const load = () => import("fs");',
      ].join("\n"),
    );
  });
  expect(result.status).toBe(1);
  expect(result.output.match(/\[exports.public\]/g)).toHaveLength(2);
  expect(result.output).toContain("[runtime.portable]");
});

it("checks the defining Lifetime constructor, production source roots and readonly callback types", () => {
  const result = runGuard("check-layers.mjs", (workspace) => {
    const directory = join(workspace, "packages/dougong");
    mkdirSync(join(directory, "test"));
    writeFileSync(join(directory, "test/helper.ts"), "export type Helper = string;\n");
    writeFileSync(
      join(directory, "src/composition/owner-probe.ts"),
      [
        'import { Lifetime as Scope } from "../lifetime/lifetime.js";',
        "const Alias = Scope;",
        'export const invalid = () => new Alias({ label: "orphan" });',
        "class Lifetime {}",
        "export const unrelated = new Lifetime();",
        'export type TestHelper = import("../../test/helper.js").Helper;',
        "type Notify = () => void;",
        "interface ProbePort { notify?: Notify; readonly receive: Notify; count: number }",
      ].join("\n"),
    );
  });
  expect(result.status).toBe(1);
  expect(result.output).toContain("owner-probe.ts:3: [lifetime.owner]");
  expect(result.output.match(/\[lifetime.owner\]/g)).toHaveLength(1);
  expect(result.output).toContain("owner-probe.ts:6: [ownership.module]");
  expect(result.output).toContain("owner-probe.ts:8: [callbacks.readonly]");
});

it("rejects a private runtime port redirected into non-runtime workspace files", () => {
  const result = runGuard("check-layers.mjs", (workspace) => {
    const root = join(workspace, "packages", "reactive");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    manifest.imports["#abort-listener"].types = "./runtime/undeclared.d.mts";
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    copyFileSync(
      join(root, "runtime/abort-listener.d.mts"),
      join(root, "runtime/undeclared.d.mts"),
    );
  });
  expect(result.status).toBe(1);
  expect(result.output).toContain("[ownership.module]");
  expect(result.output).toContain("runtime/undeclared.d.mts");
});

it("checks NodeNext TypeScript modules reachable from portable source", () => {
  const result = runGuard("check-layers.mjs", (workspace) => {
    const directory = join(workspace, "packages/reactive/src");
    appendFileSync(join(directory, "index.ts"), '\nexport { read } from "./source.mjs";\n');
    writeFileSync(join(directory, "source.mts"), 'export { readFile as read } from "node:fs";\n');
  });
  expect(result.status).toBe(1);
  expect(result.output).toContain("source.mts:1: [runtime.portable]");
});

it("checks project-authored names without treating data and foreign keys as declarations", () => {
  const result = runGuard("check-layers.mjs", (workspace) => {
    writeFileSync(
      join(workspace, "packages/reactive/src/names.ts"),
      [
        'export interface Options { readonly ["deps"]: string }',
        "export class Owner { #cachedDeps = 0 }",
        "export function read(ctx: Record<string, string>) {",
        "  const { deps: dependencies } = ctx;",
        "  const shutdownTimeoutMs = 5;",
        "  const fn = () => ctx.fn;",
        '  return [ctx.deps, dependencies, "deps", fn(), import.meta.url, ctx.config, ctx.publishConfig, shutdownTimeoutMs];',
        "}",
      ].join("\n"),
    );
  });
  const violations = result.output.split("\n").filter((line) => line.includes("names.ts:"));
  expect(violations).toHaveLength(5);
  expect(violations.join("\n")).toContain("Declaration 'deps'");
  expect(violations.join("\n")).toContain("Declaration '#cachedDeps'");
  expect(violations.join("\n")).toContain("Declaration 'ctx'");
  expect(violations.join("\n")).toContain("Declaration 'fn'");
  expect(violations.join("\n")).toContain("Declaration 'shutdownTimeoutMs'");
  expect(result.status).toBe(1);
});
