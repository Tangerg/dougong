import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  arrangeLayerViolations,
  arrangeValidToolingVocabulary,
  toolingSourceExtensions,
} from "./fixtures/layer-violations.mjs";

const guardTestTimeout = 30000;
vi.setConfig({ testTimeout: guardTestTimeout });

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
        timeout: guardTestTimeout,
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
    const result = runGuard(script, arrangeValidToolingVocabulary);
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

describe("layer violations", () => {
  let output;

  beforeAll(() => {
    const result = runGuard("check-layers.mjs", arrangeLayerViolations);
    if (result.status !== 1)
      throw new Error(
        `Expected the layer guard to reject the fixture (status ${result.status}):\n${result.output}`,
      );
    output = result.output;
  }, guardTestTimeout);

  it("rejects an actual upward layer dependency", () => {
    expect(output).toContain(
      "contracts/direction-probe.ts: [direction.module] forbidden responsibility direction contracts -> execution",
    );
  });

  it("rejects Core depending on a higher package", () => {
    expect(output).toContain(
      "contracts/direction-probe.ts: [direction.package] forbidden package direction dougong -> platform",
    );
  });

  it("requires new implementation directories to declare a responsibility", () => {
    expect(output).toContain(
      "unowned/registry.ts: [ownership.module] module 'unowned' has no declared responsibility",
    );
  });

  it("follows actual Contract factory symbols, including ESM aliases, without treating a shadow as a declaration", () => {
    expect(output).toContain(
      "ownership-probe.ts:6: [contracts.owner] fixed Contract ID 'probe/duplicate'",
    );
    expect(output).not.toContain("fixed Contract ID 'probe/shadow'");
  });

  it("keeps fixed Contract ownership across source files and factory kinds", () => {
    expect(
      output.match(/\[contracts\.owner\] fixed Contract ID 'probe\/across-files'/g),
    ).toHaveLength(1);
  });

  it("applies independent source policies without giving examples the library's ambient restrictions", () => {
    for (const [line, rule] of [
      [1, "modules.esm"],
      [2, "types.precise"],
      [3, "callbacks.readonly"],
      [4, "logging.port"],
      [5, "policy.explicit"],
      [6, "policy.explicit"],
      [7, "policy.explicit"],
    ])
      expect(output).toContain(`policy-probe.ts:${line}: [${rule}]`);
    expect(output.match(/policy-probe\.ts:3: \[callbacks\.readonly\]/g)).toHaveLength(1);
    expect(output).not.toContain("examples/src/ambient-policy.ts:");
  });

  it("keeps compile-only assertions in their dedicated source boundary", () => {
    expect(output).toContain("type-placement-probe.ts:2: [tests.types]");
    expect(output).not.toContain("public-api.types.ts:");
  });

  it("checks import types, re-exports and dynamic imports against the same package boundaries", () => {
    expect(output).toContain("access-probe.ts:1: [exports.public]");
    expect(output).toContain("access-probe.ts:2: [exports.public]");
    expect(output.match(/access-probe\.ts:\d+: \[exports\.public\]/g)).toHaveLength(2);
    expect(output).toContain("access-probe.ts:3: [runtime.portable]");
  });

  it("checks the defining Lifetime constructor, production source roots and readonly callback types", () => {
    expect(output).toContain("owner-probe.ts:3: [lifetime.owner]");
    expect(output.match(/owner-probe\.ts:\d+: \[lifetime\.owner\]/g)).toHaveLength(1);
    expect(output).toContain("owner-probe.ts:6: [ownership.module]");
    expect(output).toContain("owner-probe.ts:8: [callbacks.readonly]");
  });

  it("rejects a private runtime port redirected into non-runtime workspace files", () => {
    expect(output).toContain(
      "packages/reactive/src/abort.ts:2: [ownership.module] runtime source cannot import a non-runtime workspace file: packages/reactive/runtime/undeclared.d.mts",
    );
  });

  it("checks NodeNext TypeScript modules reachable from portable source", () => {
    expect(output).toContain("source.mts:1: [runtime.portable]");
    expect(output).toContain("common.cts:1: [runtime.portable]");
    expect(output).toContain("common.cts:2: [runtime.portable]");
    expect(output).not.toContain("common.cts:5:");
  });

  it("checks project-authored names without treating data and foreign keys as declarations", () => {
    const violations = output.split("\n").filter((line) => line.includes("names.ts:"));
    expect(violations).toHaveLength(5);
    for (const [line, name] of [
      [1, "deps"],
      [2, "#cachedDeps"],
      [3, "ctx"],
      [5, "shutdownTimeoutMs"],
      [6, "fn"],
    ])
      expect(output).toContain(`names.ts:${line}: [vocabulary.current] Declaration '${name}'`);
  });

  it.each(toolingSourceExtensions)("checks tooling declarations in .%s files", (extension) => {
    expect(output).toContain(
      `tooling/commands/arguments.${extension}:1: [vocabulary.current] Declaration 'args'`,
    );
  });

  it("keeps aliases owned by the project even when the original API name belongs to a dependency", () => {
    for (const [line, name] of [
      [1, "args"],
      [2, "cfg"],
      [3, "config"],
      [5, "opts"],
      [6, "args"],
    ])
      expect(output).toContain(
        `tooling/commands/aliases.mjs:${line}: [vocabulary.current] Declaration '${name}'`,
      );
    expect(output).not.toContain("tooling/commands/aliases.mjs:4:");
  });

  it("does not exempt relative imports, project package imports or package-local imports", () => {
    for (const [line, name] of [
      [1, "args"],
      [2, "config"],
      [3, "args"],
      [4, "deps"],
    ])
      expect(output).toContain(
        `tooling/commands/project-imports.mts:${line}: [vocabulary.current] Declaration '${name}'`,
      );
  });

  it("continues rejecting retired domain vocabulary in runtime declarations and re-exports", () => {
    for (const filename of ["retired.ts", "retired-owner.ts"])
      expect(output).toContain(
        `packages/reactive/src/${filename}:1: [vocabulary.current] retired vocabulary 'Runtime'`,
      );
  });

  it("preserves foreign API names, tool-defined keys and unrelated tooling concepts", () => {
    expect(output).not.toContain("tooling/commands/foreign.");
    expect(output).not.toContain("tooling/test/fixtures/vocabulary.mjs");
    const violations = output.split("\n").filter((line) => line.includes("tooling/"));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((line) => line.includes("[vocabulary.current]"))).toBe(true);
  });
});
