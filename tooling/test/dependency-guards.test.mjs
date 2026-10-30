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
